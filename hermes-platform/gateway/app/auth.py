"""Bearer-token → profile identity.

The token-to-profile map is loaded once at startup from the env var
`MEMORY_GATEWAY_PROFILE_TOKENS_JSON` (set by Infisical via
with-infisical). Compare in constant time to avoid timing-side-channel
profile enumeration.

A second env var `MEMORY_GATEWAY_ADMIN_TOKEN` protects /admin/*.
"""

from __future__ import annotations

import hmac
import json
import secrets
from dataclasses import dataclass

from fastapi import Header, HTTPException, status

from .config import Settings, get_settings


class AuthError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class CallerIdentity:
    profile: str
    is_admin: bool = False


_TOKEN_TO_PROFILE: dict[str, str] = {}
_ADMIN_TOKEN: str | None = None


def load_token_map(settings: Settings | None = None) -> None:
    """Parse profile_tokens_json into the in-memory map.

    Called from main.py's lifespan startup. Idempotent.
    """
    global _TOKEN_TO_PROFILE, _ADMIN_TOKEN
    s = settings or get_settings()

    new_map: dict[str, str] = {}
    if s.profile_tokens_json:
        try:
            raw = json.loads(s.profile_tokens_json)
        except json.JSONDecodeError as e:
            raise AuthError(f"MEMORY_GATEWAY_PROFILE_TOKENS_JSON is not valid JSON: {e}") from e
        if not isinstance(raw, dict):
            raise AuthError("MEMORY_GATEWAY_PROFILE_TOKENS_JSON must be a JSON object")
        for profile, token in raw.items():
            if not isinstance(profile, str) or not isinstance(token, str):
                raise AuthError("token map entries must be string→string")
            if len(token) < 32:
                raise AuthError(
                    f"token for profile {profile!r} is too short "
                    f"(min 32 chars; generate with `openssl rand -hex 32`)"
                )
            new_map[token] = profile

    _TOKEN_TO_PROFILE = new_map
    _ADMIN_TOKEN = s.admin_token


def _extract_bearer(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing Authorization header")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="malformed Authorization header")
    return parts[1].strip()


def require_profile_token(authorization: str | None = Header(default=None)) -> CallerIdentity:
    """FastAPI dependency: resolve bearer token → CallerIdentity(profile=...)."""
    token = _extract_bearer(authorization)
    # Constant-time lookup. We can't index a dict in constant time, so we
    # iterate every entry and hmac.compare_digest each one.
    for candidate_token, profile in _TOKEN_TO_PROFILE.items():
        if hmac.compare_digest(token, candidate_token):
            return CallerIdentity(profile=profile, is_admin=False)
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unknown bearer token")


def require_admin_token(authorization: str | None = Header(default=None)) -> CallerIdentity:
    """FastAPI dependency: only the admin shared secret may pass."""
    token = _extract_bearer(authorization)
    if not _ADMIN_TOKEN:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="admin token not configured")
    if not hmac.compare_digest(token, _ADMIN_TOKEN):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid admin token")
    return CallerIdentity(profile="<admin>", is_admin=True)


def generate_token() -> str:
    """Helper used by scripts/rotate-profile-token.sh to mint new tokens."""
    return secrets.token_hex(32)
