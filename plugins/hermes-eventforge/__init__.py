"""EventForge for Hermes. ``register`` is the only entry point Hermes calls."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .commands import handle_command
from .hooks import on_session_start, post_tool_call, pre_llm_call, pre_tool_call
from .plane import open_plane
from .tools import TOOL_SPECS

_SKILL = Path(__file__).resolve().parent / "skills" / "triage" / "SKILL.md"


def register(ctx: Any) -> None:
    """Register tools, hooks, ``/eventforge``, and the triage skill."""

    def _plane() -> Any:
        return open_plane(ctx)

    for spec in TOOL_SPECS:
        def _handler(args: dict[str, Any], _spec: Any = spec, **kwargs: Any) -> str:
            del kwargs
            try:
                plane = _plane()
            except Exception as exc:
                return json.dumps({"ok": False, "error": str(exc)})
            return _spec.handler(plane, args if isinstance(args, dict) else {})

        ctx.register_tool(
            name=spec.name,
            toolset="eventforge",
            schema=spec.schema,
            handler=_handler,
            description=str(spec.schema.get("description") or ""),
        )

    def _on_pre_llm_call(**kwargs: Any) -> dict[str, str] | None:
        try:
            return pre_llm_call(_plane(), ctx.state, **kwargs)
        except Exception:
            return None

    def _on_pre_tool_call(**kwargs: Any) -> dict[str, str] | None:
        try:
            return pre_tool_call(**kwargs)
        except Exception:
            return None

    def _on_post_tool_call(**kwargs: Any) -> None:
        try:
            post_tool_call(_plane(), **kwargs)
        except Exception:
            return None
        return None

    def _on_session_start(**kwargs: Any) -> None:
        try:
            on_session_start(_plane(), ctx.state, **kwargs)
        except Exception:
            return None
        return None

    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("on_session_start", _on_session_start)

    def _command(raw_args: str, **kwargs: Any) -> str:
        del kwargs
        try:
            return handle_command(_plane(), raw_args or "")
        except Exception as exc:
            return f"EventForge command failed: {exc}"

    ctx.register_command(
        "eventforge",
        handler=_command,
        description="Show EventForge status, recent events, or a read-only event replay",
        args_hint="status|events|replay <id>",
    )
    ctx.register_skill(
        "triage",
        _SKILL,
        description="Triage a verified EventForge event without bypassing Hermes approval.",
    )
