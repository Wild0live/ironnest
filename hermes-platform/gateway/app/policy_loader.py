"""Policy loader.

Reads policies/<name>.policy.yaml files, validates each against
spec/policies.schema.json, and returns an in-memory map. Used at startup
and on POST /admin/reload-policies.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator


class PolicyLoadError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ProfilePolicy:
    profile: str
    read_allow:  tuple[str, ...]
    read_deny:   tuple[str, ...]
    write_allow: tuple[str, ...]
    write_deny:  tuple[str, ...]
    description: str = ""


def load_policies(policies_dir: Path, schema_file: Path | None = None) -> dict[str, ProfilePolicy]:
    if not policies_dir.is_dir():
        raise PolicyLoadError(f"policies directory not found: {policies_dir}")

    schema_validator = None
    if schema_file is not None and schema_file.is_file():
        schema = json.loads(schema_file.read_text(encoding="utf-8"))
        schema_validator = Draft202012Validator(schema)

    out: dict[str, ProfilePolicy] = {}
    for path in sorted(policies_dir.glob("*.policy.yaml")):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as e:
            raise PolicyLoadError(f"{path}: invalid YAML: {e}") from e

        if data is None:
            raise PolicyLoadError(f"{path}: file is empty")

        if schema_validator is not None:
            schema_validator.validate(data)

        name = data["profile"]
        if name in out:
            raise PolicyLoadError(f"duplicate profile {name!r} in policies dir")

        out[name] = ProfilePolicy(
            profile=name,
            read_allow=tuple(data.get("read", {}).get("allow", [])),
            read_deny=tuple(data.get("read", {}).get("deny", [])),
            write_allow=tuple(data.get("write", {}).get("allow", [])),
            write_deny=tuple(data.get("write", {}).get("deny", [])),
            description=data.get("description", ""),
        )
    return out
