"""Load the plugin as a package without requiring a Hermes install."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "hermes_eventforge_plugin"


def load_plugin():
    if PACKAGE in sys.modules:
        return sys.modules[PACKAGE]
    spec = importlib.util.spec_from_file_location(
        PACKAGE,
        ROOT / "__init__.py",
        submodule_search_locations=[str(ROOT)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {ROOT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    spec.loader.exec_module(module)
    return module


load_plugin()
tools = sys.modules[f"{PACKAGE}.tools"]
hooks = sys.modules[f"{PACKAGE}.hooks"]
commands = sys.modules[f"{PACKAGE}.commands"]
client = sys.modules[f"{PACKAGE}.client"]
bundle = sys.modules[f"{PACKAGE}.bundle"]
plane_mod = sys.modules[f"{PACKAGE}.plane"]
settings_mod = sys.modules[f"{PACKAGE}.settings"]


class FakeClient:
    def __init__(self, routes=None, error=None):
        self.routes = routes or {}
        self.error = error
        self.calls = []
        self.base_url = "http://127.0.0.1:4310"
        self.timeout = 5
        self.token = ""

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if self.error is not None:
            raise self.error
        return self.routes.get((method, path.split("?", 1)[0]), [])

    def health(self):
        return self.request("GET", "/health")


class Memory:
    def __init__(self):
        self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value


def make_plane(fake, **overrides):
    values = {
        "api_url": "http://127.0.0.1:4310",
        "token": "",
        "workspace_id": "demo-workspace",
        "project_id": "eventforge-demo-service",
        "auto_start": False,
        "timeout": 5,
        "bundle_path": "",
        "fail_closed": False,
    }
    values.update(overrides)
    return plane_mod.Plane(client=fake, settings=settings_mod.Settings(**values))
