"""Tool proxy tests. HTTP is in-process; nothing is opened outside the repo."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from support import FakeClient, client, commands, make_plane, runtime, settings_mod, tools
from support import bundle as bundle_mod


def _loads(raw):
    return json.loads(raw)


class ToolProxyTest(unittest.TestCase):
    def test_list_events_hits_the_control_plane_route(self):
        fake = FakeClient(routes={("GET", "/events"): [{"id": "evt-1", "signatureStatus": "verified"}]})
        raw = tools.list_events(make_plane(fake), {})
        self.assertEqual(_loads(raw)[0]["id"], "evt-1")
        self.assertEqual(fake.calls, [("GET", "/events", None)])

    def test_emit_event_posts_the_mcp_body(self):
        fake = FakeClient(routes={("POST", "/events"): {"accepted": True}})
        raw = tools.emit_event(
            make_plane(fake),
            {"topic": "check_run", "payload": {"conclusion": "failure"}},
        )
        self.assertEqual(_loads(raw)["accepted"], True)
        method, path, body = fake.calls[0]
        self.assertEqual((method, path), ("POST", "/events"))
        self.assertEqual(body["provider"], "custom")
        self.assertEqual(body["workspaceId"], "demo-workspace")
        self.assertEqual(body["payload"]["conclusion"], "failure")

    def test_query_memory_encodes_the_query(self):
        fake = FakeClient(routes={("GET", "/memory"): []})
        tools.query_memory(make_plane(fake), {"query": "ci failure"})
        self.assertEqual(fake.calls[0][0], "GET")
        self.assertIn("q=ci+failure", fake.calls[0][1])

    def test_spawn_and_approvals_use_the_existing_routes(self):
        workflow = "11111111-1111-1111-1111-111111111111"
        event = "22222222-2222-2222-2222-222222222222"
        action = "33333333-3333-3333-3333-333333333333"
        forge = "44444444-4444-4444-4444-444444444444"
        fake = FakeClient()
        plane = make_plane(fake)
        tools.spawn_subagent(plane, {"workflowId": workflow, "eventId": event})
        tools.approve_action(plane, {"actionId": action, "approved": False})
        tools.forge_mcp(plane, {"prompt": "Create a safe status connector"})
        tools.approve_forge(plane, {"forgeId": forge, "approved": True})
        self.assertEqual(fake.calls[0][1], "/agent-runs")
        self.assertEqual(fake.calls[1][1], f"/actions/{action}/decision")
        self.assertEqual(fake.calls[1][2], {"approved": False})
        self.assertEqual(fake.calls[2][1], "/forge")
        self.assertEqual(fake.calls[3][1], f"/forge/{forge}/decision")

    def test_invalid_ids_do_not_call_the_plane(self):
        fake = FakeClient()
        raw = tools.approve_action(make_plane(fake), {"actionId": "nope", "approved": True})
        self.assertIn("UUID", _loads(raw)["error"])
        self.assertEqual(fake.calls, [])

    def test_down_plane_is_a_json_error(self):
        fake = FakeClient(error=client.ControlPlaneError("EventForge control plane is not running"))
        raw = tools.list_workflows(make_plane(fake), {})
        self.assertFalse(_loads(raw)["ok"])
        self.assertIn("not running", _loads(raw)["error"])

    def test_relay_is_refused_in_cron_and_gateway(self):
        fake = FakeClient()
        raw = tools.listen_for_webhook(
            make_plane(fake, fail_closed=True),
            {"provider": "github"},
        )
        self.assertIn("messaging-gateway", _loads(raw)["error"])
        self.assertEqual(fake.calls, [])

    def test_slash_replay_is_read_only(self):
        event_id = "55555555-5555-5555-5555-555555555555"
        fake = FakeClient(
            routes={
                ("GET", "/events"): [
                    {
                        "id": event_id,
                        "signatureStatus": "verified",
                        "provider": "github",
                        "topic": "check_run",
                        "workspaceId": "demo-workspace",
                        "payload": {"conclusion": "failure"},
                    }
                ],
                ("GET", "/audit"): [{"subjectId": event_id, "message": "workflow matched"}],
            }
        )
        text = commands.handle_command(make_plane(fake), f"replay {event_id}")
        self.assertIn(event_id, text)
        self.assertIn("read-only", text)
        self.assertIn("workflow matched", text)
        self.assertEqual([call[0] for call in fake.calls], ["GET", "GET"])

    def test_slash_usage(self):
        fake = FakeClient()
        self.assertIn("Usage:", commands.handle_command(make_plane(fake), "nope"))
        self.assertEqual(fake.calls, [])

    def test_base_url_rejects_credentials_and_remote_http(self):
        with self.assertRaises(client.ControlPlaneError):
            client.normalize_base_url("http://user:secret@127.0.0.1:4310")
        with self.assertRaises(client.ControlPlaneError):
            client.normalize_base_url("http://example.com")
        with self.assertRaises(client.ControlPlaneError):
            client.normalize_base_url("file:///tmp/eventforge")
        self.assertEqual(
            client.normalize_base_url("http://127.0.0.1:4310/"),
            "http://127.0.0.1:4310",
        )

    def test_transport_attaches_the_bearer_token(self):
        seen = {}

        def transport(http, method, path, body):
            seen["token"] = http.token
            seen["path"] = path
            seen["method"] = method
            return {"service": "eventforge-control-plane"}

        http = client.ControlPlaneClient(
            "http://127.0.0.1:4310",
            token="from-hermes",
            transport=transport,
        )
        self.assertEqual(http.request("GET", "/health")["service"], "eventforge-control-plane")
        self.assertEqual(seen, {"token": "from-hermes", "path": "/health", "method": "GET"})

    def test_bundle_path_must_be_the_repo_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            other = Path(tmp) / "other.cjs"
            other.write_text("not the bundle", encoding="utf-8")
            with self.assertRaises(client.ControlPlaneError) as caught:
                bundle_mod.resolve_bundle(str(other))
        self.assertIn("eventforge-standalone.cjs", str(caught.exception))

    def test_auto_start_is_not_attempted_when_the_session_cannot_wait(self):
        fake = FakeClient(error=client.ControlPlaneError("down"))
        with self.assertRaises(client.ControlPlaneError) as caught:
            bundle_mod.ensure_started(fake, "", allow=False)
        self.assertIn("do not start it", str(caught.exception))
        self.assertTrue(fake.calls)

    def test_catalog_install_without_a_bundle_fails_clearly(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin_file = Path(tmp) / "eventforge" / "bundle.py"
            plugin_file.parent.mkdir()
            plugin_file.write_text("# catalog copy\n", encoding="utf-8")
            with self.assertRaises(client.ControlPlaneError) as caught:
                bundle_mod.resolve_bundle("", plugin_file=plugin_file)
        self.assertEqual(str(caught.exception), bundle_mod.CATALOG_BUNDLE_MESSAGE)

    def test_checkout_without_a_built_bundle_names_the_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plugin_file = root / "plugins" / "hermes-eventforge" / "bundle.py"
            plugin_file.parent.mkdir(parents=True)
            plugin_file.write_text("# checkout\n", encoding="utf-8")
            (root / "plugins" / "eventforge" / "server").mkdir(parents=True)
            with self.assertRaises(client.ControlPlaneError) as caught:
                bundle_mod.resolve_bundle("", plugin_file=plugin_file)
        self.assertIn("bundle:plugin", str(caught.exception))
        self.assertNotIn("catalog install", str(caught.exception))

    def test_stderr_log_rotates_and_is_not_a_pipe(self):
        node = __import__("shutil").which("node")
        if not node:
            self.skipTest("node is not on PATH")
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            log = bundle_mod.prepare_stderr_log(directory)
            log.write_bytes(b"x" * bundle_mod.STDERR_CAP)
            rotated = bundle_mod.prepare_stderr_log(directory)
            self.assertTrue((directory / "bundle-stderr.log.1").is_file())
            self.assertEqual(rotated.stat().st_size, 0)
            bundle = directory / "eventforge-standalone.cjs"
            bundle.write_text("process.stderr.write('bundle-said-hello\\n')\n", encoding="utf-8")
            process = bundle_mod._spawn(str(bundle), directory)
            self.assertIsNone(process.stderr)
            process.wait(timeout=5)
            self.assertIn("bundle-said-hello", bundle_mod._stderr_tail(process))

    def test_false_string_does_not_enable_auto_start(self):
        disabled = settings_mod.load_settings(_Config({"auto_start": "false"}), fail_closed=True)
        enabled = settings_mod.load_settings(_Config({"auto_start": "true"}), fail_closed=True)
        self.assertFalse(disabled.auto_start)
        self.assertTrue(enabled.auto_start)
        with self.assertRaises(client.ControlPlaneError):
            settings_mod.load_settings(_Config({"auto_start": "maybe"}), fail_closed=True)

    def test_kanban_and_single_query_are_unattended(self):
        original = runtime.get_session_env

        def lookup(name):
            return {
                "HERMES_KANBAN_TASK": "task-1",
                "HERMES_SESSION_PLATFORM": "cli",
            }.get(name, "")

        runtime.get_session_env = lookup
        try:
            self.assertTrue(runtime.is_fail_closed_context())
            runtime.get_session_env = lambda name: (
                "1" if name == "HERMES_SINGLE_QUERY_SESSION" else ""
            )
            self.assertTrue(runtime.is_fail_closed_context())
        finally:
            runtime.get_session_env = original

    def test_redirects_are_rejected(self):
        with self.assertRaises(client.ControlPlaneError) as caught:
            client._RejectRedirects().redirect_request(
                None, None, 302, "Found", {}, "https://evil.example/steal"
            )
        self.assertIn("Authorization", str(caught.exception))


class _Config:
    def __init__(self, values):
        self.values = values

    def get_config(self, key, default=None):
        return self.values.get(key, default)


if __name__ == "__main__":
    unittest.main()
