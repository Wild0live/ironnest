"""Settings loader.

All gateway tunables come from environment variables (set in
docker-compose.yml or by the with-infisical wrapper). Secrets like the
profile bearer-token map come from Infisical at startup; see
auth.load_token_map().
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration. Loaded once at startup; immutable after.

    Override any field via env var with the MEMORY_GATEWAY_ prefix:
        MEMORY_GATEWAY_OPENVIKING_URL=http://openviking:1933
    """

    model_config = SettingsConfigDict(
        env_prefix="MEMORY_GATEWAY_",
        env_file=None,  # we get env from with-infisical, not .env files
        extra="ignore",
    )

    # ── Listener ────────────────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8080

    # ── OpenViking adapter ──────────────────────────────────────────────────
    openviking_url: str = "http://openviking:1933"
    openviking_timeout_seconds: float = 30.0
    # Bearer token sent on every OpenViking request when set. OpenViking's
    # server.root_api_key (in ov.conf) enforces this. Loaded from Infisical
    # /hermes-platform/gateway → OPENVIKING_API_KEY via with-infisical.
    openviking_api_key: str | None = None
    # When true, the adapter never calls OpenViking; returns plausible JSON.
    # Used for offline tests of the policy engine.
    dry_run: bool = False

    # ── Config file paths (inside the container) ────────────────────────────
    policies_dir: Path = Path("/etc/hermes-platform/policies")
    registry_file: Path = Path("/etc/hermes-platform/registry/profiles-registry.yaml")
    policies_schema_file: Path = Path("/etc/hermes-platform/spec/policies.schema.json")
    registry_schema_file: Path = Path("/etc/hermes-platform/spec/registry.schema.json")
    namespaces_map_file: Path = Path("/etc/hermes-platform/spec/namespaces.yaml")

    # ── Audit ──────────────────────────────────────────────────────────────
    audit_log: Path = Path("/var/log/gateway/audit.log")
    audit_to_stderr: bool = True  # mirror to stderr so Dozzle/fluent-bit see it

    # ── Rate limiting (per profile, token bucket) ───────────────────────────
    rate_capacity: int = Field(default=120, description="Tokens per bucket")
    rate_refill_per_sec: float = Field(default=2.0, description="Tokens added per second")

    # ── Admin endpoint protection ───────────────────────────────────────────
    # Static admin shared-secret. Set via Infisical
    # /hermes-platform/gateway → MEMORY_GATEWAY_ADMIN_TOKEN.
    admin_token: str | None = None

    # ── Bearer-token map for profile auth ───────────────────────────────────
    # Loaded from Infisical /hermes-platform/gateway → MEMORY_GATEWAY_PROFILE_TOKENS,
    # which is a JSON object `{"<profile-name>": "<bearer-token>", ...}`.
    # Parsed by auth.load_token_map(); see docs/04-CONFIGURATION.md.
    profile_tokens_json: str | None = None


_settings: Settings | None = None


def get_settings() -> Settings:
    """Cache-once settings accessor."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
