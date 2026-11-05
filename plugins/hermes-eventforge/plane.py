"""Open one configured client for a tool, hook, or slash command."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .bundle import ensure_started
from .client import ControlPlaneClient
from .settings import Settings, load_settings


@dataclass(frozen=True)
class Plane:
    client: ControlPlaneClient
    settings: Settings


def open_plane(ctx: Any, *, fail_closed: bool | None = None, client: ControlPlaneClient | None = None) -> Plane:
    settings = load_settings(ctx, fail_closed=fail_closed)
    if client is None:
        client = ControlPlaneClient(settings.api_url, settings.token, settings.timeout)
    return Plane(client=client, settings=settings)


def ready(plane: Plane) -> None:
    """Start the bundled plane when the user opted in and this session may wait."""

    if not plane.settings.auto_start:
        return
    ensure_started(
        plane.client,
        plane.settings.bundle_path,
        allow=not plane.settings.fail_closed,
    )
