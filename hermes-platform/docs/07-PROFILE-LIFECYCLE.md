# 07 — Profile Lifecycle

## Create

```bash
bash scripts/create-profile.sh <name>
```

Idempotent steps:

1. Renders `policies/<name>.policy.yaml` from `profile-template/policy.yaml.template`.
2. Appends an entry to `registry/profiles-registry.yaml` (via `yq`).
3. Creates the named volume `hermes-platform_data-<name>` (no-op if it exists).
4. Seeds `SOUL.md`, `USER.md`, `MEMORY.md`, `tools.yaml` from templates with `<PROFILE-NAME>` substitutions.
5. `chown 10000:10000 /opt/data; chmod 0700 /opt/data` inside the seed pass.
6. If the gateway is up and `MEMORY_GATEWAY_ADMIN_TOKEN` is in env → calls `/admin/reload-policies`.

Manual follow-up the script prints:

- Add bearer token to Infisical (two places — `MEMORY_GATEWAY_PROFILE_TOKENS_JSON` and per-profile folder).
- Add a service block to `docker-compose.yml` (clone an existing `hermes-pf-<other>` block).
- `docker compose up -d hermes-pf-<name>`.

## Validate

```bash
bash scripts/validate-profile.sh <name>
```

Checks: policy file present and parseable; registry entry with matching namespace; container exists; data volume exists; gateway `/admin/profiles` lists the profile.

## Rotate token

```bash
bash scripts/rotate-profile-token.sh <name>
```

Prints a new 64-char hex token. Operator pastes it in two Infisical places, then `docker compose restart memory-gateway hermes-pf-<name>`.

## Delete

```bash
bash scripts/delete-profile.sh <name> [--purge-volume]
```

Default: removes container, registry entry, policy file. Keeps the volume. Add `--purge-volume` to also `docker volume rm hermes-platform_data-<name>` — destructive.

After delete, also clean Infisical:
1. Remove the profile's entry from `MEMORY_GATEWAY_PROFILE_TOKENS_JSON`.
2. Optionally delete the `/hermes-platform/<name>/` folder.
3. `POST /admin/reload-policies`.

## Migrate from existing hermes-data volume

```bash
bash scripts/migrate-from-shared-volume.sh --dry-run   # preview
bash scripts/migrate-from-shared-volume.sh             # do it
```

Copies per-profile subtrees from `hermes_hermes-data` into each new `hermes-platform_data-<name>` volume. Verifies SHA-256 sums; non-zero exit on any mismatch.

Source path mapping:
- `/opt/data/SOUL.md`, `/opt/data/memories/`, `/opt/data/sessions/`, … → goes to `hermes-platform_data-default`
- `/opt/data/profiles/<name>/` → goes to `hermes-platform_data-<name>`

The source volume is mounted **read-only**. Re-runnable; rsync `--delete-excluded` keeps the destination in sync.

## Patch SOUL.md with the OpenViking Memory Policy section

```bash
bash scripts/patch-souls.sh --dry-run                  # preview diff
bash scripts/patch-souls.sh                            # write
bash scripts/patch-souls.sh --profile mark             # one profile
```

Idempotent. Backs up `SOUL.md → SOUL.md.bak.<epoch>` before mutating. Replaces ONLY the `## OpenViking Memory Policy` section (from heading to next `## ` or EOF). Re-running with no template change is a no-op (still produces the timestamped backup).

## Backup SOULs

```bash
bash scripts/backup-souls.sh                           # all
bash scripts/backup-souls.sh --profile mark            # one
```

Creates `SOUL.md.bak.<epoch>` for each profile's volume. Useful before any persona update.
