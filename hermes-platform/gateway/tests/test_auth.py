"""Tests for gateway/app/auth.py — bearer-token resolution + admin gate."""

from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

import app.auth as auth_mod
from app.auth import (
    AuthError,
    generate_token,
    load_token_map,
    require_admin_token,
    require_profile_token,
)
from app.config import Settings


def _settings_with(tokens: dict[str, str], admin: str | None = None) -> Settings:
    """Build a Settings without mutating the global cache."""
    return Settings(
        profile_tokens_json=json.dumps(tokens),
        admin_token=admin,
    )


def test_generate_token_length():
    t = generate_token()
    assert len(t) == 64
    assert all(c in "0123456789abcdef" for c in t)


def test_load_token_map_populates():
    tokens = {"mark": "a" * 64, "steve": "b" * 64}
    load_token_map(_settings_with(tokens, admin="c" * 64))
    # round-trip via the public function
    ident = require_profile_token(authorization="Bearer " + "a" * 64)
    assert ident.profile == "mark"


def test_load_token_map_rejects_short_token():
    with pytest.raises(AuthError, match="too short"):
        load_token_map(_settings_with({"mark": "short"}))


def test_require_profile_token_rejects_missing_header():
    load_token_map(_settings_with({"mark": "a" * 64}))
    with pytest.raises(HTTPException) as ei:
        require_profile_token(authorization=None)
    assert ei.value.status_code == 401


def test_require_profile_token_rejects_malformed_header():
    load_token_map(_settings_with({"mark": "a" * 64}))
    for bad in ["bearer", "Bearer", "Bearer ", "Basic xyz", ""]:
        with pytest.raises(HTTPException) as ei:
            require_profile_token(authorization=bad)
        assert ei.value.status_code == 401


def test_require_profile_token_rejects_unknown_token():
    load_token_map(_settings_with({"mark": "a" * 64}))
    with pytest.raises(HTTPException) as ei:
        require_profile_token(authorization="Bearer " + "z" * 64)
    assert ei.value.status_code == 401


def test_require_admin_token_happy():
    load_token_map(_settings_with({}, admin="c" * 64))
    ident = require_admin_token(authorization="Bearer " + "c" * 64)
    assert ident.is_admin
    assert ident.profile == "<admin>"


def test_require_admin_token_rejects_wrong():
    load_token_map(_settings_with({}, admin="c" * 64))
    with pytest.raises(HTTPException) as ei:
        require_admin_token(authorization="Bearer " + "d" * 64)
    assert ei.value.status_code == 401


def test_require_admin_token_503_when_unconfigured():
    load_token_map(_settings_with({}, admin=None))
    with pytest.raises(HTTPException) as ei:
        require_admin_token(authorization="Bearer " + "x" * 64)
    assert ei.value.status_code == 503
