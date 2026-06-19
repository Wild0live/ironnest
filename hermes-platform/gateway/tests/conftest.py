"""Pytest fixtures shared across the gateway test suite.

Loads the REAL policy files and registry from the repo's policies/ and
registry/ directories — so regressions there are caught by unit tests
before they hit production. Validates against the JSON Schemas too.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

# Make `app.*` importable from gateway/tests/
HERE = Path(__file__).resolve().parent
GATEWAY = HERE.parent
STACK = GATEWAY.parent
sys.path.insert(0, str(GATEWAY))


@pytest.fixture(scope="session")
def stack_root() -> Path:
    return STACK


@pytest.fixture(scope="session")
def policies_dir(stack_root: Path) -> Path:
    return stack_root / "policies"


@pytest.fixture(scope="session")
def registry_file(stack_root: Path) -> Path:
    return stack_root / "registry" / "profiles-registry.yaml"


@pytest.fixture(scope="session")
def policies_schema(stack_root: Path) -> Path:
    return stack_root / "spec" / "policies.schema.json"


@pytest.fixture(scope="session")
def registry_schema(stack_root: Path) -> Path:
    return stack_root / "spec" / "registry.schema.json"


@pytest.fixture(scope="session")
def policies(policies_dir, policies_schema):
    from app.policy_loader import load_policies
    return load_policies(policies_dir, policies_schema)


@pytest.fixture(scope="session")
def registry(registry_file, registry_schema):
    from app.registry import load_registry
    return load_registry(registry_file, registry_schema)


@pytest.fixture(scope="session")
def profile_names(registry) -> list[str]:
    return registry.names()


@pytest.fixture
def app_env(monkeypatch, tmp_path, stack_root, profile_names):
    """Set the env the gateway app expects, into temp paths."""
    monkeypatch.setenv("MEMORY_GATEWAY_POLICIES_DIR",         str(stack_root / "policies"))
    monkeypatch.setenv("MEMORY_GATEWAY_REGISTRY_FILE",        str(stack_root / "registry" / "profiles-registry.yaml"))
    monkeypatch.setenv("MEMORY_GATEWAY_POLICIES_SCHEMA_FILE", str(stack_root / "spec" / "policies.schema.json"))
    monkeypatch.setenv("MEMORY_GATEWAY_REGISTRY_SCHEMA_FILE", str(stack_root / "spec" / "registry.schema.json"))
    monkeypatch.setenv("MEMORY_GATEWAY_AUDIT_LOG",            str(tmp_path / "audit.log"))
    monkeypatch.setenv("MEMORY_GATEWAY_DRY_RUN",              "true")
    tokens = {name: f"{i:064x}" for i, name in enumerate(profile_names)}
    monkeypatch.setenv("MEMORY_GATEWAY_PROFILE_TOKENS_JSON", json.dumps(tokens))
    monkeypatch.setenv("MEMORY_GATEWAY_ADMIN_TOKEN", "f" * 64)
    # Bust the lru-cache-like global in config.get_settings()
    import app.config as _cfg
    _cfg._settings = None
    return tokens
