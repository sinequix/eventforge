"""Plugin settings. Secrets come from Hermes ``get_secret`` and nowhere else."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .client import ControlPlaneError, normalize_base_url
from .runtime import is_fail_closed_context

try:
    from agent.secret_scope import get_secret
except ImportError:
    get_secret = None

TOKEN_NAME = "EVENTFORGE_API_TOKEN"


@dataclass(frozen=True)
class Settings:
    api_url: str
    token: str
    workspace_id: str
    project_id: str
    auto_start: bool
    timeout: float
    bundle_path: str
    fail_closed: bool
    context_chars: int = 1200


def load_settings(ctx: Any, *, fail_closed: bool | None = None) -> Settings:
    closed = is_fail_closed_context() if fail_closed is None else fail_closed
    timeout = _timeout(ctx.get_config("request_timeout_seconds", 10), closed)
    return Settings(
        api_url=normalize_base_url(str(ctx.get_config("api_url", "http://127.0.0.1:4310"))),
        token=read_api_token(),
        workspace_id=_text(ctx.get_config("workspace_id", "demo-workspace"), "demo-workspace"),
        project_id=_text(ctx.get_config("project_id", "eventforge-demo-service"), "eventforge-demo-service"),
        auto_start=_bool(ctx.get_config("auto_start", False), False),
        timeout=timeout,
        bundle_path=_text(ctx.get_config("bundle_path", ""), ""),
        fail_closed=closed,
        context_chars=context_chars(ctx.get_config("context_payload_chars", DEFAULT_CONTEXT_CHARS)),
    )


def read_api_token() -> str:
    """Read the bearer token Hermes stored for this plugin.

    An empty value is valid: the local control plane does not require one.
    A failure from ``get_secret`` is reported and never replaced with a file read.
    """

    if get_secret is None:
        return ""
    try:
        value = get_secret(TOKEN_NAME, "")
    except Exception as exc:
        raise ControlPlaneError(
            "EventForge could not read EVENTFORGE_API_TOKEN through Hermes. "
            "Set the plugin secret in Hermes. This plugin does not read credential files."
        ) from exc
    return str(value or "").strip()


DEFAULT_CONTEXT_CHARS = 1200
MIN_CONTEXT_CHARS = 200
MAX_CONTEXT_CHARS = 4000


def context_chars(raw: Any) -> int:
    """Per-event budget for verified payload context. Clamped to 200..4000."""

    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_CONTEXT_CHARS
    return min(MAX_CONTEXT_CHARS, max(MIN_CONTEXT_CHARS, value))


def _timeout(raw: Any, fail_closed: bool) -> float:
    try:
        timeout = float(raw)
    except (TypeError, ValueError):
        timeout = 10.0
    timeout = min(30.0, max(1.0, timeout))
    if fail_closed:
        return min(timeout, 5.0)
    return timeout


_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})


def _bool(value: Any, default: bool) -> bool:
    """Parse a config boolean. The string "false" is false, not true."""

    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, int) and value in (0, 1):
        return value == 1
    text = str(value).strip().lower()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    if text == "":
        return default
    raise ControlPlaneError(f"auto_start must be true or false, got {value!r}.")


def _text(value: Any, default: str) -> str:
    text = str(value or "").strip()
    return text or default
