# 18 - Automatic Conversational Memory

> **Audience:** an AI/LLM or operator trying to understand whether ordinary Hermes conversations actually use OpenViking memory.

## Short answer

Hermes agents do not call OpenViking directly. Each `hermes-pf-*` container loads an in-process Hermes `MemoryProvider` named `ironnest_gateway`. That provider connects the Hermes conversation lifecycle to the existing `memory-gateway` HTTP API.

The gateway remains the security boundary. The provider is only the Hermes-side caller.

## Do not confuse these components

| Component | Runs where | Owns what | Must not do |
|---|---|---|---|
| `ironnest_gateway` | Inside every `hermes-pf-*` agent process | Automatic recall/save hooks and Hermes memory tools | It must not connect directly to OpenViking or make policy decisions. |
| `memory-gateway` | Separate container | Authentication, profile isolation, policy decisions, auditing, and OpenViking API translation | It must not be bypassed by an agent. |
| `openviking` | Separate container on `hermes-platform-mem-net` | Long-term storage and semantic search | It must not be reachable from a Hermes agent container. |

## Conversation lifecycle

```text
User sends a message
  -> Hermes calls ironnest_gateway.prefetch(...)
  -> ironnest_gateway POSTs /memory/search to memory-gateway
  -> memory-gateway authenticates, authorizes, audits, then searches OpenViking
  -> Hermes receives permitted recalled context and generates an answer
  -> Hermes calls ironnest_gateway.sync_turn(...)
  -> ironnest_gateway redacts common secrets and POSTs /memory/write
  -> memory-gateway authenticates, authorizes, audits, then persists to OpenViking
```

Automatic turns are stored under:

```text
viking://profiles/<profile>/conversations/<session>/turn-<number>.md
```

The provider also exposes explicit Hermes tools:

- `memory_search`
- `memory_read_private`
- `memory_remember`
- `memory_publish_approved`

All four tools call `memory-gateway`; none call OpenViking directly.

## Latency guard for selected profiles

Automatic recall happens before an answer. When a CPU-only embedding backend is heavily loaded, a profile may opt into a shorter automatic-recall budget with:

```yaml
MEMORY_PREFETCH_TIMEOUT_SECONDS: "2.0"
```

When that deadline is exceeded, the turn proceeds without injected recalled context. This setting does not disable the explicit memory tools or the background post-answer `sync_turn(...)` write. The LLM Wiki integration uses this setting only for `bigbert`, because Bigbert also has direct access to its mounted Markdown knowledge vault and should remain responsive in Open WebUI.

For this deployment, Bigbert is also the user's direct LLM Wiki channel. His active profile sets `WIKI_PATH=/knowledge/wiki` and runs the LLM Wiki-managed role installer before starting the Hermes gateway, so his persistent `SOUL.md` identifies the mounted wiki in direct-channel conversations as well as API chat.

## Startup and restart persistence

This integration survives container restart and container recreation:

1. The provider source is bind-mounted read-only into each agent at `/opt/data/plugins/ironnest_gateway`.
2. Each agent startup command sets:

   ```bash
   hermes config set memory.memory_enabled true
   hermes config set memory.user_profile_enabled true
   hermes config set memory.provider ironnest_gateway
   ```

3. Conversation memory is persisted in OpenViking's named workspace volume, not held only in agent process memory.
4. New dynamically provisioned profiles receive the same mount and startup selection from `scripts/provision-profile.sh`.
5. `hermes-profile-entrypoint.sh` repairs ownership of top-level `/opt/data/auth*` files before Hermes drops privileges, so a restart recovers from auth files accidentally created by a root-run diagnostic command.

The integration would no longer work if the provider mount/startup selection were removed, the gateway token were invalid, or the OpenViking persistent volume were deleted.

## Profiles currently wired

The enabled registry profiles are:

```text
default, mark, steve, qa, littlejohn, jaime, bigbert, octo
```

The base profiles are configured in `docker-compose.yml`; `jaime`, `bigbert`, and `octo` are configured in `services.d/hermes-pf-*.yml` fragments loaded by `start.sh`. (`qa` was renamed from `wifey` 2026-06-14; `octo` platform-ops added 2026-06-12.)

## How to prove automatic memory is working

Use the lifecycle validator after a restart or provider change:

```bash
bash scripts/healthcheck.sh
bash scripts/validate-conversational-memory.sh
bash scripts/validate-isolation.sh qa bigbert
```

Interpretation:

| Result | Meaning |
|---|---|
| `validate-conversational-memory.sh` passes for a profile | Hermes discovered `ironnest_gateway`; its automatic `sync_turn` path wrote memory through the gateway and read it back. |
| A real follow-up chat recalls an earlier phrase | Full model conversation prefetch/recall is working for that profile. |
| Isolation validation passes | The provider path has not weakened cross-profile authorization or direct OpenViking blocking. |
| Audit entries appear for the conversation URI | The operation passed through `memory-gateway`, rather than bypassing policy. |

Important distinction: a profile can pass the provider lifecycle test even if it lacks an LLM inference credential. In that case its memory integration is functional, but a real generated chat response cannot be exercised until model authentication is configured.

## Source map for the next AI

| Question | Look here |
|---|---|
| How does Hermes automatically retrieve/save memory? | `hermes-plugin/ironnest_gateway/__init__.py` |
| How is the provider mounted and enabled on each restart? | `docker-compose.yml`, `services.d/hermes-pf-*.yml`, `scripts/provision-profile.sh` |
| Where are policy and audit decisions made? | `gateway/app/` |
| How are gateway URIs translated to OpenViking URIs? | `gateway/app/openviking_client.py` |
| How do I test normal conversational memory? | `scripts/validate-conversational-memory.sh` |
| Why was a provider added instead of connecting directly? | `docs/16-DECISION-LOG.md`, decision D-012 |
