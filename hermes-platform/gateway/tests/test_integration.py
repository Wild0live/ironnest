"""HTTP-level integration test using FastAPI's TestClient.

Boots the FastAPI app with the real policies/registry/schemas and the
OpenViking adapter in dry_run, then exercises /health, /memory/read,
/memory/write, and the admin endpoints end-to-end.

If this test ever passes when isolation is broken, the unit tests are
missing a case — investigate.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(app_env, profile_names):
    """app_env fixture (in conftest.py) sets the env vars before import.

    Use TestClient as a context manager so FastAPI's lifespan startup
    runs — that's what loads policies/registry/auth-token-map. Without
    `with`, the app boots with empty state and every request 401s.
    """
    import importlib
    import app.config
    app.config._settings = None        # bust the cached settings singleton
    import app.main
    importlib.reload(app.main)         # rebuild the app object with the new env
    with TestClient(app.main.app) as c:
        yield c


def _bearer(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_health(client, app_env):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["policies_loaded"] >= 5
    assert body["dry_run"] is True


def test_read_own_namespace(client, app_env):
    tok = app_env["mark"]
    r = client.post("/memory/read",
                    headers=_bearer(tok),
                    json={"uri": "viking://profiles/mark/notes"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


def test_read_other_profile_denied(client, app_env):
    tok = app_env["mark"]
    r = client.post("/memory/read",
                    headers=_bearer(tok),
                    json={"uri": "viking://profiles/steve/notes"})
    assert r.status_code == 403, r.text


def test_write_own_approved_allowed(client, app_env):
    tok = app_env["mark"]
    r = client.post("/memory/write",
                    headers=_bearer(tok),
                    json={"uri": "viking://shared/approved/mark/x", "content": "hi"})
    assert r.status_code == 200, r.text


def test_write_other_approved_denied(client, app_env):
    tok = app_env["mark"]
    r = client.post("/memory/write",
                    headers=_bearer(tok),
                    json={"uri": "viking://shared/approved/steve/x", "content": "hi"})
    assert r.status_code == 403, r.text


def test_path_traversal_denied(client, app_env):
    tok = app_env["mark"]
    r = client.post("/memory/read",
                    headers=_bearer(tok),
                    json={"uri": "viking://profiles/mark/../../etc/passwd"})
    assert r.status_code == 403, r.text


def test_publish_approved_enforces_target_prefix(client, app_env):
    """publish-approved MUST refuse a target outside viking://shared/approved/<caller>/."""
    tok = app_env["mark"]
    r = client.post("/memory/publish-approved",
                    headers=_bearer(tok),
                    json={
                        "source_uri": "viking://profiles/mark/notes/draft",
                        "target_uri": "viking://shared/approved/steve/x",
                        "rationale":  "should fail",
                    })
    assert r.status_code == 403, r.text


def test_missing_bearer_401(client, app_env):
    r = client.post("/memory/read",
                    json={"uri": "viking://shared/org"})
    assert r.status_code == 401, r.text


def test_unknown_bearer_401(client, app_env):
    # The conftest mints profile tokens as f"{i:064x}" for i in 0..N-1.
    # "9"*64 is outside that range and outside the admin token ("f"*64).
    unknown = "9" * 64
    assert unknown not in app_env.values()  # sanity-check the fixture
    r = client.post("/memory/read",
                    headers=_bearer(unknown),
                    json={"uri": "viking://shared/org"})
    assert r.status_code == 401, r.text


def test_admin_profiles_requires_admin_token(client, app_env):
    r = client.get("/admin/profiles", headers=_bearer(app_env["mark"]))
    assert r.status_code == 401   # profile token can't reach admin
    r2 = client.get("/admin/profiles", headers=_bearer("f" * 64))
    assert r2.status_code == 200
    assert "profiles" in r2.json()


def test_admin_reload_policies(client, app_env):
    r = client.post("/admin/reload-policies", headers=_bearer("f" * 64))
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["policies_loaded"] >= 5
