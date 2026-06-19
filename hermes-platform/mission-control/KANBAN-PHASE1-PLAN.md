# Mission Control × Hermes Kanban — Phase 1 Implementation Plan

> Status note, 2026-06-12: Phase 1 has been overtaken by implementation.
> The current system includes the shared `/opt/kanban` board, bridge-mediated
> `/kanban` actions, Mission Control `/api/kanban*` routes, manual `run`,
> orchestrator `decompose`, and per-profile opt-in auto-dispatch. The original
> Phase 1 safety goal below remains useful background, but it is no longer the
> full current architecture.

**Goal of Phase 1:** a shared Kanban *dashboard* in Mission Control with **zero
autonomy** — visualize + manually create/assign/move/comment on tasks that live
on a single board shared across all 7 agents. No dispatcher, nothing
auto-executes. This is the safe substrate that later unlocks Phase 2 (bounded
execution) and Phase 3 (swarm / decompose / goal-mode), which is the agreed
end-state.

## Verified facts this rests on
- Every `hermes-pf-*` runs Hermes **v0.15.2** with the full `hermes kanban` CLI.
- Each container currently has its **own** `/opt/data/kanban.db` (`HERMES_HOME=/opt/data`).
- Board root is relocatable via **`HERMES_KANBAN_HOME`** (anchors `kanban.db` +
  `boards/` + `workspaces/`). Also: `HERMES_KANBAN_DB` (pin DB file),
  `HERMES_KANBAN_BOARD` (board slug), `HERMES_KANBAN_WORKSPACES_ROOT`.
  Source: `/opt/hermes/hermes_cli/kanban_db.py` — "shared across profiles by design".
- Stable read contract: `hermes kanban list|show --json`.
- Statuses: `triage, todo, ready, running, review, blocked, scheduled, done, archived`.
- All 7 agents run as uid **10000**; MC runs as uid 11002 and is decoupled
  (reaches agents only via the `:8011` bridge).

## Key design decision: MC stays fully decoupled
MC does **not** mount/read the SQLite file (internal, version-fragile schema).
All board reads + writes go through a new bridge **`/kanban`** proxy that shells
`hermes kanban … --json`. That CLI is a pure DB op — **not** an agent turn — so
it is fast (~ms), takes none of the chat locks, and never touches agent memory.

---

## 1. Shared-board substrate (the enabler — reused by Phases 2–3)
- New external Docker volume `kanban-shared`, owned by uid 10000.
- All 7 agent services: mount `kanban-shared` at `/opt/kanban` + env
  `HERMES_KANBAN_HOME=/opt/kanban`.
- One-time `hermes kanban init` to create the shared `default` board.
- Files: `docker-compose.yml` (default/mark/steve/wifey/littlejohn) +
  `services.d/hermes-pf-{jaime,bigbert}.yml`. Env change ⇒ **recreate** the 7.
- Isolation note: a deliberate shared **read-write** board across otherwise
  isolated profiles (stronger than `/opt/shared`). Keep it **secret-free**.

## 2. Bridge: `/kanban` proxy (`agent-bridge/agent-chat-bridge.py`)
`POST /kanban` taking a **structured action** (never raw argv), token-gated via
`_authed()`, bypassing `_BUSY`/`_turn`:
- `list` → `hermes kanban list --json [--status/--assignee/--archived]`
- `show {id}` → `hermes kanban show <id> --json`
- `create {title, body?, assignee?, priority?, parent?, workspace?, triage?}`
- `comment {id, text}` · `assign {id, assignee}`
- `move {id, to}` → validated map to `promote|block|unblock|complete|archive|schedule`
- `edit {id, …}`
Each validates/whitelists args; returns `{ok, …}` with parsed JSON.

## 3. MC backend: `/api/kanban*` (`mission-control/app/main.py`)
- `_kanban_bridge(action, body)` picks a **board-gateway profile** (`default`,
  fallback to any healthy bridge) and calls its `/kanban`.
- `GET /api/kanban`, `GET /api/kanban/{id}`, `POST /api/kanban` (create),
  `PATCH /api/kanban/{id}` (move/edit/assign), `POST /api/kanban/{id}/comment`.
- Writes gated by `require_admin`. Reuse the `_bridge_json` pattern.

## 4. MC frontend (`index.html`, `app.js`, `styles.css`)
- Repurpose **Tasks** → **Board**: columns `Triage · Todo · Ready · Running ·
  Review · Blocked · Done` (Scheduled + Archived behind a toggle).
- Cards: title, priority chip, assignee avatar (`avatarHtml`), dependency badge,
  comment count.
- Drawer: body, comment thread, event history (`task_events`), dependencies,
  attachment list (read-only P1), inline edit, move controls.
- Drag-drop between columns → `PATCH …/move`; create form per column header.
- Refresh via the existing 15s poll (WebSocket later).

## 5. Existing Tasks store
Replace the JSON `state.json` board with the kanban board; migrate the seed task;
retire `/api/tasks` (recommended) unless a private "local notes" lane is wanted.

## 6. Rollout
1. Create `kanban-shared`. 2. Add mounts+env to 7 services. 3. Recreate the 7
(jaime/bigbert via their `-f services.d/*.yml`). 4. `hermes kanban init`.
5. Deploy bridge `/kanban` (bind-mounted → restart). 6. Rebuild MC. 7. Smoke-test.

## 7. Validation
Create a task assigned to `mark` from MC → confirm it appears in `steve`'s
container (`hermes kanban list`) → comment → drag Ready→Running→Done → verify the
event trail in the drawer.

## 8. Safety posture (Phase 1)
**No `hermes kanban daemon`** runs — the board is inert (manual moves only,
nothing auto-executes). Safe foundation for the chosen Phase 2/3 autonomy.

## 9. Open items to confirm during build
- Exact `list|show --json` field names → map to card/drawer.
- Attachment retrieval path (under the shared workspaces root) for downloads.
- Whether to pin per-profile `HERMES_KANBAN_WORKSPACES_ROOT` now so Phase 2/3
  execution stays in each profile's own volume.
