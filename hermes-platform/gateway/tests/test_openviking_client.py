"""Tests for the OpenViking adapter — namespace translation + dry-run."""

from __future__ import annotations

import asyncio

import pytest

from app.openviking_client import OpenVikingClient, from_native_uri, to_native_uri


# ─── Namespace translation round-trips ──────────────────────────────────────

@pytest.mark.parametrize("logical,native", [
    ("viking://shared/org",                 "viking://resources/shared/org"),
    ("viking://shared/org/sub",             "viking://resources/shared/org/sub"),
    ("viking://shared/approved/mark/x",     "viking://resources/shared/approved/mark/x"),
    ("viking://profiles/mark/notes",        "viking://resources/profiles/mark/notes"),
    ("viking://profiles/mark/notes/a/b",    "viking://resources/profiles/mark/notes/a/b"),
])
def test_to_native_round_trip(logical, native):
    assert to_native_uri(logical) == native
    assert from_native_uri(native) == logical


def test_from_native_rejects_non_resources():
    with pytest.raises(ValueError):
        from_native_uri("viking://user/foo")


# ─── Dry-run client ────────────────────────────────────────────────────────

@pytest.fixture
def dry_client():
    return OpenVikingClient(base_url="http://nowhere", dry_run=True)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


def test_dry_status(dry_client):
    r = _run(dry_client.status())
    assert r.ok
    assert r.data.get("status") == "dry_run"


def test_dry_read(dry_client):
    r = _run(dry_client.read("viking://profiles/mark/notes"))
    assert r.ok
    assert r.data["uri"]         == "viking://profiles/mark/notes"
    assert r.data["native_uri"]  == "viking://resources/profiles/mark/notes"


def test_dry_write(dry_client):
    r = _run(dry_client.write("viking://shared/approved/mark/x", "hello", {"src": "test"}))
    assert r.ok
    assert r.status == 201
    assert r.data["stored"] is True


def test_dry_find(dry_client):
    r = _run(dry_client.find("anything"))
    assert r.ok
    assert "results" in r.data


def test_dry_list(dry_client):
    r = _run(dry_client.list("viking://shared/"))
    assert r.ok
    assert "children" in r.data
