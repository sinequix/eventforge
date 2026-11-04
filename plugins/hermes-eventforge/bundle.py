"""Optionally start the control-plane bundle that already ships in this repo.

The file is produced from TypeScript by
``pnpm --filter @eventforge/mcp-server bundle:plugin``. The plugin never
downloads a replacement and never invokes ``npx``.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
import time
from pathlib import Path

from .client import ControlPlaneClient, ControlPlaneError, is_loopback

BUNDLE_FILENAME = "eventforge-standalone.cjs"
_lock = threading.Lock()
_process: subprocess.Popen[bytes] | None = None


def sibling_bundle() -> Path:
    """``plugins/eventforge/server/eventforge-standalone.cjs`` next to this plugin."""

    return Path(__file__).resolve().parents[1] / "eventforge" / "server" / BUNDLE_FILENAME


def resolve_bundle(configured: str) -> Path:
    if configured.strip():
        path = Path(configured).expanduser().resolve()
    else:
        path = sibling_bundle()
    if path.name != BUNDLE_FILENAME:
        raise ControlPlaneError(
            "bundle_path must name eventforge-standalone.cjs built from this repository."
        )
    if not path.is_file():
        raise ControlPlaneError(
            "EventForge bundle was not found at "
            f"{path}. From a checkout run "
            "`pnpm --filter @eventforge/mcp-server bundle:plugin`, then start "
            "`node plugins/eventforge/server/eventforge-standalone.cjs`. "
            "This plugin does not download a control plane."
        )
    return path


def ensure_started(client: ControlPlaneClient, bundle_path: str, *, allow: bool) -> None:
    """Make sure /health answers. Spawn the bundle only when ``allow`` is true."""

    if _healthy(client):
        return
    if not allow or not is_loopback(client.base_url):
        raise ControlPlaneError(_down_message(client.base_url, fail_closed=not allow))
    _spawn_and_wait(client, bundle_path)


def _healthy(client: ControlPlaneClient) -> bool:
    try:
        body = client.health()
    except ControlPlaneError:
        return False
    return isinstance(body, dict) and body.get("ok") is True and body.get("service") == "eventforge-control-plane"


def _spawn_and_wait(client: ControlPlaneClient, configured: str) -> None:
    global _process
    with _lock:
        if _process is not None and _process.poll() is None:
            process = _process
        else:
            process = _spawn(configured)
            _process = process
    try:
        _wait_until_healthy(client, process)
    except ControlPlaneError:
        _stop(process)
        raise


def _spawn(configured: str) -> subprocess.Popen[bytes]:
    bundle = resolve_bundle(configured)
    node = shutil.which("node")
    if not node:
        raise ControlPlaneError(
            "node was not found on PATH. The EventForge bundle needs Node.js 20.11 or newer. "
            "Nothing was downloaded."
        )
    try:
        # stdin stays open: the bundle stops its embedded plane when stdin closes.
        # env is inherited so this process does not copy or rewrite secrets.
        return subprocess.Popen(
            [node, str(bundle)],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise ControlPlaneError(f"Could not start the EventForge bundle: {exc}") from exc


def _wait_until_healthy(client: ControlPlaneClient, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + min(client.timeout, 10.0)
    last = _down_message(client.base_url, fail_closed=False)
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ControlPlaneError(
                "EventForge bundle exited before it was healthy. " + _stderr_tail(process)
            )
        if _healthy(client):
            return
        time.sleep(0.2)
    raise ControlPlaneError(last.strip())


def _stderr_tail(process: subprocess.Popen[bytes]) -> str:
    if process.stderr is None:
        return ""
    try:
        data = process.stderr.read(500)
    except Exception:
        return ""
    return data.decode("utf-8", "replace").strip()


def _stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()


def _down_message(url: str, *, fail_closed: bool) -> str:
    if fail_closed:
        return (
            f"EventForge control plane is not running at {url}. "
            "Cron and messaging-gateway sessions do not start it and do not wait. "
            "Start the plane from an interactive checkout, then retry."
        )
    return (
        f"EventForge control plane is not running at {url}. "
        "From a checkout, run `node plugins/eventforge/server/eventforge-standalone.cjs` "
        "and leave it running (closing its stdin stops the plane), or run "
        "`pnpm --filter @eventforge/control-plane dev`."
    )
