# 10 — Validation and Testing

## Cross-stack smoke test

```bash
bash scripts/healthcheck.sh
```

Asserts:
- platform-net + platform-egress exist.
- All platform containers are healthy, including every registered `hermes-pf-*` profile.
- `GET http://127.0.0.1:18080/health` returns 200.
- openviking publishes no host port (`docker port hermes-platform-openviking` is empty).
- openviking is unreachable from `hermes-pf-mark`.

## Automatic conversational memory

```bash
bash scripts/validate-conversational-memory.sh
```

For each running registered profile, this test loads the same `ironnest_gateway` Hermes provider used during normal conversations and invokes its automatic `sync_turn` lifecycle hook. It then reads the stored turn back through the policy gateway. A pass proves:

- the profile can discover and initialize the provider;
- the automatic conversation write path calls `memory-gateway`;
- the memory persists in that profile's permitted namespace.

This test does not require an LLM credential. To prove real pre-answer recall for a profile with model credentials, store a distinctive phrase in one chat and request it in a later chat, then confirm the response and corresponding gateway audit events.

## Isolation cases

```bash
bash scripts/validate-isolation.sh
```

Runs the case matrix in `spec/validation-plan.yaml § runs[1].cases`. For every profile pair (A, B) with A ≠ B:

- A reads `viking://profiles/A/notes` → 200
- A reads `viking://shared/org`       → 200
- A writes `viking://shared/approved/A/<ts>` → 200
- A reads `viking://profiles/B/notes` → **403**
- A writes `viking://profiles/B/notes` → **403**
- A writes `viking://shared/approved/B/x` → **403**
- A reads with a `..` traversal URI → **403**
- openviking unreachable from container A → **000**

Exit 0 if all pass; non-zero on any regression.

## Sharing cases

```bash
bash scripts/validate-sharing.sh
```

For every (A, B) pair:
- A writes `viking://shared/approved/A/published-<ts>` → 200
- B reads that URI → 200
- A's `/memory/publish-approved` call promotes private → approved → 200

## Profile-level validation

```bash
bash scripts/validate-profile.sh <name>
```

Confirms: policy file exists and matches; registry entry with correct namespace; container exists; volume exists; gateway `/admin/profiles` lists the profile.

## Audit log inspection

```bash
docker exec hermes-platform-memory-gateway \
    cat /var/log/gateway/audit.log | jq 'select(.decision == "deny")'
```

Every deny event includes the matched rule (or absence thereof). After a `validate-isolation` run, expect to see many `decision=deny` entries with `matched_rule` set.

## Unit + integration tests for the gateway

`gateway/tests/` ships with v0.1.0. **178 tests, runtime <1 second.**

```bash
# In a clean container (matches CI):
docker run --rm -v "$(pwd):/work:ro" python:3.13-slim bash -c "
  pip install -q -r /work/gateway/requirements.txt pytest &&
  mkdir -p /tmp/wk && cp -r /work/gateway /work/policies /work/registry /work/spec /tmp/wk/ &&
  cd /tmp/wk/gateway && pytest tests/ -v
"
```

Or from a venv on the host:

```bash
cd gateway
pip install -r requirements.txt pytest
pytest tests/ -v
```

Test files (all under `gateway/tests/`):

| File | Coverage |
|---|---|
| `test_namespace.py` | `parse_uri()` happy + sad paths (including traversal, control chars, bad scheme); `matches_glob()` for every glob token (`*`, `**`, `?`) |
| `test_policy.py` | For every registered profile, end-to-end policy decisions for own-namespace ALLOW plus the full cross-profile DENY and approved-sharing matrix (8 profiles; 337 total gateway tests as of 2026-07-11) |
| `test_openviking_client.py` | Namespace translation round-trips (`viking://shared/X` ↔ `viking://resources/shared/X`); dry-run adapter calls |
| `test_auth.py` | Bearer-token map loading, missing/malformed/unknown header rejection, admin token rejection, 503 when admin token not configured |
| `test_integration.py` | FastAPI TestClient end-to-end: `/health`, `/memory/{read,write,publish-approved}`, `/admin/{reload-policies,profiles}`. Confirms 401/403/200 status codes match policy decisions |

**The gateway integration suite is the canonical guarantee** for the policy and isolation invariants (I1-I5 in `spec/system.manifest.yaml`). If any test ever fails, do NOT ship.

## Governed administration tests

Run the focused standard-library suites after changing Mission Control approval identity, WebAuthn ownership, Octo admin sessions, or runner eligibility:

```bash
python -m unittest discover -s mission-control/tests -v
python -m unittest discover -s operations-runner/tests -v
```

These suites cover Authelia cookie revalidation, operator-bound WebAuthn credentials, required user verification, the single active-session rule, expiry, explicit enrollment, protected labels/names, Docker-socket exclusion, and destructive-action step-up. Run them in environments containing each service's pinned requirements, such as the corresponding built image or an isolated test environment.

The runtime conversational-memory validator is the canonical proof for I6: that normal Hermes memory is wired through `ironnest_gateway` to `memory-gateway`, rather than merely having reachable gateway connectivity.

## Manual probe (curl from host)

You can hit the gateway's diagnostic port from the host with the admin token (per-profile tokens are restricted to internal hermes-platform-app-net by design).

```bash
TOKEN="$(infisical secrets get MEMORY_GATEWAY_ADMIN_TOKEN --path=/hermes-platform/gateway --plain)"
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18080/admin/profiles | jq .
```
