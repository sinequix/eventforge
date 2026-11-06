"""Optionally start the control-plane bundle that already ships in this repo.

The file is produced from TypeScript by
``pnpm --filter @eventforge/mcp-server bundle:plugin``. The plugin never
downloads a replacement and never invokes ``npx``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from collections.abc import Mapping
from pathlib import Path

from .client import ControlPlaneClient, ControlPlaneError, is_loopback
from .settings import TOKEN_NAME, read_api_token

try:
    from plugins.plugin_storage import plugin_data_dir
except ImportError:
    plugin_data_dir = None

BUNDLE_FILENAME = "eventforge-standalone.cjs"
CATALOG_BUNDLE_MESSAGE = (
    "catalog install: set bundle_path or run the EventForge control plane yourself"
)
# Exact names copied from the parent. Everything else stays there.
_FORWARDED_EXACT = frozenset({"PATH", "HOME"})
# Node's own runtime variables, plus EventForge plane settings. The API token
# is not part of this copy; it is added from Hermes get_secret.
_FORWARDED_PREFIXES = ("NODE_", "EVENTFORGE_")
STDERR_CAP = 256 * 1024
_STDERR_TAIL = 500
_lock = threading.Lock()
_process: subprocess.Popen[bytes] | None = None
_stderr_paths: dict[int, Path] = {}


def sibling_bundle(plugin_file: Path | None = None) -> Path:
    """``plugins/eventforge/server/eventforge-standalone.cjs`` next to this plugin."""

    anchor = Path(plugin_file or __file__).resolve()
    return anchor.parents[1] / "eventforge" / "server" / BUNDLE_FILENAME


def is_symlink_or_checkout(plugin_file: Path | None = None) -> bool:
    """A local symlink or a repo checkout can see the sibling bundle."""

    raw_dir = Path(plugin_file or __file__).parent
    if raw_dir.is_symlink():
        return True
    resolved = raw_dir.resolve()
    sibling = resolved.parent / "eventforge"
    return sibling.is_dir() and sibling.resolve() != resolved


def resolve_bundle(configured: str, *, plugin_file: Path | None = None) -> Path:
    if configured.strip():
        path = Path(configured).expanduser().resolve()
    else:
        path = sibling_bundle(plugin_file)
        if not path.is_file() and not is_symlink_or_checkout(plugin_file):
            raise ControlPlaneError(CATALOG_BUNDLE_MESSAGE)
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


def ensure_started(
    client: ControlPlaneClient,
    bundle_path: str,
    *,
    allow: bool,
    stderr_dir: Path | None = None,
) -> None:
    """Make sure /health answers. Spawn the bundle only when ``allow`` is true."""

    if _healthy(client):
        return
    if not allow or not is_loopback(client.base_url):
        raise ControlPlaneError(_down_message(client.base_url, fail_closed=not allow))
    _spawn_and_wait(client, bundle_path, stderr_dir)


def prepare_stderr_log(directory: Path) -> Path:
    """Return the stderr log, rotating the previous file once it passes the cap."""

    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "bundle-stderr.log"
    if path.is_file() and path.stat().st_size >= STDERR_CAP:
        previous = directory / "bundle-stderr.log.1"
        if previous.exists():
            previous.unlink()
        path.replace(previous)
    path.touch()
    return path


def read_stderr_tail(path: Path) -> str:
    if not path.is_file():
        return ""
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    return data[-_STDERR_TAIL:].decode("utf-8", "replace").strip()


def _healthy(client: ControlPlaneClient) -> bool:
    try:
        body = client.health()
    except ControlPlaneError:
        return False
    return isinstance(body, dict) and body.get("ok") is True and body.get("service") == "eventforge-control-plane"


def _spawn_and_wait(
    client: ControlPlaneClient,
    configured: str,
    stderr_dir: Path | None,
) -> None:
    global _process
    with _lock:
        if _process is not None and _process.poll() is None:
            process = _process
        else:
            process = _spawn(configured, stderr_dir)
            _process = process
    try:
        _wait_until_healthy(client, process)
    except ControlPlaneError:
        _stop(process)
        raise


def _stderr_directory(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit
    if plugin_data_dir is not None:
        return plugin_data_dir("eventforge")
    fallback = Path.home() / ".hermes" / "plugin-data" / "eventforge"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def _child_environment(source: Mapping[str, str] | None = None) -> dict[str, str]:
    """Environment for ``eventforge-standalone.cjs``.

    The child does not inherit the Hermes process. It receives ``PATH`` and
    ``HOME`` when they are set, every ``NODE_*`` variable (``NODE_PATH``,
    ``NODE_ENV``, and the rest of Node's runtime family), and every
    ``EVENTFORGE_*`` variable except the API token. ``EVENTFORGE_API_TOKEN``
    is set only from Hermes ``get_secret``, and only when that value is
    non-empty. Provider keys and other parent config are left out. Callers
    must not log the returned mapping: it may contain the token.
    """

    current = os.environ if source is None else source
    env: dict[str, str] = {}
    for key, value in current.items():
        if not value or key == TOKEN_NAME:
            continue
        if key in _FORWARDED_EXACT or key.startswith(_FORWARDED_PREFIXES):
            env[key] = value
    token = read_api_token()
    if token:
        env[TOKEN_NAME] = token
    return env


def _spawn(configured: str, stderr_dir: Path | None) -> subprocess.Popen[bytes]:
    bundle = resolve_bundle(configured)
    node = shutil.which("node")
    if not node:
        raise ControlPlaneError(
            "node was not found on PATH. The EventForge bundle needs Node.js 20.11 or newer. "
            "Nothing was downloaded."
        )
    env = _child_environment()
    log_path = prepare_stderr_log(_stderr_directory(stderr_dir))
    handle = open(log_path, "ab")
    try:
        # stdin stays open: the bundle stops its embedded plane when stdin closes.
        # stderr is a file, not a pipe, so a chatty child cannot fill a buffer and block.
        # env is the allowlist from _child_environment, never os.environ itself.
        process = subprocess.Popen(
            [node, str(bundle)],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=handle,
            env=env,
        )
    except OSError as exc:
        raise ControlPlaneError(f"Could not start the EventForge bundle: {exc}") from exc
    finally:
        handle.close()
    _stderr_paths[id(process)] = log_path
    _cap_stderr(process, log_path)
    return process


def _cap_stderr(process: subprocess.Popen[bytes], path: Path) -> None:
    def watch() -> None:
        while process.poll() is None:
            time.sleep(0.5)
            _truncate_to_cap(path)
        _truncate_to_cap(path)

    threading.Thread(target=watch, name="eventforge-bundle-stderr", daemon=True).start()


def _truncate_to_cap(path: Path) -> None:
    try:
        if not path.is_file() or path.stat().st_size <= STDERR_CAP:
            return
        data = path.read_bytes()[-STDERR_CAP:]
        path.write_bytes(data)
    except OSError:
        return


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
    path = _stderr_paths.get(id(process))
    if path is None:
        return ""
    return read_stderr_tail(path)


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
