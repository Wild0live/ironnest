# Wazuh ↔ Authelia OIDC SSO — rollout playbook

**Goal:** put the Wazuh dashboard behind the same FIDO/passkey gate as every
other `*.ironnest.local` route, **without** breaking the SPA the way ForwardAuth
did (see `memory/project_wazuh_authelia_deferred.md`). The dashboard handles
the OIDC redirect itself, so XHR never gets a 302-to-HTML mid-session.

**Why this is not a 5-minute change:** OIDC spans two stacks. Authelia gains
an OP role (HMAC secret + JWKS signing key + client registration). Wazuh's
indexer must validate ID tokens (network reach + CA trust to
`auth.ironnest.local`). The dashboard's SPA stays untouched but its
OpenSearch Security plugin needs a new auth config that must be pushed via
`securityadmin.sh` after every edit. The OIDC client secret needs to live in
Infisical and be rendered into both stacks.

## Status

**OIDC SSO went live 2026-05-28.** Wazuh is reachable only at `https://wazuh.ironnest.local/`
and authenticates via OpenID Connect against Authelia; the legacy `127.0.0.1:8443`
loopback hatch was closed and the ForwardAuth carve-out is gone. The live wiring:
`ingress-infisical-agent` renders `oidc-snippet.yml` into `ingress_oidc-secrets`,
Authelia merges it via `--config=/oidc-secrets/oidc-snippet.yml`, `wazuh-infisical-agent`
renders the raw client secret into the dashboard keystore, the dashboard mounts
`opensearch_dashboards.yml.oidc`, and Traefik carries a `platform-net` alias
`auth.ironnest.local` so the indexer/dashboard can reach OIDC discovery + JWKS inside
the Docker network.

| Phase | Description | State |
|-------|-------------|-------|
| 1 | Draft artifacts written (config.yml, roles_mapping.yml, opensearch_dashboards.yml.oidc, this doc) | ✅ done |
| 2 | Bootstrap Infisical secrets (`AUTHELIA_OIDC_HMAC`, `AUTHELIA_OIDC_JWKS_PRIVATE_KEY`, `WAZUH_OIDC_CLIENT_SECRET`, `WAZUH_OIDC_CLIENT_SECRET_HASH`) | ✅ done |
| 3 | Agent-config trees for `ingress/` and `wazuh/` sidecars; dashboard prestart hooks (CA bundle + keystore load) | ✅ done |
| 4 | Apply live edits to Authelia config + ingress compose | ✅ done |
| 5 | Apply live edits to Wazuh compose; push security config via `securityadmin.sh` | ✅ done |
| 6 | Re-enable the Authelia ForwardAuth router as defence-in-depth (optional) | ⏳ not enabled (Wazuh router uses `[trusted-networks, spa-rate-limit]`; OIDC is the gate) |

> The Phase 4/5 instructions below described the inline-`clients:` approach; the
> implementation instead renders the full OIDC block (HMAC + JWKS + client) into
> `oidc-snippet.yml` and merges it with a second `--config` flag. Treat the prose
> below as historical design notes, not the live config.

Phase 3 artifacts written:
- `security/ingress/agent-config/{agent.yaml, entrypoint.sh, oidc-hmac.tmpl, oidc-jwks.tmpl, oidc-clients.tmpl, .gitignore}`
- `security/wazuh/agent-config/{agent.yaml, entrypoint.sh, secrets.tmpl, .gitignore}`
- `security/wazuh/config/wazuh_dashboard/{prestart.sh, build-ca-bundle.sh, load-oidc-keystore.sh}`
- `.env.example` updated in both stacks with `INFISICAL_UNIVERSAL_AUTH_*` vars

All Phase 3 files are **inert** — none are referenced by any running compose yet. They become live in Phase 4/5.

---

## Phase 2 — bootstrap secrets in Infisical

In the Infisical UI (`https://infisical.ironnest.local`), create three secrets
in the same project/environment used by the OpenClaw + Hermes stacks. Use
`/wazuh-oidc/` as the path so they're easy to template in the agent renders.

```bash
# 1. Authelia OIDC HMAC secret (≥64 random chars).
openssl rand -hex 48
# → store as /wazuh-oidc/AUTHELIA_OIDC_HMAC

# 2. Authelia OIDC JWKS signing key (RSA 2048 PEM, single line via \n).
openssl genrsa 2048
# → store as /wazuh-oidc/AUTHELIA_OIDC_JWKS_PRIVATE_KEY (paste full PEM)

# 3. Wazuh OIDC client secret (≥32 random chars; Authelia hashes server-side).
openssl rand -hex 24
# → store as /wazuh-oidc/WAZUH_OIDC_CLIENT_SECRET
```

Authelia also expects the **PBKDF2** hash of the client secret in its config.
Generate it with the `authelia` CLI inside the already-running container:

```bash
docker exec -it authelia authelia crypto hash generate pbkdf2 \
  --variant sha512 --iterations 310000 \
  --password "$WAZUH_OIDC_CLIENT_SECRET"
# → store the resulting $pbkdf2-sha512$... string as
#   /wazuh-oidc/WAZUH_OIDC_CLIENT_SECRET_HASH
```

---

## Phase 3 — Infisical agent sidecars

Create the agent-config trees under each stack so the templates can render the
new secrets into the right places at startup.

### `security/ingress/agent-config/` (NEW)

`agent.yaml`:
```yaml
infisical:
  address: "http://infisical:8090"
auth:
  type: "universal-auth"
  config:
    client-id: "/tmp/client-id"
    client-secret: "/tmp/client-secret"
sinks:
  - type: "file"
    config:
      path: "/secrets/agent-token"
templates:
  - source-path: "/agent-config/oidc-hmac.tmpl"
    destination-path: "/secrets/oidc-hmac.txt"
    config: { polling-interval: "60s" }
  - source-path: "/agent-config/oidc-jwks.tmpl"
    destination-path: "/secrets/oidc-jwks.pem"
    config: { polling-interval: "60s" }
  - source-path: "/agent-config/oidc-clients.tmpl"
    destination-path: "/secrets/oidc-clients.yml"
    config: { polling-interval: "60s" }
```

`oidc-hmac.tmpl`:
```
{{ with secret "<INFISICAL_PROJECT_UUID>" "prod" "/wazuh-oidc/AUTHELIA_OIDC_HMAC" }}{{ .Value }}{{ end }}
```

`oidc-jwks.tmpl`:
```
{{ with secret "<INFISICAL_PROJECT_UUID>" "prod" "/wazuh-oidc/AUTHELIA_OIDC_JWKS_PRIVATE_KEY" }}{{ .Value }}{{ end }}
```

`oidc-clients.tmpl` (rendered as a partial Authelia config snippet that gets
merged via the multi-file include — see Phase 4):
```yaml
- client_id: wazuh
  client_name: Wazuh SIEM Dashboard
  client_secret: '{{ with secret "<INFISICAL_PROJECT_UUID>" "prod" "/wazuh-oidc/WAZUH_OIDC_CLIENT_SECRET_HASH" }}{{ .Value }}{{ end }}'
  public: false
  authorization_policy: one_factor
  consent_mode: implicit
  redirect_uris:
    - https://wazuh.ironnest.local/auth/openid/login
  scopes:
    - openid
    - profile
    - email
    - groups
  userinfo_signed_response_alg: none
  token_endpoint_auth_method: client_secret_basic
```

`entrypoint.sh`:
```sh
#!/bin/sh
set -e
printf '%s' "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"     > /tmp/client-id
printf '%s' "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" > /tmp/client-secret
exec infisical agent --config /agent-config/agent.yaml
```

### `security/wazuh/agent-config/` (NEW)

Same shape. Only template needed:

`secrets.tmpl`:
```
WAZUH_OIDC_CLIENT_SECRET={{ with secret "<INFISICAL_PROJECT_UUID>" "prod" "/wazuh-oidc/WAZUH_OIDC_CLIENT_SECRET" }}{{ .Value }}{{ end }}
```

---

## Phase 4 — Authelia + ingress compose edits

### `security/ingress/docker-compose.yml`

Add the sidecar and a shared volume; wire Authelia to depend on it.

```yaml
volumes:
  ingress-secrets-runtime:        # NEW — populated by infisical-agent

services:
  ingress-infisical-agent:        # NEW
    build: { context: ../../openclaw, dockerfile: Dockerfile.infisical-cli }
    image: platform/infisical-cli:0.43.76-patched
    container_name: ingress-infisical-agent
    restart: unless-stopped
    entrypoint: ["sh", "/agent-config/entrypoint.sh"]
    env_file: ./.env
    volumes:
      - ./agent-config:/agent-config:ro
      - ingress-secrets-runtime:/secrets
    tmpfs: [ "/tmp:size=1m,mode=0700" ]
    networks: [ platform-egress ]
    cap_drop: [ ALL ]
    security_opt: [ "no-new-privileges:true" ]
    healthcheck:
      test: ["CMD-SHELL", "test -f /secrets/oidc-hmac.txt && test -f /secrets/oidc-jwks.pem"]
      interval: 5s
      retries: 24
      start_period: 10s

  authelia:                       # MODIFY
    # ... existing config ...
    volumes:
      # ... existing mounts ...
      - ingress-secrets-runtime:/oidc-secrets:ro
    environment:
      # ... existing _FILE vars ...
      AUTHELIA_IDENTITY_PROVIDERS_OIDC_HMAC_SECRET_FILE: /oidc-secrets/oidc-hmac.txt
      AUTHELIA_IDENTITY_PROVIDERS_OIDC_JWKS_0_KEY_FILE:  /oidc-secrets/oidc-jwks.pem
    depends_on:                   # NEW
      ingress-infisical-agent:
        condition: service_healthy
```

### `security/ingress/authelia/configuration.yml`

Add at the bottom:

```yaml
identity_providers:
  oidc:
    # hmac_secret + jwks loaded from /oidc-secrets via _FILE env vars
    jwks:
      - key_id: wazuh-rsa-2026
        algorithm: RS256
        use: sig
    cors:
      endpoints: [authorization, token, revocation, introspection, userinfo]
    clients:
      - client_id: wazuh
        client_name: Wazuh SIEM Dashboard
        client_secret: '<PBKDF2 hash — see Phase 2>'
        public: false
        authorization_policy: one_factor
        consent_mode: implicit
        redirect_uris:
          - https://wazuh.ironnest.local/auth/openid/login
        scopes: [openid, profile, email, groups]
        userinfo_signed_response_alg: none
        token_endpoint_auth_method: client_secret_basic
```

(If you'd rather have the agent render this whole block, swap the inline
`clients:` list for a `!include /oidc-secrets/oidc-clients.yml` once you've
verified Authelia 4.39's config supports the include directive in your build.)

### `security/ingress/authelia/users.yml`

Add `groups: ['wazuh-admin']` to your user entry so the group claim ships in
the ID token:

```yaml
users:
  hardy:                          # or whatever your username is
    displayname: 'Hardy'
    password: '$argon2id$...'
    email: 'harddy25359@gmail.com'
    groups:
      - 'wazuh-admin'             # NEW — drives all_access mapping
```

Restart the ingress stack:
```bash
docker compose -p ingress restart authelia
```
Verify Authelia picks up the OIDC config:
```bash
curl -sk https://auth.ironnest.local/.well-known/openid-configuration | jq .issuer
# → "https://auth.ironnest.local"
```

---

## Phase 5 — Wazuh stack edits

### `security/wazuh/docker-compose.yml`

#### `wazuh.indexer` service

Add platform-net + AdGuard DNS so it can reach Authelia, and mount the new
security config files:

```yaml
wazuh.indexer:
  # ... existing config ...
  volumes:
    # ... existing mounts ...
    - ./config/wazuh_indexer/config.yml:/usr/share/wazuh-indexer/config/opensearch-security/config.yml:ro
    - ./config/wazuh_indexer/roles_mapping.yml:/usr/share/wazuh-indexer/config/opensearch-security/roles_mapping.yml:ro
  networks:
    - wazuh-internal
    - platform-net                # NEW — reach auth.ironnest.local via traefik
  dns:
    - 172.30.0.10                 # NEW — AdGuard resolves *.ironnest.local
```

#### `wazuh.dashboard` service

Replace the bind-mount for `opensearch_dashboards.yml` with the OIDC variant
once you've validated it, plus mount the Traefik CA:

```yaml
wazuh.dashboard:
  # ... existing config ...
  volumes:
    # ... existing mounts ...
    - ./config/wazuh_dashboard/opensearch_dashboards.yml.oidc:/usr/share/wazuh-dashboard/config/opensearch_dashboards.yml:ro
    - traefik-certs:/usr/share/wazuh-dashboard/certs/traefik:ro   # NEW — root CA
  environment:
    # Bundle the Traefik root CA in with the Wazuh root CA so Node trusts both.
    NODE_EXTRA_CA_CERTS: "/usr/share/wazuh-dashboard/certs/root-ca.pem"
    # ... existing vars ...

volumes:
  traefik-certs:                  # NEW external reference
    external: true
    name: ingress_traefik-certs
```

The `NODE_EXTRA_CA_CERTS` path needs to contain BOTH CAs concatenated. Easiest
approach: add a one-shot init container that cats the two PEM files together
into a writable named volume mounted at `/certs/combined`, then point
`NODE_EXTRA_CA_CERTS` at it. (Alternative: re-issue the Wazuh internal certs
under the Traefik CA — bigger surgery.)

#### `wazuh-infisical-agent` sidecar

Add modelled on `openclaw/docker-compose.yml`. Renders
`secrets-runtime/.env` containing `WAZUH_OIDC_CLIENT_SECRET`. The dashboard
loads it via `env_file: secrets-runtime/.env`.

#### Dashboard keystore population

The OpenSearch Dashboards keystore needs the client secret. Add a one-shot
post-start hook:

```bash
docker exec -e SECRET="$WAZUH_OIDC_CLIENT_SECRET" wazuh.dashboard bash -lc '
  echo -n "$SECRET" | /usr/share/wazuh-dashboard/bin/opensearch-dashboards-keystore add \
    --stdin --force opensearch_security.openid.client_secret
  kill -HUP 1
'
```

(Or bake it into the entrypoint so it survives container recreates.)

### Push the security config to the indexer

After restarting `wazuh.indexer`, run:

```bash
docker exec -it wazuh.indexer bash -lc '
  /usr/share/wazuh-indexer/plugins/opensearch-security/tools/securityadmin.sh \
    -cd /usr/share/wazuh-indexer/config/opensearch-security/ \
    -nhnv \
    -cacert /usr/share/wazuh-indexer/config/certs/root-ca.pem \
    -cert /usr/share/wazuh-indexer/config/certs/admin.pem \
    -key /usr/share/wazuh-indexer/config/certs/admin-key.pem \
    -h localhost
'
```

Expected: `Done with success` and a list of updated security indices.

### Restart the dashboard

```bash
docker compose -p wazuh restart wazuh.dashboard
```

Hit `https://wazuh.ironnest.local`. You should get a 302 to
`https://auth.ironnest.local/...`, tap the passkey, land back in the Wazuh
dashboard logged in as your Authelia user with all_access.

---

## Phase 6 — optional defence-in-depth ForwardAuth

Once OIDC is verified working, you _can_ re-add the Authelia ForwardAuth
middleware to the Wazuh router. The SPA-breaking 302-to-HTML problem stops
mattering because the dashboard's OWN session cookie is what gates the SPA
calls, and the user already has a fresh Authelia session from the OIDC flow.
ForwardAuth becomes redundant, but it removes the carve-out from
`memory/project_rancher_openclaw.md` and gives you a uniform middleware
stack across all `*.ironnest.local` routes.

Skip this if you'd rather keep one less middleware in the request path.

---

## Rollback

Each phase is reversible:

- **Phase 5 rollback:** revert the `wazuh.dashboard` volume mount to the
  original `opensearch_dashboards.yml` (kept untouched as the stock file);
  re-run `securityadmin.sh` with the prior `config.yml` checked out from git.
- **Phase 4 rollback:** remove the `identity_providers.oidc` block from
  Authelia config; restart Authelia. (The `*_FILE` env vars are ignored if
  the config block isn't present.)
- **Phase 3 rollback:** stop the sidecar containers; their renders are no
  longer read by anything.
- **Phase 2 rollback:** delete the four `/wazuh-oidc/*` secrets in Infisical.

The artifacts from Phase 1 (this doc, the two new config files, the
`.oidc` sibling) are inert until the live compose mounts them.

---

## Test plan

- [ ] `curl -sk https://auth.ironnest.local/.well-known/openid-configuration` returns valid JSON with `issuer: "https://auth.ironnest.local"`
- [ ] `docker exec wazuh.indexer curl -sk https://auth.ironnest.local/.well-known/openid-configuration` succeeds (network + CA trust)
- [ ] `securityadmin.sh` returns `Done with success`
- [ ] Hitting `https://wazuh.ironnest.local` in an incognito window redirects to Authelia, prompts for passkey, and lands in `/app/wz-home` with the username visible in the top-right menu
- [ ] `docker logs wazuh.dashboard 2>&1 | grep -i openid` shows no errors
- [ ] Wazuh API calls in the SPA succeed (check the network tab — no 401/302 on `/api/...`)
- [ ] Session expiry after 1h Authelia inactivity prompts a clean re-auth flow rather than blank screens
