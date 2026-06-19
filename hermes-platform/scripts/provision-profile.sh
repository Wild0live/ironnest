#!/usr/bin/env bash
# Provision a new Hermes profile end-to-end (memory + telegram + compose).
#
# Usage:
#   bash scripts/provision-profile.sh <profile-name> [flags]
#
# Flags:
#   --telegram-bot-token=<token>   Telegram bot token from BotFather
#                                  (skip prompt; use empty string to defer)
#   --telegram-chat-id=<id>        Numeric Telegram user/chat ID allowed to talk to the bot
#   --bot-display-name=<name>      Optional pretty name for TELEGRAM_HOME_CHANNEL_NAME
#   --with-browser-intent          Also mint BROWSER_INTENT_BEARER_TOKEN for this profile
#   --no-telegram                  Skip the Telegram wiring entirely
#   --write-tokens=<file>          Write generated tokens to a 0600 file instead of stdout
#                                  (the operator deletes/shreds it after pasting)
#   --persona=<oneliner>           Short persona descriptor to seed SOUL.md
#   --force                        Overwrite existing policy/registry/seed/fragment if present
#   --yes                          Don't prompt for missing values; fail instead
#
# This script is the union of create-profile.sh + rotate-profile-token.sh
# plus Telegram bootstrapping and docker-compose fragment emission. It
# intentionally does NOT mutate Infisical — token writes are an audited
# operator action — but it prints the exact `infisical` commands you need.
#
# Outputs:
#   policies/<name>.policy.yaml                  — namespace policy
#   registry/profiles-registry.yaml              — appended entry
#   docker volume hermes-platform_data-<name>    — seeded with persona files
#   services.d/hermes-pf-<name>.yml              — standalone compose fragment
#   stdout (or --write-tokens FILE)              — generated tokens + ops runbook
#
# Idempotent: re-running with the same <profile-name> is safe; use --force
# to overwrite existing files (volume contents are preserved either way).

. "$(dirname "$0")/_common.sh"

# ── 1. argument parsing ───────────────────────────────────────────────────
NAME=""
TG_BOT_TOKEN=""
TG_CHAT_ID=""
BOT_DISPLAY_NAME=""
WITH_BROWSER_INTENT=0
NO_TELEGRAM=0
WRITE_TOKENS_FILE=""
PERSONA=""
FORCE=0
NONINTERACTIVE=0

for arg in "$@"; do
    case "$arg" in
        --telegram-bot-token=*) TG_BOT_TOKEN="${arg#*=}" ;;
        --telegram-chat-id=*)   TG_CHAT_ID="${arg#*=}" ;;
        --bot-display-name=*)   BOT_DISPLAY_NAME="${arg#*=}" ;;
        --with-browser-intent)  WITH_BROWSER_INTENT=1 ;;
        --no-telegram)          NO_TELEGRAM=1 ;;
        --write-tokens=*)       WRITE_TOKENS_FILE="${arg#*=}" ;;
        --persona=*)            PERSONA="${arg#*=}" ;;
        --force)                FORCE=1 ;;
        --yes|-y)               NONINTERACTIVE=1 ;;
        -h|--help)
            sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        -*) die "unknown flag: $arg (see --help)" ;;
        *)  [ -z "$NAME" ] || die "extra positional arg: $arg"
            NAME="$arg" ;;
    esac
done

[ -n "$NAME" ] || die "usage: $(basename "$0") <profile-name> [flags]  — see --help"
validate_profile_name "$NAME"

# Dependencies. `yq` is mandatory for registry edits; require_yq falls back
# to a containerized mikefarah/yq:4 when yq isn't on PATH (common on
# Windows hosts where only docker is installed).
require_cmd docker openssl
require_yq

NAME_UPPER="$(printf '%s' "$NAME" | tr '[:lower:]' '[:upper:]')"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Resolved paths
POLICY_FILE="$STACK_DIR/policies/${NAME}.policy.yaml"
REGISTRY_FILE="$STACK_DIR/registry/profiles-registry.yaml"
TEMPLATE_DIR="$STACK_DIR/profile-template"
DATA_VOLUME="hermes-platform_data-${NAME}"
FRAGMENT_DIR="$STACK_DIR/services.d"
FRAGMENT_FILE="$FRAGMENT_DIR/hermes-pf-${NAME}.yml"

INFISICAL_PROJECT_ID="${HERMES_PLATFORM_INFISICAL_PROJECT_ID:-}"
if [ -z "$INFISICAL_PROJECT_ID" ] && [ -f "$STACK_DIR/.env" ]; then
    INFISICAL_PROJECT_ID="$(awk -F= '/^HERMES_PLATFORM_INFISICAL_PROJECT_ID=/ {print $2}' "$STACK_DIR/.env" | tail -n1)"
fi

# ── 2. token generation (the part the user wanted detail on) ──────────────
#
# Token taxonomy for a new profile:
#
#   MEMORY_GATEWAY_TOKEN
#     - Random 256-bit secret (32 bytes → 64 hex chars).
#     - Bearer the hermes-pf-<name> container sends to the memory gateway:
#         Authorization: Bearer <MEMORY_GATEWAY_TOKEN>
#     - Stored in TWO Infisical locations (must be kept in sync):
#         /hermes-platform/<name>          → MEMORY_GATEWAY_TOKEN
#         /hermes-platform/gateway         → MEMORY_GATEWAY_PROFILE_TOKENS_JSON["<name>"]
#     - Rotated via scripts/rotate-profile-token.sh.
#     - Compromise scope: read/write to viking://profiles/<name>/** + shared paths.
#
#   BROWSER_INTENT_BEARER_TOKEN (optional, --with-browser-intent)
#     - Random 256-bit secret. Per-bearer site scoping happens in
#       browser-intent's clients.json — the token alone is not enough;
#       the operator must also list the token + allowed sites there.
#     - Stored in /hermes-platform/<name> → BROWSER_INTENT_BEARER_TOKEN.
#
#   TELEGRAM_BOT_TOKEN
#     - Issued by @BotFather; user-supplied, not generated here.
#     - Stored ONLY in /hermes-platform/<name>; the / parent must NOT
#       have a Telegram token (it would shadow the per-profile one).
#     - One bot per profile — sharing a token across profiles triggers
#       the getUpdates conflict (see [[project_hermes_multi_profile_telegram_conflict]]).
#
#   TELEGRAM_ALLOWED_USERS  / TELEGRAM_HOME_CHANNEL
#     - Comma-separated Telegram numeric IDs. The same value flows into
#       TELEGRAM_HOME_CHANNEL when the latter is unset (see gateway compose).

gen_token() {
    # 32 bytes of OS-CSPRNG entropy → 64-char lowercase hex.
    # Equivalent to: python -c "import secrets; print(secrets.token_hex(32))"
    openssl rand -hex 32
}

MEMORY_GATEWAY_TOKEN="$(gen_token)"
BROWSER_INTENT_BEARER_TOKEN=""
if [ "$WITH_BROWSER_INTENT" = "1" ]; then
    BROWSER_INTENT_BEARER_TOKEN="$(gen_token)"
fi

# Last-4 redaction for log-safe display
redact() {
    local t="$1"
    [ -z "$t" ] && { printf '(unset)'; return; }
    [ "${#t}" -le 8 ] && { printf '****'; return; }
    printf '%s…%s' "${t:0:4}" "${t: -4}"
}

# ── 3. interactive Telegram prompts (skippable) ───────────────────────────

prompt_if_missing() {
    local var="$1" label="$2" allow_empty="${3:-0}"
    local val
    eval val="\${$var}"
    if [ -n "$val" ]; then return 0; fi
    if [ "$NONINTERACTIVE" = "1" ]; then
        [ "$allow_empty" = "1" ] && return 0
        die "$label not provided and --yes given (no interactive prompt allowed)"
    fi
    if [ ! -t 0 ]; then
        [ "$allow_empty" = "1" ] && return 0
        die "$label not provided and stdin is not a TTY"
    fi
    printf '%s: ' "$label" >&2
    read -r val
    eval "$var=\$val"
}

if [ "$NO_TELEGRAM" != "1" ]; then
    log_info "Telegram bot setup (skip with --no-telegram)"
    prompt_if_missing TG_BOT_TOKEN \
        "Telegram bot token from @BotFather (leave blank to defer)" 1
    prompt_if_missing TG_CHAT_ID \
        "Allowed Telegram chat/user IDs (comma-separated, blank to defer)" 1
    prompt_if_missing BOT_DISPLAY_NAME \
        "Bot display name (e.g. 'IronNest Hermes ($NAME)') [auto]" 1
    [ -n "$BOT_DISPLAY_NAME" ] || BOT_DISPLAY_NAME="IronNest Hermes ($NAME)"
fi

# ── 4. policy file ────────────────────────────────────────────────────────

if [ -f "$POLICY_FILE" ] && [ "$FORCE" != "1" ]; then
    log_warn "policy exists, keeping: $POLICY_FILE (use --force to overwrite)"
else
    log_info "writing policy: $POLICY_FILE"
    sed "s|<PROFILE-NAME>|$NAME|g" \
        "$TEMPLATE_DIR/policy.yaml.template" > "$POLICY_FILE"
fi

# ── 5. registry entry ─────────────────────────────────────────────────────

if yq -e ".profiles[] | select(.name == \"$NAME\")" "$REGISTRY_FILE" >/dev/null 2>&1; then
    if [ "$FORCE" = "1" ]; then
        log_info "rewriting registry entry for $NAME (--force)"
        yq -i "(.profiles[] | select(.name == \"$NAME\")) |= {
            \"name\": \"$NAME\",
            \"namespace\": \"viking://profiles/$NAME/\",
            \"approved_shared_namespace\": \"viking://shared/approved/$NAME/\",
            \"container_name\": \"hermes-pf-$NAME\",
            \"status\": \"enabled\",
            \"policy_file\": \"${NAME}.policy.yaml\",
            \"created_at\": \"$NOW\",
            \"tags\": [\"dynamic\", \"provisioned\"],
            \"notes\": \"provisioned by scripts/provision-profile.sh\"
        }" "$REGISTRY_FILE"
    else
        log_warn "registry already has $NAME — leaving in place (use --force to refresh)"
    fi
else
    log_info "appending registry entry for $NAME"
    yq -i ".profiles += [{
        \"name\": \"$NAME\",
        \"namespace\": \"viking://profiles/$NAME/\",
        \"approved_shared_namespace\": \"viking://shared/approved/$NAME/\",
        \"container_name\": \"hermes-pf-$NAME\",
        \"status\": \"enabled\",
        \"policy_file\": \"${NAME}.policy.yaml\",
        \"created_at\": \"$NOW\",
        \"tags\": [\"dynamic\", \"provisioned\"],
        \"notes\": \"provisioned by scripts/provision-profile.sh\"
    }]" "$REGISTRY_FILE"
fi

# ── 6. per-profile data volume + seed ─────────────────────────────────────

if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
    log_warn "data volume already exists: $DATA_VOLUME (contents preserved)"
else
    log_info "creating data volume: $DATA_VOLUME"
    docker volume create "$DATA_VOLUME" >/dev/null
fi

# Shared artifact-exchange folder — this profile's write-own slice of the
# host-bind shared tree (mounted at /opt/shared/mine; the whole tree is
# mounted read-only at /opt/shared/all). Idempotent.
mkdir -p "$STACK_DIR/shared/$NAME"
log_info "ensured shared artifact folder: $STACK_DIR/shared/$NAME"

_DEFAULT_PERSONA="You are **$NAME_UPPER**. Replace this placeholder with the profile (mandate, doctrines, style guide)."
PERSONA_SAFE="${PERSONA:-$_DEFAULT_PERSONA}"

log_info "seeding $DATA_VOLUME with persona templates"
_TEMPLATE_HOST="$TEMPLATE_DIR"
if command -v cygpath >/dev/null 2>&1; then
    _TEMPLATE_HOST="$(cygpath -w "$TEMPLATE_DIR")"
fi
docker run --rm \
    -e PROFILE_NAME="$NAME" \
    -e PROFILE_NAME_UPPER="$NAME_UPPER" \
    -e CREATED_AT="$NOW" \
    -e PERSONA="$PERSONA_SAFE" \
    -e FORCE="$FORCE" \
    -v "$DATA_VOLUME:/opt/data" \
    -v "${_TEMPLATE_HOST}:/tmpl:ro" \
    alpine:3.20 sh -eu -c '
        cd /opt/data
        for f in SOUL.md USER.md MEMORY.md; do
            if [ ! -f "$f" ] || [ "$FORCE" = "1" ]; then
                sed -e "s|<PROFILE-NAME>|$PROFILE_NAME|g" \
                    -e "s|<PROFILE-NAME-UPPER>|$PROFILE_NAME_UPPER|g" \
                    -e "s|<CREATED-AT>|$CREATED_AT|g" \
                    "/tmpl/${f}.template" > "$f"
            fi
        done
        # Replace the SOUL.md placeholder block (two lines: starts at
        # "You are **NAME**." and continues through the line ending in
        # "doctrines, and style guide.") with the supplied persona.
        if [ -n "$PERSONA" ] && grep -q "Replace this placeholder" SOUL.md; then
            esc=$(printf "%s" "$PERSONA" | sed "s|[|&\\\\]|\\\\&|g")
            sed -i \
                -e "/^You are \*\*.*\*\*\. Replace this placeholder/,/doctrines, and style guide\./c\\
$esc" SOUL.md
        fi
        if [ ! -f tools.yaml ] || [ "$FORCE" = "1" ]; then
            sed "s|<PROFILE-NAME>|$PROFILE_NAME|g" /tmpl/tools.yaml.template > tools.yaml
        fi
        mkdir -p sessions memories skills cache logs workspace profiles/'"$NAME"'
        chown -R 10000:10000 /opt/data
        chmod 0700 /opt/data
    '

# ── 7. docker-compose fragment ────────────────────────────────────────────

mkdir -p "$FRAGMENT_DIR"
if [ -f "$FRAGMENT_FILE" ] && [ "$FORCE" != "1" ]; then
    log_warn "fragment exists, keeping: $FRAGMENT_FILE (use --force to overwrite)"
else
    log_info "writing compose fragment: $FRAGMENT_FILE"
    cat > "$FRAGMENT_FILE" <<EOF
# Auto-generated by scripts/provision-profile.sh on $NOW.
# Self-contained service block for profile '$NAME'. Apply with:
#
#   cd $STACK_DIR
#   docker compose -f docker-compose.yml -f services.d/hermes-pf-${NAME}.yml \\
#       up -d hermes-pf-$NAME
#
# Or paste the short anchor-form (see provision script stdout) into the
# main docker-compose.yml.

name: hermes-platform

volumes:
  hermes-platform-data-${NAME}:
    name: ${DATA_VOLUME}
    external: true   # already created by the provisioning script

services:
  hermes-pf-${NAME}:
    image: platform/hermes-agent:v2026.6.5-patched
    container_name: hermes-pf-${NAME}
    restart: unless-stopped
    # No entrypoint override — the shared Hermes image uses s6-overlay
    # (/init + main-wrapper.sh) and drops privileges before exec'ing CMD.
    depends_on:
      memory-gateway: { condition: service_healthy }
    env_file:
      - path: ./.env
    environment:
      HERMES_UID: "10000"
      HERMES_GID: "10000"
      INFISICAL_PROJECT_ID: "${INFISICAL_PROJECT_ID:-}"
      INFISICAL_PATH: "/hermes-platform/${NAME}"
      HERMES_PROFILE: "${NAME}"
      PATH: "/opt/hermes/.venv/bin:/opt/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
      TERMINAL_ENV: "local"
      HERMES_GATEWAY_NO_SUPERVISE: "1"
      HTTPS_PROXY: "http://squid:3128"
      HTTP_PROXY:  "http://squid:3128"
      NO_PROXY:    "memory-gateway,browser-intent-mcp,infisical,adguard,squid,socket-proxy,localhost,127.0.0.1,.local"
      https_proxy: "http://squid:3128"
      http_proxy:  "http://squid:3128"
      no_proxy:    "memory-gateway,browser-intent-mcp,infisical,adguard,squid,socket-proxy,localhost,127.0.0.1,.local"
      MEMORY_GATEWAY_URL: "http://memory-gateway:8080"
      TELEGRAM_REQUIRE_MENTION: "true"
    command:
      - with-infisical
      - sh
      - -c
      - |
        export TELEGRAM_HOME_CHANNEL="\$\${TELEGRAM_HOME_CHANNEL:-\$\${TELEGRAM_ALLOWED_USERS:-}}"
        export TELEGRAM_HOME_CHANNEL_NAME="\$\${TELEGRAM_HOME_CHANNEL_NAME:-${BOT_DISPLAY_NAME:-IronNest Hermes ($NAME)}}"
        curl -fsS -H "Authorization: Bearer \$\${MEMORY_GATEWAY_TOKEN}" http://memory-gateway:8080/health \\
          >/dev/null || { echo "memory-gateway unreachable from hermes-pf-${NAME}" >&2; exit 1; }
        hermes config set memory.memory_enabled true >/dev/null
        hermes config set memory.user_profile_enabled true >/dev/null
        hermes config set memory.provider ironnest_gateway >/dev/null
        /usr/bin/python3 /opt/ironnest/agent-chat-bridge.py &
        exec hermes gateway run
    volumes:
      - hermes-platform-data-${NAME}:/opt/data
      # Shared artifact exchange — write-own (/opt/shared/mine) + read-all (/opt/shared/all, ro)
      - ./shared/${NAME}:/opt/shared/mine
      - ./shared:/opt/shared/all:ro
      - ./hermes-plugin/ironnest_gateway:/opt/data/plugins/ironnest_gateway:ro
      - ./hermes-profile-entrypoint.sh:/opt/ironnest/hermes-profile-entrypoint.sh:ro
      - ./agent-bridge/agent-chat-bridge.py:/opt/ironnest/agent-chat-bridge.py:ro
    networks:
      - platform-net
      - hermes-platform-app-net
    dns:
      - 172.30.0.10
    cap_drop: [ALL]
    cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE]
    security_opt:
      - no-new-privileges:true
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 768M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD-SHELL", "pgrep -f 'hermes gateway run' >/dev/null"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
EOF
fi

# ── 8. reload gateway policies if it's running ────────────────────────────

if docker inspect -f '{{.State.Health.Status}}' hermes-platform-memory-gateway 2>/dev/null | grep -q healthy; then
    if [ -n "${MEMORY_GATEWAY_ADMIN_TOKEN:-}" ]; then
        log_info "reloading gateway policies via admin endpoint"
        curl -fsS -X POST \
            -H "Authorization: Bearer $MEMORY_GATEWAY_ADMIN_TOKEN" \
            http://127.0.0.1:18080/admin/reload-policies | jq . || true
    else
        log_warn "memory-gateway is up but MEMORY_GATEWAY_ADMIN_TOKEN unset"
        log_warn "reload by hand once tokens are in Infisical (step 4 of the runbook below)"
    fi
fi

# ── 8b. self-test: verify the script's own outputs before printing tokens ─
#
# This catches partial failures (e.g. registry write succeeded but volume
# create silently no-op'd) before the operator commits the runbook steps
# to Infisical. We deliberately don't check the container or gateway here
# — those are validated by validate-profile.sh after `docker compose up`.

selftest_ok=1
sft_fail() { log_err "SELFTEST FAIL: $*"; selftest_ok=0; }
sft_pass() { log_info "selftest: $*"; }

# Policy file
if [ -f "$POLICY_FILE" ] && grep -q "^profile: $NAME\$" "$POLICY_FILE"; then
    sft_pass "policy file present with matching profile field"
else
    sft_fail "policy file missing or 'profile:' field mismatch ($POLICY_FILE)"
fi

# Registry entry — read back via the same yq we wrote with
if yq -e ".profiles[] | select(.name == \"$NAME\") | .namespace == \"viking://profiles/$NAME/\"" \
        "$REGISTRY_FILE" >/dev/null 2>&1; then
    sft_pass "registry entry present with matching namespace"
else
    sft_fail "registry entry missing or namespace mismatch"
fi

# Data volume
if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
    sft_pass "data volume $DATA_VOLUME exists"
else
    sft_fail "data volume $DATA_VOLUME missing"
fi

# Seeded files inside the volume (one quick docker exec into a throwaway)
if docker run --rm -v "$DATA_VOLUME:/opt/data" alpine:3.20 \
        sh -c 'test -s /opt/data/SOUL.md && test -s /opt/data/USER.md && test -s /opt/data/MEMORY.md && test -s /opt/data/tools.yaml' \
        >/dev/null 2>&1; then
    sft_pass "volume seeded with non-empty SOUL/USER/MEMORY/tools"
else
    sft_fail "one or more seeded files in $DATA_VOLUME is missing or empty"
fi

# Compose fragment
if [ -f "$FRAGMENT_FILE" ]; then
    sft_pass "compose fragment written: $FRAGMENT_FILE"
else
    sft_fail "compose fragment missing: $FRAGMENT_FILE"
fi

if [ "$selftest_ok" != "1" ]; then
    die "self-test failed — fix the issues above before applying tokens to Infisical"
fi

# ── 9. token output: stdout (default) or 0600 file ────────────────────────

# Build the operator runbook. Tokens appear in three places:
#   (a) the runbook itself, so the operator has copy-paste material once
#   (b) the printed `infisical secrets set ...` example commands
#   (c) NEVER in the git-tracked repo

emit_runbook() {
    cat <<EOF

╔══════════════════════════════════════════════════════════════════════════╗
║  Hermes profile '$NAME' — provisioning complete                          ║
║  TOKENS BELOW ARE SECRETS — treat this output as sensitive material      ║
╚══════════════════════════════════════════════════════════════════════════╝

Generated tokens (256-bit, openssl rand -hex 32):

  MEMORY_GATEWAY_TOKEN          = $MEMORY_GATEWAY_TOKEN
EOF
    if [ -n "$BROWSER_INTENT_BEARER_TOKEN" ]; then
        cat <<EOF
  BROWSER_INTENT_BEARER_TOKEN   = $BROWSER_INTENT_BEARER_TOKEN
EOF
    fi
    cat <<EOF

User-supplied secrets:

  TELEGRAM_BOT_TOKEN            = ${TG_BOT_TOKEN:-<deferred — set later>}
  TELEGRAM_ALLOWED_USERS        = ${TG_CHAT_ID:-<deferred — set later>}
  TELEGRAM_HOME_CHANNEL_NAME    = ${BOT_DISPLAY_NAME:-IronNest Hermes ($NAME)}

────────────────────────────────────────────────────────────────────────────
 Filesystem changes already applied
────────────────────────────────────────────────────────────────────────────

  policy:    $POLICY_FILE
  registry:  $REGISTRY_FILE  (entry for '$NAME')
  volume:    $DATA_VOLUME    (seeded with SOUL/USER/MEMORY/tools)
  fragment:  $FRAGMENT_FILE

────────────────────────────────────────────────────────────────────────────
 Operator runbook — write tokens to Infisical, then bring up the container
────────────────────────────────────────────────────────────────────────────

1) Create the per-profile folder + Secret Link (inherits shared keys from /):

     # In Infisical UI: project hermes-platform → New Folder → '$NAME'
     # Then on the new /hermes-platform/$NAME folder:
     #   Settings → Secret Imports → Add → import /hermes-platform (shared keys)

   Or via CLI from inside the infisical container:
     docker exec -e INFISICAL_UNIVERSAL_AUTH_CLIENT_ID -e INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET \\
       infisical infisical secrets folders create \\
         --projectId=${INFISICAL_PROJECT_ID:-<HERMES_PLATFORM_INFISICAL_PROJECT_ID>} \\
         --env=dev --path=/hermes-platform --name=$NAME

2) Set this profile's secrets at /hermes-platform/$NAME:

     docker exec -i infisical infisical secrets set \\
       --projectId=${INFISICAL_PROJECT_ID:-<id>} --env=dev \\
       --path=/hermes-platform/$NAME \\
       MEMORY_GATEWAY_TOKEN=$MEMORY_GATEWAY_TOKEN \\
EOF
    if [ -n "$TG_BOT_TOKEN" ]; then
        printf '       TELEGRAM_BOT_TOKEN=%s \\\n' "$TG_BOT_TOKEN"
    else
        printf '       # TELEGRAM_BOT_TOKEN=<paste BotFather token here once issued> \\\n'
    fi
    if [ -n "$TG_CHAT_ID" ]; then
        printf '       TELEGRAM_ALLOWED_USERS=%s \\\n' "$TG_CHAT_ID"
        printf '       TELEGRAM_HOME_CHANNEL=%s \\\n' "$TG_CHAT_ID"
    else
        printf '       # TELEGRAM_ALLOWED_USERS=<numeric chat id(s)> \\\n'
        printf '       # TELEGRAM_HOME_CHANNEL=<same as TELEGRAM_ALLOWED_USERS> \\\n'
    fi
    printf '       TELEGRAM_HOME_CHANNEL_NAME=%q\n' "${BOT_DISPLAY_NAME:-IronNest Hermes ($NAME)}"
    if [ -n "$BROWSER_INTENT_BEARER_TOKEN" ]; then
        cat <<EOF

   For browser-intent access, also set at /hermes-platform/$NAME:
     docker exec -i infisical infisical secrets set \\
       --projectId=${INFISICAL_PROJECT_ID:-<id>} --env=dev \\
       --path=/hermes-platform/$NAME \\
       BROWSER_INTENT_BEARER_TOKEN=$BROWSER_INTENT_BEARER_TOKEN

   AND register this bearer in browser-intent/clients.json:
     {
       "$NAME": {
         "token": "$BROWSER_INTENT_BEARER_TOKEN",
         "allowed_sites": ["<site-slug>", ...]
       }
     }
   then restart browser-intent-mcp.
EOF
    fi
    cat <<EOF

3) Append '$NAME' to the gateway's bearer-token lookup table.
   In Infisical UI → /hermes-platform/gateway → MEMORY_GATEWAY_PROFILE_TOKENS_JSON
   add the new key:

     {
       "default": "...",
       "mark":    "...",
       ...,
       "$NAME":   "$MEMORY_GATEWAY_TOKEN"
     }

   (The gateway will refuse the profile's requests until this is in place.)

4) Restart the gateway so it loads the new bearer + policy:

     cd $STACK_DIR
     docker compose restart memory-gateway

   Or hot-reload policies/registry (token table still needs restart):

     curl -fsS -X POST \\
       -H "Authorization: Bearer \$MEMORY_GATEWAY_ADMIN_TOKEN" \\
       http://127.0.0.1:18080/admin/reload-policies | jq .

5) Bring up the new profile container. Two equivalent options:

   (a) overlay merge — keeps docker-compose.yml untouched:
       cd $STACK_DIR
       docker compose -f docker-compose.yml -f services.d/hermes-pf-${NAME}.yml \\
           up -d hermes-pf-$NAME

   (b) paste this minimal block into docker-compose.yml's \`services:\` and
       add hermes-platform-data-$NAME under top-level \`volumes:\`, then
       \`docker compose up -d hermes-pf-$NAME\`:

       hermes-pf-${NAME}:
         <<: *hermes-pf-base
         container_name: hermes-pf-${NAME}
         depends_on:
           memory-gateway: { condition: service_healthy }
         environment:
           <<: *hermes-env-common
           INFISICAL_PATH: "/hermes-platform/${NAME}"
           HERMES_PROFILE: "${NAME}"
         command:
           - with-infisical
           - sh
           - -c
           - |
             export TELEGRAM_HOME_CHANNEL="\${TELEGRAM_HOME_CHANNEL:-\${TELEGRAM_ALLOWED_USERS:-}}"
             export TELEGRAM_HOME_CHANNEL_NAME="\${TELEGRAM_HOME_CHANNEL_NAME:-IronNest Hermes ($NAME)}"
             curl -fsS -H "Authorization: Bearer \${MEMORY_GATEWAY_TOKEN}" http://memory-gateway:8080/health \\
               >/dev/null || { echo "memory-gateway unreachable" >&2; exit 1; }
             hermes config set memory.memory_enabled true >/dev/null
             hermes config set memory.user_profile_enabled true >/dev/null
             hermes config set memory.provider ironnest_gateway >/dev/null
             /usr/bin/python3 /opt/ironnest/agent-chat-bridge.py &
             exec hermes gateway run
         volumes:
           - hermes-platform-data-${NAME}:/opt/data
           # Shared artifact exchange — write-own + read-all (ro)
           - ./shared/${NAME}:/opt/shared/mine
           - ./shared:/opt/shared/all:ro
           - ./hermes-plugin/ironnest_gateway:/opt/data/plugins/ironnest_gateway:ro
           - ./hermes-profile-entrypoint.sh:/opt/ironnest/hermes-profile-entrypoint.sh:ro
           - ./agent-bridge/agent-chat-bridge.py:/opt/ironnest/agent-chat-bridge.py:ro
         healthcheck:
           test: ["CMD-SHELL", "pgrep -f 'hermes gateway run' >/dev/null"]
           interval: 30s
           timeout: 5s
           retries: 3
           start_period: 20s

6) Make the orchestrator able to ROUTE decomposed tasks to '$NAME'.
   Add a one- or two-sentence role description to this profile's registry
   entry (registry/profiles-registry.yaml → profiles[name=$NAME].description),
   then sync it into the orchestrator's routing roster:

     bash $STACK_DIR/scripts/sync-orchestrator-roster.sh

   Without a description the kanban decomposer cannot route subtasks to
   '$NAME' — they fall back to the orchestrator (Dr. Smith). The sync also
   runs automatically on the next \`start.sh\`.

7) Verify isolation and policy:

     bash $STACK_DIR/scripts/validate-profile.sh    $NAME
     bash $STACK_DIR/scripts/validate-isolation.sh  $NAME
     bash $STACK_DIR/scripts/validate-sharing.sh    $NAME

     # Memory gateway round-trip from inside the new container:
     docker exec hermes-pf-$NAME curl -fsS \\
       -H "Authorization: Bearer \$MEMORY_GATEWAY_TOKEN" \\
       http://memory-gateway:8080/health

     # Confirm OpenViking is NOT reachable directly (must FAIL):
     docker exec hermes-pf-$NAME curl -m 5 -sf http://openviking:1933/ \\
       && echo "ISOLATION BROKEN" || echo "isolation OK"

────────────────────────────────────────────────────────────────────────────
 Token summary (last 4 chars only — verify these match what you stored):

   MEMORY_GATEWAY_TOKEN          $(redact "$MEMORY_GATEWAY_TOKEN")
EOF
    if [ -n "$BROWSER_INTENT_BEARER_TOKEN" ]; then
        printf '   BROWSER_INTENT_BEARER_TOKEN   %s\n' "$(redact "$BROWSER_INTENT_BEARER_TOKEN")"
    fi
    if [ -n "$TG_BOT_TOKEN" ]; then
        printf '   TELEGRAM_BOT_TOKEN            %s\n' "$(redact "$TG_BOT_TOKEN")"
    fi
    echo
    echo "Rotate at any time with:  bash scripts/rotate-profile-token.sh $NAME"
    echo "Delete with:              bash scripts/delete-profile.sh $NAME [--purge-volume]"
    echo
}

if [ -n "$WRITE_TOKENS_FILE" ]; then
    log_info "writing token runbook to $WRITE_TOKENS_FILE (mode 0600)"
    ( umask 077 && emit_runbook > "$WRITE_TOKENS_FILE" )
    chmod 0600 "$WRITE_TOKENS_FILE" 2>/dev/null || true
    log_warn "shred this file after you have stored the tokens in Infisical:"
    log_warn "    rm -P -- '$WRITE_TOKENS_FILE'   # macOS"
    log_warn "    shred -u '$WRITE_TOKENS_FILE'   # linux"
else
    emit_runbook
fi
