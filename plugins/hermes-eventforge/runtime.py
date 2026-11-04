"""Detect Hermes sessions where nobody can answer a prompt.

``gateway.session_context`` is a documented plugin surface. It is imported
defensively because unit tests load this package without Hermes installed.
"""

from __future__ import annotations

try:
    from gateway.session_context import get_session_env
except ImportError:
    get_session_env = None

_TRUTHY = frozenset({"1", "true", "yes", "on"})
_INTERACTIVE_PLATFORMS = frozenset({"", "cli", "tui", "desktop", "local"})
_PROGRAMMATIC_PLATFORMS = frozenset({"cron", "webhook", "api_server", "msgraph_webhook"})


def _session_value(name: str) -> str:
    if get_session_env is None:
        return ""
    try:
        value = get_session_env(name)
    except Exception:
        return ""
    if value is None:
        return ""
    return str(value).strip()


def is_fail_closed_context() -> bool:
    """Cron, programmatic platforms, and the messaging gateway.

    Interactive CLI, TUI, and Desktop sessions are the places a person can
    approve a tool or start the control plane. Everywhere else the plugin
    returns a message instead of waiting.
    """

    if _session_value("HERMES_CRON_SESSION").lower() in _TRUTHY:
        return True
    platform = _session_value("HERMES_SESSION_PLATFORM").lower()
    if platform in _PROGRAMMATIC_PLATFORMS:
        return True
    return platform not in _INTERACTIVE_PLATFORMS
