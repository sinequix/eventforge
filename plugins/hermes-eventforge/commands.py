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
        audit = plane.client.request("GET", "/audit")
    except ControlPlaneError as exc:
        return f"EventForge replay: unavailable. {exc}"
    event = _find(events, event_id)
    if event is None:
        return f"EventForge replay: no event with id {event_id}."
    notes = [
        item.get("message")
        for item in audit
        if isinstance(item, dict) and (item.get("subjectId") == event_id or event_id in str(item.get("message") or ""))
    ] if isinstance(audit, list) else []
    payload = event.get("payload")
    preview = json.dumps(payload, default=str)[:800] if isinstance(payload, dict) else ""
    lines = [
        f"EventForge replay {event.get('id')}",
        f"signature={event.get('signatureStatus')} {event.get('provider')}:{event.get('topic')}",
        f"workspace={event.get('workspaceId')} repository={event.get('repository') or '-'}",
        "This is a read-only view of the stored event. It does not re-run a workflow or approve an action.",
    ]
    if preview:
        lines.append(f"payload={preview}")
    if notes:
        lines.append("audit:")
        lines.extend(f"- {note}" for note in notes[:8])
    return "\n".join(lines)


def _find(events: Any, event_id: str) -> dict[str, Any] | None:
    if not isinstance(events, list):
        return None
    for event in events:
        if isinstance(event, dict) and str(event.get("id")) == event_id:
            return event
    return None
