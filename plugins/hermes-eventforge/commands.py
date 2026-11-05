"""``/eventforge`` status, event list, and read-only replay."""

from __future__ import annotations

import json
from typing import Any

from .client import ControlPlaneError
from .plane import Plane, ready


def handle_command(plane: Plane, raw_args: str) -> str:
    try:
        return _dispatch(plane, raw_args)
    except Exception as exc:
        return f"EventForge command failed: {exc}"


def _dispatch(plane: Plane, raw_args: str) -> str:
    parts = raw_args.strip().split()
    command = parts[0].lower() if parts else "status"
    if command == "status":
        return _status(plane)
    if command == "events":
        return _events(plane)
    if command == "replay":
        if len(parts) < 2:
            return "Usage: /eventforge replay <event-id>"
        return _replay(plane, parts[1])
    return "Usage: /eventforge status|events|replay <id>"


def _status(plane: Plane) -> str:
    try:
        ready(plane)
        body = plane.client.health()
    except ControlPlaneError as exc:
        return f"EventForge status: unavailable. {exc}"
    if not isinstance(body, dict):
        return "EventForge status: the control plane returned an unexpected health payload."
    return (
        "EventForge status: "
        f"ok={body.get('ok')} service={body.get('service')} "
        f"runtime={body.get('runtime')} runner={body.get('runner')} "
        f"api={plane.client.base_url}"
    )


def _events(plane: Plane) -> str:
    try:
        ready(plane)
        events = plane.client.request("GET", "/events")
    except ControlPlaneError as exc:
        return f"EventForge events: unavailable. {exc}"
    if not isinstance(events, list):
        return "EventForge events: the control plane did not return a list."
    if not events:
        return "EventForge events: none recorded."
    lines = ["EventForge events:"]
    for event in events[:10]:
        if not isinstance(event, dict):
            continue
        lines.append(
            f"- {event.get('id')} {event.get('signatureStatus')} "
            f"{event.get('provider')}:{event.get('topic')}"
        )
    if len(events) > 10:
        lines.append(f"... {len(events) - 10} more.")
    return "\n".join(lines)


def _replay(plane: Plane, event_id: str) -> str:
    try:
        ready(plane)
        events = plane.client.request("GET", "/events")
    except ControlPlaneError as exc:
        return f"EventForge replay: unavailable. {exc}"
    runs = _optional(plane, "/runs")
    actions = _optional(plane, "/actions")
    audit = _optional(plane, "/audit")
    event = _find(events, event_id)
    if event is None:
        return f"EventForge replay: no event with id {event_id}."
    related_runs = [run for run in _dicts(runs) if str(run.get("eventId")) == event_id]
    related_actions = [action for action in _dicts(actions) if str(action.get("eventId")) == event_id]
    notes = related_audit(event_id, related_runs, related_actions, audit)
    verified = event.get("signatureStatus") == "verified"
    payload = event.get("payload")
    preview = json.dumps(payload, default=str)[:800] if isinstance(payload, dict) else ""
    lines = [
        f"EventForge replay {event.get('id')}",
        f"signature={event.get('signatureStatus')} {event.get('provider')}:{event.get('topic')}",
        f"workspace={event.get('workspaceId')} repository={event.get('repository') or '-'}",
        "This is a read-only view of the stored event. It does not re-run a workflow or approve an action.",
    ]
    if preview and verified:
        lines.append(f"payload (untrusted provider data)={preview}")
    elif preview:
        lines.append("payload withheld: the signature was not verified.")
    if related_runs:
        lines.append("runs:")
        lines.extend(
            f"- {run.get('id')} {run.get('status')} workflow={run.get('workflowId')}"
            for run in related_runs[:10]
        )
    if related_actions:
        lines.append("actions:")
        lines.extend(
            f"- {action.get('id')} {action.get('type')} {action.get('status')}"
            for action in related_actions[:10]
        )
    if notes:
        lines.append("audit:")
        lines.extend(
            f"- {item.get('createdAt') or '-'} {item.get('kind') or '-'} {item.get('message')}"
            for item in notes[:_AUDIT_LIMIT]
        )
        if len(notes) > _AUDIT_LIMIT:
            lines.append(f"... {len(notes) - _AUDIT_LIMIT} more audit entries.")
    return "\n".join(lines)


_AUDIT_LIMIT = 30


def related_audit(event_id: str, runs: list[dict[str, Any]], actions: list[dict[str, Any]], audit: Any) -> list[dict[str, Any]]:
    """Audit entries for the event, its runs, and its action proposals, oldest first.

    Correlation is by id: the event id (as subject or in the message, which is
    how ``workflow_matched`` names the event), every run id for the event, and
    every action id proposed for it.
    """

    subjects = {event_id}
    subjects.update(str(run.get("id")) for run in runs if run.get("id"))
    subjects.update(str(action.get("id")) for action in actions if action.get("id"))
    # /audit lists newest first; reversing keeps insertion order for entries
    # that share a timestamp once the stable sort below runs.
    matched = [
        item
        for item in reversed(_dicts(audit))
        if str(item.get("subjectId")) in subjects or event_id in str(item.get("message") or "")
    ]
    return sorted(matched, key=lambda item: str(item.get("createdAt") or ""))


def _optional(plane: Plane, path: str) -> Any:
    """Read a correlation source. A refused or failed read leaves that part out."""

    try:
        return plane.client.request("GET", path)
    except ControlPlaneError:
        return []


def _dicts(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _find(events: Any, event_id: str) -> dict[str, Any] | None:
    if not isinstance(events, list):
        return None
    for event in events:
        if isinstance(event, dict) and str(event.get("id")) == event_id:
            return event
    return None
