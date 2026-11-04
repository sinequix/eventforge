"""HTTP client for the local EventForge control plane.

The MCP tools in ``packages/mcp-server/src/server.ts`` are thin wrappers over
these routes. Call the same routes. Do not reimplement workflow, policy, or
forge behavior here.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
DEFAULT_API_URL = "http://127.0.0.1:4310"

Transport = Callable[["ControlPlaneClient", str, str, dict[str, Any] | None], Any]


class ControlPlaneError(Exception):
    """The control plane refused the call or could not be reached."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def normalize_base_url(value: str | None) -> str:
    """Accept only an absolute http(s) URL, with plain HTTP limited to loopback."""

    raw = (value or "").strip() or DEFAULT_API_URL
    parsed = urllib.parse.urlparse(raw)
    host = parsed.hostname or ""
    if parsed.scheme not in {"http", "https"} or not host:
        raise ControlPlaneError("api_url must be an absolute http(s) URL.")
    if parsed.username or parsed.password:
        raise ControlPlaneError(
            "api_url must not embed credentials. Store the bearer token in the "
            "Hermes secret EVENTFORGE_API_TOKEN."
        )
    if parsed.scheme == "http" and host not in LOOPBACK_HOSTS:
        raise ControlPlaneError("Plain HTTP is only allowed for a loopback EventForge control plane.")
    return raw.rstrip("/")


def is_loopback(base_url: str) -> bool:
    host = urllib.parse.urlparse(base_url).hostname or ""
    return host in LOOPBACK_HOSTS


class ControlPlaneClient:
    """Small JSON client. ``transport`` is a test seam; production uses urllib."""

    def __init__(
        self,
        base_url: str,
        token: str = "",
        timeout: float = 10.0,
        transport: Transport | None = None,
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        self.token = token.strip()
        self.timeout = timeout
        self._transport = transport or _urllib_transport

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        if not path.startswith("/"):
            raise ControlPlaneError("Control-plane paths must start with '/'.")
        try:
            return self._transport(self, method, path, body)
        except ControlPlaneError:
            raise
        except Exception as exc:
            raise ControlPlaneError(
                f"EventForge control plane is not reachable at {self.base_url}: {exc}"
            ) from exc

    def health(self) -> Any:
        return self.request("GET", "/health")


def _urllib_transport(
    client: ControlPlaneClient,
    method: str,
    path: str,
    body: dict[str, Any] | None,
) -> Any:
    headers = {"accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    if client.token:
        headers["authorization"] = f"Bearer {client.token}"
    request = urllib.request.Request(client.base_url + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=client.timeout) as response:
            raw = response.read()
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300].strip()
        suffix = f": {detail}" if detail else "."
        raise ControlPlaneError(f"EventForge API returned {exc.code}{suffix}", exc.code) from exc
    except urllib.error.URLError as exc:
        raise ControlPlaneError(
            f"EventForge control plane is not running at {client.base_url}. "
            "Start it from a checkout and keep that process alive."
        ) from exc
    if status == 204 or not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ControlPlaneError("EventForge API returned invalid JSON.", status) from exc
