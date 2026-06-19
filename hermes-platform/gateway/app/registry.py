"""Profile registry — loaded from registry/profiles-registry.yaml.

Schema enforced by spec/registry.schema.json. Reload via
POST /admin/reload-policies (which also reloads policies).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator


class RegistryError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ProfileEntry:
    name: str                                  # canonical profile name (matches policy filename)
    namespace: str                             # e.g. "viking://profiles/mark/"
    approved_shared_namespace: str             # e.g. "viking://shared/approved/mark/"
    container_name: str                        # e.g. "hermes-pf-mark"
    status: str                                # "enabled" | "disabled" | "draft"
    policy_file: str                           # filename under policies/
    created_at: str                            # ISO 8601
    tags: tuple[str, ...] = field(default=())
    notes: str = ""


@dataclass(frozen=True, slots=True)
class Registry:
    profiles: dict[str, ProfileEntry]

    def get(self, name: str) -> ProfileEntry | None:
        return self.profiles.get(name)

    def names(self) -> list[str]:
        return sorted(self.profiles.keys())


def load_registry(registry_file: Path, schema_file: Path | None = None) -> Registry:
    """Load and validate the profiles-registry.yaml file."""
    if not registry_file.is_file():
        raise RegistryError(f"registry file not found: {registry_file}")
    data = yaml.safe_load(registry_file.read_text(encoding="utf-8"))
    if data is None:
        raise RegistryError(f"registry file is empty: {registry_file}")

    if schema_file is not None and schema_file.is_file():
        schema = json.loads(schema_file.read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(data)

    profiles = {}
    for entry in data.get("profiles", []):
        name = entry["name"]
        profiles[name] = ProfileEntry(
            name=name,
            namespace=entry["namespace"],
            approved_shared_namespace=entry["approved_shared_namespace"],
            container_name=entry["container_name"],
            status=entry.get("status", "enabled"),
            policy_file=entry["policy_file"],
            created_at=entry["created_at"],
            tags=tuple(entry.get("tags", [])),
            notes=entry.get("notes", ""),
        )
    return Registry(profiles=profiles)
