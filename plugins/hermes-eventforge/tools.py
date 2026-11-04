"""Hermes tools. Each one calls an existing EventForge HTTP route."""

from __future__ import annotations

import json
import re
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .client import ControlPlaneError
from .plane import Plane, ready

_UUID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# These three are the ones the catalog brief names. ef_approve_forge is included
# because it is the same kind of irreversible control-plane decision as
# ef_approve_action. The hook escalates them to Hermes; it never approves them.
APPROVAL_TOOLS = frozenset(
    {
        "ef_approve_action",
        "ef_approve_forge",
        "ef_forge_mcp",
        "ef_spawn_subagent",
    }
)

RELAY_BLOCKED = (
    "ef_listen_for_webhook can start a tunnel and wait for it. "
    "That wait is disabled in cron and messaging-gateway sessions. "
    "Run it from an interactive Hermes session once the control plane is up."
)

Handler = Callable[[Plane, dict[str, Any]], str]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    schema: dict[str, Any]
    handler: Handler


def _object(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required}


def _schema(name: str, description: str, parameters: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "description": description, "parameters": parameters}


def _ok(value: Any) -> str:
    return json.dumps(value, default=str)


def _error(message: str) -> str:
    return json.dumps({"ok": False, "error": message})


def _call(
    plane: Plane,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    blocked: str | None = None,
) -> str:
    if blocked and plane.settings.fail_closed:
        return _error(blocked)
    try:
        ready(plane)
        return _ok(plane.client.request(method, path, body))
    except ControlPlaneError as exc:
        return _error(str(exc))
    except Exception as exc:
        return _error(f"EventForge tool failed: {exc}")


def _uuid(args: dict[str, Any], key: str) -> str | None:
    value = str(args.get(key) or "").strip()
    if _UUID.match(value):
        return value
    return None


def _query(path: str, params: dict[str, str]) -> str:
    clean = {key: value for key, value in params.items() if value}
    if not clean:
        return path
    return path + "?" + urllib.parse.urlencode(clean)


def listen_for_webhook(plane: Plane, args: dict[str, Any]) -> str:
    provider = str(args.get("provider") or "").strip()
    if provider not in {"github", "linear", "sentry"}:
        return _error("provider must be github, linear, or sentry.")
    return _call(plane, "POST", "/relay/ensure", {"provider": provider}, blocked=RELAY_BLOCKED)


def emit_event(plane: Plane, args: dict[str, Any]) -> str:
    topic = str(args.get("topic") or "").strip()
    payload = args.get("payload")
    if not topic or not isinstance(payload, dict):
        return _error("topic and a JSON payload object are required.")
    provider = str(args.get("provider") or "custom")
    if provider not in {"custom", "github", "linear", "sentry"}:
        return _error("provider must be custom, github, linear, or sentry.")
    return _call(
        plane,
        "POST",
        "/events",
        {
            "provider": provider,
            "topic": topic,
            "payload": payload,
            "workspaceId": str(args.get("workspaceId") or plane.settings.workspace_id),
            "projectId": str(args.get("projectId") or plane.settings.project_id),
        },
    )


def query_memory(plane: Plane, args: dict[str, Any]) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        return _error("query is required.")
    path = _query(
        "/memory",
        {
            "workspaceId": str(args.get("workspaceId") or plane.settings.workspace_id),
            "projectId": str(args.get("projectId") or plane.settings.project_id),
            "q": query,
        },
    )
    return _call(plane, "GET", path)


def spawn_subagent(plane: Plane, args: dict[str, Any]) -> str:
    workflow_id = _uuid(args, "workflowId")
    event_id = _uuid(args, "eventId")
    if not workflow_id or not event_id:
        return _error("workflowId and eventId must be UUIDs.")
    return _call(plane, "POST", "/agent-runs", {"workflowId": workflow_id, "eventId": event_id})


def approve_action(plane: Plane, args: dict[str, Any]) -> str:
    action_id = _uuid(args, "actionId")
    if not action_id or not isinstance(args.get("approved"), bool):
        return _error("actionId must be a UUID and approved must be a boolean.")
    return _call(plane, "POST", f"/actions/{action_id}/decision", {"approved": args["approved"]})


def forge_mcp(plane: Plane, args: dict[str, Any]) -> str:
    prompt = str(args.get("prompt") or "").strip()
    if len(prompt) < 8:
        return _error("prompt must be at least 8 characters.")
    return _call(
        plane,
        "POST",
        "/forge",
        {
            "prompt": prompt,
            "workspaceId": str(args.get("workspaceId") or plane.settings.workspace_id),
        },
    )


def approve_forge(plane: Plane, args: dict[str, Any]) -> str:
    forge_id = _uuid(args, "forgeId")
    if not forge_id or not isinstance(args.get("approved"), bool):
        return _error("forgeId must be a UUID and approved must be a boolean.")
    return _call(plane, "POST", f"/forge/{forge_id}/decision", {"approved": args["approved"]})


def list_events(plane: Plane, args: dict[str, Any]) -> str:
    workspace = str(args.get("workspaceId") or "").strip()
    return _call(plane, "GET", _query("/events", {"workspaceId": workspace}))


def list_workflows(plane: Plane, args: dict[str, Any]) -> str:
    workspace = str(args.get("workspaceId") or "").strip()
    return _call(plane, "GET", _query("/workflows", {"workspaceId": workspace}))


_PROVIDER = {"type": "string", "enum": ["github", "linear", "sentry"]}
_WORKSPACE = {"type": "string", "description": "EventForge workspace id. Defaults to the plugin setting."}
_PROJECT = {"type": "string", "description": "EventForge project id. Defaults to the plugin setting."}

TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        "ef_listen_for_webhook",
        _schema(
            "ef_listen_for_webhook",
            "Ensure the local EventForge relay is running and return the verified provider "
            "webhook endpoint. Managed tunnel credentials are never returned. "
            "Disabled in cron and messaging-gateway sessions because it can wait on a tunnel.",
            _object({"provider": {**_PROVIDER, "description": "github, linear, or sentry"}}, ["provider"]),
        ),
        listen_for_webhook,
    ),
    ToolSpec(
        "ef_emit_event",
        _schema(
            "ef_emit_event",
            "Add a manually supplied, untrusted event to EventForge. It can trigger only "
            "matching workflows and cannot bypass their policies.",
            _object(
                {
                    "topic": {"type": "string", "description": "Event topic, such as check_run."},
                    "payload": {"type": "object", "description": "Untrusted event payload."},
                    "provider": {
                        "type": "string",
                        "enum": ["custom", "github", "linear", "sentry"],
                        "description": "Provider name. Defaults to custom.",
                    },
                    "workspaceId": _WORKSPACE,
                    "projectId": _PROJECT,
                },
                ["topic", "payload"],
            ),
        ),
        emit_event,
    ),
    ToolSpec(
        "ef_query_memory",
        _schema(
            "ef_query_memory",
            "Search only the selected EventForge workspace and project memory scope. Read-only.",
            _object(
                {
                    "query": {"type": "string", "description": "Memory search text."},
                    "workspaceId": _WORKSPACE,
                    "projectId": _PROJECT,
                },
                ["query"],
            ),
        ),
        query_memory,
    ),
    ToolSpec(
        "ef_spawn_subagent",
        _schema(
            "ef_spawn_subagent",
            "Start an analysis-only EventForge agent run for an existing workflow and event. "
            "Any write comes back as a separate approval proposal. Hermes asks the user before "
            "this tool runs.",
            _object(
                {
                    "workflowId": {"type": "string", "description": "Workflow UUID."},
                    "eventId": {"type": "string", "description": "Event UUID."},
                },
                ["workflowId", "eventId"],
            ),
        ),
        spawn_subagent,
    ),
    ToolSpec(
        "ef_approve_action",
        _schema(
            "ef_approve_action",
            "Approve or reject a pending EventForge action proposal. The control plane derives "
            "reviewer identity from its authenticated session. Hermes asks the user before this "
            "tool runs. A Hermes denial does not approve the action.",
            _object(
                {
                    "actionId": {"type": "string", "description": "Action UUID."},
                    "approved": {"type": "boolean", "description": "True to approve, false to reject."},
                },
                ["actionId", "approved"],
            ),
        ),
        approve_action,
    ),
    ToolSpec(
        "ef_forge_mcp",
        _schema(
            "ef_forge_mcp",
            "Create a reviewable, isolated connector draft. The artifact is not installed or "
            "loaded until an owner approves it. Hermes asks the user before this tool runs.",
            _object(
                {
                    "prompt": {"type": "string", "description": "What the connector should do."},
                    "workspaceId": _WORKSPACE,
                },
                ["prompt"],
            ),
        ),
        forge_mcp,
    ),
    ToolSpec(
        "ef_approve_forge",
        _schema(
            "ef_approve_forge",
            "Approve or reject a validated connector draft. Approval never expands the reviewed "
            "capabilities. Hermes asks the user before this tool runs.",
            _object(
                {
                    "forgeId": {"type": "string", "description": "Forge job UUID."},
                    "approved": {"type": "boolean", "description": "True to approve, false to reject."},
                },
                ["forgeId", "approved"],
            ),
        ),
        approve_forge,
    ),
    ToolSpec(
        "ef_list_events",
        _schema(
            "ef_list_events",
            "List recent EventForge events and their signature and processing state. Read-only.",
            _object({"workspaceId": {**_WORKSPACE, "description": "Optional workspace filter."}}, []),
        ),
        list_events,
    ),
    ToolSpec(
        "ef_list_workflows",
        _schema(
            "ef_list_workflows",
            "List configured workflows and their execution policy. Read-only.",
            _object({"workspaceId": {**_WORKSPACE, "description": "Optional workspace filter."}}, []),
        ),
        list_workflows,
    ),
)
