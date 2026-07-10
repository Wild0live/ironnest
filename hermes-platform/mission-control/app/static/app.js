const state = {
  profiles: [],
  tasks: [],
  schedules: [],
  cronJobs: [],
  activity: [],
};

const TERMINAL_STORE_KEY = "mc.terminalTarget";
const CHAT_PROFILE_STORE_KEY = "mc.chatProfile";
const CHAT_CONV_STORE_KEY = "mc.chatActiveConv";
const DEFAULT_TERMINAL_TARGET = {
  id: "platform",
  kind: "platform",
  label: "Platform",
  url: "https://hermes-platform.ironnest.local/",
  status: "online",
};
const terminal = {
  targets: [DEFAULT_TERMINAL_TARGET],
  activeId: "platform",
  loaded: false,
};
const wiki = { sessionPromise: null };

// Kanban lifecycle columns (shared board via the bridge /kanban proxy).
const KANBAN_COLUMNS = [
  ["triage", "Triage"], ["todo", "Todo"], ["ready", "Ready"],
  ["running", "Running"], ["review", "Review"], ["blocked", "Blocked"], ["done", "Done"],
];
// Drag targets that map to a real `hermes kanban` transition command. Other
// columns (todo/triage/running/review) are lifecycle-managed, not free moves.
const KANBAN_DROP_TARGETS = new Set(["ready", "blocked", "done", "archived"]);
const KANBAN_COLLAPSE_STORE_KEY = "mc.kanbanCollapsedGoals";
function loadKanbanCollapsedGroups() {
  try { return JSON.parse(localStorage.getItem(KANBAN_COLLAPSE_STORE_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function saveKanbanCollapsedGroups() {
  try { localStorage.setItem(KANBAN_COLLAPSE_STORE_KEY, JSON.stringify(kanban.collapsedGroups || {})); } catch (e) { /* storage unavailable */ }
}
const kanban = {
  tasks: [], loaded: false, showArchived: false, drawerId: null, activeColumn: null,
  orchPlans: {}, collapsedGroups: loadKanbanCollapsedGroups(), selected: new Set(), health: null,
};
const operations = { requests: [], targets: [], enabled: false, selected: null, view: "pending", search: "", requester: "", risk: "", includeArchived: false };
const cronCatchup = { running: false };
const freshness = {
  lastSuccess: null,
  failures: 0,
  offline: false,
  staleMs: 60_000,
  messageTimer: null,
};

const $ = (selector) => document.querySelector(selector);

let _drawerLoadSeq = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function token() {
  return $("#adminToken")?.value.trim() || "";
}

function headers() {
  const adminToken = token();
  return adminToken ? { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

function fmtTime(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function lastKnownCopy() {
  return freshness.lastSuccess ? `Showing last known data from ${fmtTime(freshness.lastSuccess)}.` : "Showing last known data.";
}

function updateFreshnessStatus(mode = "fresh") {
  const dot = $("#syncDot");
  const stale = $("#staleStatus");
  const offline = $("#offlineNotice");
  const detail = $("#offlineNoticeDetail");
  const lastTime = fmtTime(freshness.lastSuccess);
  const tooltip = lastTime ? `Last updated ${lastTime}` : "No successful update yet";
  const age = freshness.lastSuccess ? Date.now() - freshness.lastSuccess.getTime() : Infinity;
  const staleNow = mode === "stale" || (!freshness.offline && age > freshness.staleMs);

  if (dot) {
    dot.className = `sync-dot ${freshness.offline ? "is-offline" : staleNow ? "is-stale" : mode === "loading" ? "is-loading" : "is-fresh"}`;
    dot.title = freshness.offline ? `${tooltip}; offline` : staleNow ? `${tooltip}; stale` : tooltip;
    dot.setAttribute("aria-label", dot.title);
  }

  if (stale) {
    if (!freshness.offline && staleNow && freshness.lastSuccess) {
      stale.textContent = `Stale - showing data from ${lastTime}`;
      stale.hidden = false;
    } else {
      stale.hidden = true;
      stale.textContent = "";
    }
  }

  if (detail) detail.textContent = lastKnownCopy();
  if (offline) offline.hidden = !freshness.offline;
}

function showSyncMessage(msg, timeoutMs = 4000) {
  const e = $("#syncStatus");
  if (!e) return;
  clearTimeout(freshness.messageTimer);
  e.textContent = msg;
  e.hidden = false;
  freshness.messageTimer = setTimeout(() => {
    e.hidden = true;
    e.textContent = "";
  }, timeoutMs);
}

function markStateFailure() {
  freshness.failures += 1;
  freshness.offline = freshness.failures >= 3;
  updateFreshnessStatus(freshness.offline ? "offline" : "stale");
}

async function loadState() {
  updateFreshnessStatus("loading");
  let response;
  try {
    response = await fetch("/api/state");
  } catch (err) {
    markStateFailure();
    return;
  }
  if (!response.ok) {
    markStateFailure();
    return;
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    markStateFailure();
    return;
  }
  freshness.lastSuccess = new Date(data.generated_at);
  freshness.failures = 0;
  const wasOffline = freshness.offline;
  freshness.offline = false;
  Object.assign(state, data);
  render();
  if ($("#view-team")?.classList.contains("active")) loadTeam();
  loadTerminalTargets();
  updateFreshnessStatus("fresh");
  if (wasOffline) showSyncMessage("Reconnected", 2500);
}

function render() {
  renderAgents();
  renderActivity();
  renderTasks();
  renderSchedules();
  renderCalendar();
  renderMemory();
  renderDocs();
  renderOrg();
  renderOffice();
  renderSelects();
  populateAgentProfiles();
  renderKpis();
  renderTerminalTargets();
}

function operationLabel(action) {
  return ({ start: "Start", stop: "Stop", restart: "Restart", docker_api: "Docker API request", host_powershell: "Windows host remediation" })[action] || action;
}

function operationTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function renderOperations() {
  const pending = operations.requests.filter((item) => item.status === "pending_approval").length;
  const badge = $("#approvalBadge");
  if (badge) { badge.hidden = pending === 0; badge.textContent = pending; }
  const hint = $("#approvalRunnerHint");
  if (hint) hint.textContent = operations.enabled
    ? "Each approval is single-use and expires after ten minutes. Little John's Windows plans run only after you review and approve the exact script."
    : "The operations runner is not configured, so new requests and execution are unavailable.";
  const list = $("#approvalList");
  if (!list) return;
  const requesterFilter = $("#approvalRequesterFilter");
  if (requesterFilter) {
    const names = [...new Set(operations.requests.map((item) => item.requested_by).filter(Boolean))].sort();
    requesterFilter.innerHTML = `<option value="">All agents</option>${names.map((name) => `<option value="${escapeHtml(name)}"${operations.requester === name ? " selected" : ""}>${escapeHtml(displayName(name))}</option>`).join("")}`;
  }
  const terminal = new Set(["executed", "failed", "expired", "unknown"]);
  let shown = operations.requests.filter((item) => {
    const status = item.status || "";
    if (operations.view === "pending" && status !== "pending_approval") return false;
    if (operations.view === "progress" && status !== "executing") return false;
    if (operations.view === "history" && !terminal.has(status)) return false;
    if (!operations.includeArchived && item.archived_at) return false;
    if (operations.requester && item.requested_by !== operations.requester) return false;
    if (operations.risk && (item.risk || "medium") !== operations.risk) return false;
    const haystack = [item.requested_by, item.action, item.target, item.reason, item.status, item.risk, item.remediation_id].join(" ").toLowerCase();
    return !operations.search || haystack.includes(operations.search.toLowerCase());
  });
  const card = (item) => {
    const pendingAction = item.status === "pending_approval"
      ? `<button type="button" class="approval-execute" data-operation-approve="${escapeHtml(item.id)}">Approve &amp; execute</button>` : "";
    const details = item.docker_request
      ? `<p class="approval-detail"><code>${escapeHtml(item.docker_request.method)} ${escapeHtml(item.docker_request.path)}</code></p>` : "";
    const remediation = item.remediation_id
      ? `<p class="approval-detail"><strong>Remediation:</strong> <code>${escapeHtml(item.remediation_id)}</code></p>` : "";
    const script = item.action === "host_powershell"
      ? `<p class="approval-detail"><strong>Risk: ${escapeHtml(item.risk || "medium")}</strong></p>${remediation}<details class="approval-plan"><summary>Review exact PowerShell plan</summary><pre>${escapeHtml(item.script || "")}</pre></details>` : "";
    return `<article class="approval-card">
      <div class="approval-card-main"><div class="approval-card-title"><span class="approval-requester-avatar">${avatarHtml(item.requested_by || "__you", 34)}</span><div><strong>${escapeHtml(displayName(item.requested_by || "Operator"))} requests ${escapeHtml(operationLabel(item.action))}</strong><p><code>${escapeHtml(item.target)}</code> · ${escapeHtml(operationTime(item.created_at))}</p></div></div>
      <p class="approval-reason">${escapeHtml(item.reason)}</p>${details}${script}</div>
      <div class="approval-card-actions"><span class="approval-status ${escapeHtml(item.status)}">${escapeHtml(item.status.replaceAll("_", " "))}</span>${pendingAction}${item.approved_by ? `<small>Approved by ${escapeHtml(item.approved_by)}</small>` : ""}</div>
    </article>`;
  };
  // Collapse repeated historical requests for the same agent/action/target;
  // active work stays expanded so it is never obscured.
  if (operations.view === "history") {
    const groups = new Map();
    shown.forEach((item) => { const key = `${item.requested_by}|${item.action}|${item.target}`; (groups.get(key) || groups.set(key, []).get(key)).push(item); });
    list.innerHTML = [...groups.values()].map((items) => items.length === 1 ? card(items[0]) : `<details class="approval-group"><summary>${escapeHtml(displayName(items[0].requested_by || "Operator"))} · ${escapeHtml(operationLabel(items[0].action))} · ${escapeHtml(items[0].target)} <span>${items.length} requests</span></summary>${items.map(card).join("")}</details>`).join("");
  } else list.innerHTML = shown.map(card).join("");
  if (!list.innerHTML) list.innerHTML = `<p class="empty">${operations.view === "pending" ? "No approvals are waiting." : "No approvals match this view."}</p>`;
  list.querySelectorAll("[data-operation-approve]").forEach((button) => button.addEventListener("click", () => openOperationApproval(button.dataset.operationApprove)));
}

async function loadOperations() {
  try {
    const data = await api("/api/operations", { headers: headers() });
    operations.requests = data.requests || [];
    operations.targets = data.targets || [];
    operations.enabled = !!data.enabled;
  } catch (err) {
    operations.requests = [];
    operations.targets = [];
    operations.enabled = false;
  }
  renderOperations();
  if ($("#view-agent")?.classList.contains("active")) renderChat({ preserveScroll: true });
}

function openOperationApproval(id) {
  const item = operations.requests.find((request) => request.id === id);
  if (!item) return;
  operations.selected = item;
  $("#approvalExecuteSummary").textContent = `${operationLabel(item.action)} ${item.target}: ${item.reason}`;
  $("#approvalExecuteDialog").showModal();
}

async function openChatApproval(id) {
  await loadOperations();
  openOperationApproval(id);
}

const approvalTabs = $("#approvalTabs");
if (approvalTabs) approvalTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-approval-view]");
  if (!button) return;
  operations.view = button.dataset.approvalView;
  approvalTabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
  renderOperations();
});
const approvalSearch = $("#approvalSearch");
if (approvalSearch) approvalSearch.addEventListener("input", () => { operations.search = approvalSearch.value.trim(); renderOperations(); });
const approvalRequesterFilter = $("#approvalRequesterFilter");
if (approvalRequesterFilter) approvalRequesterFilter.addEventListener("change", () => { operations.requester = approvalRequesterFilter.value; renderOperations(); });
const approvalRiskFilter = $("#approvalRiskFilter");
if (approvalRiskFilter) approvalRiskFilter.addEventListener("change", () => { operations.risk = approvalRiskFilter.value; renderOperations(); });
const approvalArchivedToggle = $("#approvalArchivedToggle");
if (approvalArchivedToggle) approvalArchivedToggle.addEventListener("change", () => { operations.includeArchived = approvalArchivedToggle.checked; renderOperations(); });


function renderAgents() {
  $("#agentCount").textContent = `${state.profiles.length} agents`;
  $("#agentList").innerHTML = state.profiles.map((profile) => `
    <article class="agent-card">
      <header>
        <div>
          <strong>${escapeHtml(displayName(profile.name))}</strong>
          <p>${escapeHtml(profile.container_name)}</p>
        </div>
        <span class="tag ${profile.policy_loaded ? "good" : "warn"}">${profile.policy_loaded ? "policy" : "missing"}</span>
      </header>
      <div class="tag-row">
        <span class="tag">${escapeHtml(profile.status)}</span>
        ${profile.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
      </div>
    </article>
  `).join("") || `<p class="empty">No profiles registered.</p>`;
}

function renderActivity() {
  $("#eventCount").textContent = `${state.activity.length} events`;
  $("#activityFeed").innerHTML = state.activity.map((item) => `
    <article class="feed-item">
      <small>${escapeHtml(formatTime(item.ts))}</small>
      <div>
        <strong>${escapeHtml(item.profile)} ${escapeHtml(item.operation)}</strong>
        <div class="muted">${escapeHtml(item.uri || item.reason || "gateway event")}</div>
      </div>
      <span class="decision ${item.decision === "deny" ? "deny" : ""}">${escapeHtml(item.decision)}</span>
    </article>
  `).join("") || `<p class="empty">No recent gateway activity.</p>`;
}

// renderTasks() is still called by render() (the 15s state cycle); it repaints
// the board from the cached kanban.tasks. loadKanban() refreshes the data.
function renderTasks() { renderKanban(); }

function setSync(msg) { showSyncMessage(msg); }

function fmtEpoch(s) {
  if (!s) return "";
  const d = new Date(Number(s) * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// Compact date (no time) for report/group labels, e.g. "Jun 13, 2026".
function fmtDate(s) {
  if (!s) return "";
  const d = new Date(Number(s) * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function loadKanban() {
  try {
    const data = await api(`/api/kanban${kanban.showArchived ? "?archived=true" : ""}`);
    kanban.tasks = (data && data.data) || [];
    const liveIds = new Set(kanban.tasks.map((t) => t.id));
    kanban.selected.forEach((id) => { if (!liveIds.has(id)) kanban.selected.delete(id); });
    kanban.loaded = true;
    renderKanban();
    loadKanbanHealth();
  } catch (err) {
    if (!kanban.loaded) {
      const b = $("#taskBoard");
      if (b) b.innerHTML = `<p class="empty">Board unavailable — is the agent bridge up?</p>`;
    }
  }
}

async function loadKanbanHealth() {
  try {
    const [stats, assignees] = await Promise.all([
      api("/api/kanban/board/stats").catch(() => ({})),
      api("/api/kanban/board/assignees").catch(() => ({})),
    ]);
    kanban.health = { stats: stats.data || stats, assignees: assignees.data || [] };
    renderKanbanHealth();
  } catch (err) {
    kanban.health = null;
    renderKanbanHealth();
  }
}

function renderKanbanHealth() {
  const box = $("#kanbanHealth");
  if (!box) return;
  const h = kanban.health || {};
  const stats = h.stats || {};
  const byStatus = stats.by_status || {};
  const assignees = Array.isArray(h.assignees) ? h.assignees : [];
  const total = Object.values(byStatus).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const blocked = Number(byStatus.blocked || 0);
  const running = Number(byStatus.running || 0);
  const ready = Number(byStatus.ready || 0);
  const triage = Number(byStatus.triage || 0);
  const busiest = assignees
    .map((a) => ({ name: a.name || "", total: Object.values(a.counts || {}).reduce((s, n) => s + (Number(n) || 0), 0) }))
    .filter((a) => a.name)
    .sort((a, b) => b.total - a.total)[0];
  const idle = state.profiles.filter((p) => !assignees.some((a) => a.name === p.name && Object.values(a.counts || {}).some((n) => Number(n) > 0))).length;
  box.innerHTML = `
    <div class="kan-health-card"><b>${total}</b><span>active tasks</span></div>
    <div class="kan-health-card${blocked ? " warn" : ""}"><b>${blocked}</b><span>blocked</span></div>
    <div class="kan-health-card"><b>${running}</b><span>running</span></div>
    <div class="kan-health-card"><b>${ready}</b><span>ready</span></div>
    <div class="kan-health-card${triage ? " warn" : ""}"><b>${triage}</b><span>needs clarify</span></div>
    <div class="kan-health-card"><b>${escapeHtml(busiest?.name ? displayName(busiest.name) : "—")}</b><span>busiest${busiest ? ` · ${busiest.total}` : ""}</span></div>
    <div class="kan-health-card"><b>${idle}</b><span>idle agents</span></div>`;
}

function kanbanTaskRole(t) {
  return t.link_role || (t.is_goal ? "goal" : (t.is_subtask ? "subtask" : ""));
}

function kanbanCard(t, opts = {}) {
  const pr = Number(t.priority) || 0;
  const body = t.body ? `<p>${escapeHtml(t.body)}</p>` : "";
  const checked = kanban.selected.has(t.id) ? "checked" : "";
  const selectTool = `<label class="kan-select" title="Select for bulk actions"><input type="checkbox" data-card-select="1" data-id="${escapeHtml(t.id)}" ${checked} /></label>`;
  // Run button directly on ready cards so multiple agents' tasks can be fired
  // back-to-back without opening (and being trapped in) the modal drawer.
  const runBtn = t.status === "ready"
    ? `<button type="button" class="kan-card-run" data-card-run="1" data-assignee="${escapeHtml(t.assignee || "")}" title="Run now — ${escapeHtml(t.assignee ? displayName(t.assignee) : "the assigned agent")} executes this task">▶ Run</button>`
    : "";
  // Stop button on running cards so a worker can be cancelled without opening
  // the drawer, mirroring the per-card Run.
  const stopBtn = t.status === "running"
    ? `<button type="button" class="kan-card-stop" data-card-stop="1" data-assignee="${escapeHtml(t.assignee || "")}" title="Stop — terminate the running worker for this task">■ Stop</button>`
    : "";
  // Goal (the parent task of a decomposed effort) vs subtask (one of its
  // pieces). The server annotates each list item from the dependency DAG.
  const role = kanbanTaskRole(t);
  const roleBadge = role === "goal"
    ? `<span class="kan-role kan-role-goal" title="Goal — the parent task, broken into ${t.subtask_count || 0} subtask${t.subtask_count === 1 ? "" : "s"}">◆ Goal${t.subtask_count ? ` ${t.subtask_count}` : ""}</span>`
    : role === "subtask"
      ? `<span class="kan-role kan-role-subtask" title="Subtask of a larger effort">↳ Subtask</span>`
      : "";
  const tools = [selectTool, opts.groupToggle || "", pr ? `<span class="tag ${pr >= 3 ? "warn" : ""}">P${pr}</span>` : ""].filter(Boolean).join("");
  return `
    <article class="kan-card${role ? ` kan-${role}` : ""}" draggable="true" data-id="${escapeHtml(t.id)}" data-status="${escapeHtml(t.status)}">
      <header><strong>${escapeHtml(t.title)}</strong>${tools ? `<span class="kan-card-tools">${tools}</span>` : ""}</header>
      ${roleBadge}
      ${body}
      <div class="kan-meta">${avatarHtml(t.assignee || "default", 20)}<span>${escapeHtml(t.assignee ? displayName(t.assignee) : "—")}</span>${runBtn}${stopBtn}</div>
    </article>`;
}

function kanbanGoalGroup(goal, subtasks) {
  const collapsed = !!kanban.collapsedGroups[goal.id];
  const count = subtasks.length;
  const toggle = `
    <button type="button" class="kan-group-toggle" data-goal-toggle="${escapeHtml(goal.id)}" aria-expanded="${collapsed ? "false" : "true"}" title="${collapsed ? "Show" : "Hide"} ${count} subtask${count === 1 ? "" : "s"}">
      <span aria-hidden="true">${collapsed ? "▸" : "▾"}</span>
      <span>${count}</span>
    </button>`;
  return `
    <div class="kan-task-group${collapsed ? " is-collapsed" : ""}" data-goal-group="${escapeHtml(goal.id)}">
      ${kanbanCard(goal, { groupToggle: toggle })}
      <div class="kan-subtask-stack" ${collapsed ? "hidden" : ""}>
        ${subtasks.map((t) => kanbanCard(t)).join("")}
      </div>
    </div>`;
}

function kanbanColumnMarkup(cards) {
  const goalsById = new Map(cards.filter((t) => kanbanTaskRole(t) === "goal").map((t) => [t.id, t]));
  const subtasksByGoal = new Map();
  cards.forEach((t) => {
    if (kanbanTaskRole(t) !== "subtask" || !t.goal_id || !goalsById.has(t.goal_id)) return;
    if (!subtasksByGoal.has(t.goal_id)) subtasksByGoal.set(t.goal_id, []);
    subtasksByGoal.get(t.goal_id).push(t);
  });
  const groupedSubtasks = new Set(Array.from(subtasksByGoal.values()).flat().map((t) => t.id));
  return cards.map((t) => {
    if (kanbanTaskRole(t) === "goal" && subtasksByGoal.has(t.id)) return kanbanGoalGroup(t, subtasksByGoal.get(t.id));
    if (groupedSubtasks.has(t.id)) return "";
    return kanbanCard(t);
  }).join("");
}

function renderKanban() {
  const board = $("#taskBoard");
  if (!board) return;
  const tasks = kanban.tasks || [];
  board.classList.toggle("has-active", !!kanban.activeColumn);
  board.innerHTML = KANBAN_COLUMNS.map(([status, label]) => {
    const cards = tasks.filter((t) => t.status === status);
    const active = kanban.activeColumn === status ? " kan-col-active" : "";
    return `
      <section class="column kan-col${active}" data-col="${status}">
        <h3>${label} <span class="kan-count">${cards.length}</span></h3>
        <div class="column-body" data-drop="${status}">
          ${kanbanColumnMarkup(cards) || `<p class="empty">—</p>`}
        </div>
      </section>`;
  }).join("");
  wireKanbanDnd();
  renderKanbanBulkBar();
  board.querySelectorAll("[data-goal-toggle]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.goalToggle;
      kanban.collapsedGroups[id] = !kanban.collapsedGroups[id];
      if (!kanban.collapsedGroups[id]) delete kanban.collapsedGroups[id];
      saveKanbanCollapsedGroups();
      renderKanban();
    }));
  board.querySelectorAll("[data-card-select]").forEach((box) =>
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = box.dataset.id;
      if (!id) return;
      if (box.checked) kanban.selected.add(id);
      else kanban.selected.delete(id);
      renderKanbanBulkBar();
    }));
  board.querySelectorAll(".kan-card").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("button, input, select, textarea, label")) return;
      if (!el.classList.contains("dragging")) openKanbanDrawer(el.dataset.id);
    }));
  // Per-card Run: launch the assignee's worker without opening the drawer, so
  // tasks for different agents can be started in parallel.
  board.querySelectorAll(".kan-card-run").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      kanbanRun(btn.closest(".kan-card").dataset.id, btn.dataset.assignee);
    }));
  // Per-card Stop: cancel a running worker without opening the drawer.
  board.querySelectorAll(".kan-card-stop").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      kanbanStop(btn.closest(".kan-card").dataset.id, btn.dataset.assignee);
    }));
  // Click a column header to emphasise that lane; click again to clear.
  board.querySelectorAll(".kan-col > h3").forEach((h3) =>
    h3.addEventListener("click", () => {
      const status = h3.parentElement.dataset.col;
      kanban.activeColumn = kanban.activeColumn === status ? null : status;
      renderKanban();
    }));
}

function selectedKanbanTasks(status = "") {
  const selected = kanban.tasks.filter((t) => kanban.selected.has(t.id));
  return status ? selected.filter((t) => t.status === status) : selected;
}

function renderKanbanBulkBar() {
  const bar = $("#kanBulkBar");
  const count = $("#kanBulkCount");
  if (!bar || !count) return;
  const n = kanban.selected.size;
  bar.hidden = n === 0;
  count.textContent = `${n} selected`;
}

async function kanbanBulkAction(kind) {
  const selected = selectedKanbanTasks();
  const triage = selected.filter((t) => t.status === "triage");
  const skipped = selected.length - triage.length;
  if (!triage.length) { setSync("Select triage tasks first"); return; }
  const label = kind === "clarify" ? "Clarify" : "Orchestrate";
  const extra = skipped ? ` ${skipped} non-triage selection${skipped === 1 ? "" : "s"} will be skipped.` : "";
  if (!window.confirm(`${label} ${triage.length} selected triage task${triage.length === 1 ? "" : "s"}?${extra}`)) return;
  setSync(`${label} selected tasks…`);
  try {
    const endpoint = kind === "clarify" ? "clarify" : "decompose";
    const r = await fetch(`/api/kanban/bulk/${endpoint}`, {
      method: "POST", headers: headers(), body: JSON.stringify({ ids: triage.map((t) => t.id) }),
    });
    const d = await r.json().catch(() => ({}));
    const results = d.results || [];
    const okCount = results.filter((x) => x.ok).length;
    const failCount = results.length - okCount;
    setSync(`${label} complete — ${okCount} ok${failCount ? `, ${failCount} failed` : ""}`);
    triage.forEach((t) => kanban.selected.delete(t.id));
    await loadKanban();
  } catch (err) {
    setSync(`${label} selected failed`);
  }
}

let _kanDrag = { id: null, from: null };
function wireKanbanDnd() {
  document.querySelectorAll("#taskBoard .kan-card").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      _kanDrag = { id: el.dataset.id, from: el.dataset.status };
      el.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); _kanDrag = { id: null, from: null }; });
  });
  document.querySelectorAll("#taskBoard [data-drop]").forEach((zone) => {
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drop-hot"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-hot"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drop-hot");
      const to = zone.dataset.drop;
      const { id, from } = _kanDrag;
      if (id && to !== from) kanbanMove(id, to, from);
    });
  });
}

async function kanbanMove(id, to, from) {
  if (!KANBAN_DROP_TARGETS.has(to)) { setSync(`"${to}" isn't a manual transition`); return; }
  setSync("Moving…");
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/move`, {
      method: "POST", headers: headers(), body: JSON.stringify({ to, from }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) { setSync(d.error || (r.status === 401 ? "Admin token required" : "Move failed")); return; }
    setSync(d.count ? `Archived ${d.count} linked task${d.count === 1 ? "" : "s"}` : "Moved");
    await loadKanban();
    if (kanban.drawerId === id) refreshDrawer(id);
  } catch (err) { setSync("Move failed"); }
}

async function kanbanAssign(id, assignee) {
  setSync("Reassigning…");
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/assign`, {
      method: "POST", headers: headers(), body: JSON.stringify({ assignee }),
    });
    setSync(r.ok ? "Reassigned" : (r.status === 401 ? "Admin token required" : "Reassign failed"));
    await loadKanban();
    if (kanban.drawerId === id) refreshDrawer(id);
  } catch (err) { setSync("Reassign failed"); }
}

async function kanbanComment(id, text) {
  text = (text || "").trim();
  if (!text) return;
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/comment`, {
      method: "POST", headers: headers(), body: JSON.stringify({ text }),
    });
    if (r.ok) { const i = $("#kanCommentText"); if (i) i.value = ""; refreshDrawer(id); }
    else setSync(r.status === 401 ? "Admin token required" : "Comment failed");
  } catch (err) { setSync("Comment failed"); }
}

// Manual run: the assigned agent executes this task autonomously in its own
// container. Confirm first — this is a real, possibly side-effecting agent run.
async function kanbanRun(id, assignee) {
  if (!window.confirm(`Run this task now? ${assignee || "The assigned agent"} will execute it autonomously in its own container.`)) return;
  setSync("Starting worker…");
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/run`, { method: "POST", headers: headers() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { setSync(d.error || (r.status === 401 ? "Admin token required" : "Run failed")); return; }
    setSync(`Worker started on ${d.profile || assignee || "agent"}${d.pid ? ` (pid ${d.pid})` : ""}`);
    await loadKanban();
    if (kanban.drawerId === id) refreshDrawer(id);
  } catch (err) { setSync("Run failed"); }
}

// Stop a running worker: terminates the agent's process group in its container
// and blocks the task. Confirm first — the agent may have already taken some
// side-effecting actions, so this is a hard cancel, not a clean rollback.
async function kanbanStop(id, assignee) {
  if (!window.confirm(`Stop this running task? ${assignee || "The agent"}'s worker will be terminated. It may have already taken some actions — this won't undo them.`)) return;
  setSync("Stopping worker…");
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/stop`, { method: "POST", headers: headers() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { setSync(d.error || (r.status === 401 ? "Admin token required" : "Stop failed")); return; }
    setSync(d.killed ? "Worker stopped — task blocked" : (d.note || "No live worker found — task blocked"));
    await loadKanban();
    if (kanban.drawerId === id) refreshDrawer(id);
  } catch (err) { setSync("Stop failed"); }
}

// Archive a whole completed effort: the goal task + every task linked to it
// (parents + children, transitively). Keeps the Done column lean without
// grouping. Admin-gated; confirmed since it removes multiple tasks at once.
async function kanbanArchiveTree(id) {
  if (!window.confirm("Archive this goal and EVERY task linked to it (its whole effort)? They'll move to archived and leave the active board.")) return;
  setSync("Archiving effort…");
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/archive-tree`, { method: "POST", headers: headers() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { setSync(d.error || (r.status === 401 ? "Admin token required" : "Archive failed")); return; }
    setSync(`Archived ${d.count} task${d.count === 1 ? "" : "s"}`);
    const dlg = $("#kanbanDrawer"); if (dlg && dlg.open) dlg.close();
    await loadKanban();
  } catch (err) { setSync("Archive failed"); }
}

async function kanbanDeleteGoal(id) {
  const typed = window.prompt("Permanently delete this goal and EVERY linked subtask? This removes task history and Kanban-owned artifacts/logs/workspaces. Type DELETE to confirm.");
  if (typed !== "DELETE") return;
  setSync("Deleting goal + subtasks permanently…");
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/goal`, { method: "DELETE", headers: headers() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { setSync(d.error || (r.status === 401 ? "Admin token required" : "Delete failed")); return; }
    setSync(`Deleted ${d.count} task${d.count === 1 ? "" : "s"} permanently`);
    const dlg = $("#kanbanDrawer"); if (dlg && dlg.open) dlg.close();
    await loadKanban();
  } catch (err) { setSync("Delete failed"); }
}

// Orchestrate: the orchestrator agent decomposes a triage goal into assigned
// subtasks on the shared board. Deliberate, admin-gated; the new subtasks do
// NOT auto-run unless their assignees have auto-run enabled.
async function kanbanDecompose(id) {
  if (!window.confirm("Orchestrate this goal? The orchestrator agent will reason over it and create assigned subtasks on the board. This runs an agent (~1 min).")) return;
  setSync("Orchestrating… (running the orchestrator agent, ~1 min)");
  const dec = document.querySelector("[data-decompose]");
  if (dec) { dec.disabled = true; dec.textContent = "⊹ Orchestrating…"; }
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/decompose`, { method: "POST", headers: headers() });
    const d = await r.json().catch(() => ({}));
    setSync((!r.ok || !d.ok) ? (d.error || (r.status === 401 ? "Admin token required" : "Orchestrate failed")) : "Subtasks created — see the board");
    await loadKanban();
    if (kanban.drawerId === id) refreshDrawer(id);
  } catch (err) { setSync("Orchestrate failed (timeout?)"); }
}

async function kanbanClarify(id) {
  if (!window.confirm("Clarify this task? The orchestrator will turn the current card into a concrete spec and record the change on the task.")) return;
  setSync("Clarifying task…");
  const btn = document.querySelector("[data-clarify]");
  if (btn) { btn.disabled = true; btn.textContent = "Clarifying…"; }
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/clarify`, { method: "POST", headers: headers() });
    const d = await r.json().catch(() => ({}));
    setSync((!r.ok || !d.ok) ? (d.error || (r.status === 401 ? "Admin token required" : "Clarify failed")) : "Task clarified");
    await loadKanban();
    if (kanban.drawerId === id) refreshDrawer(id);
  } catch (err) { setSync("Clarify failed"); }
}

function profileSelectHtml(selected) {
  return state.profiles.map((p) =>
    `<option value="${escapeHtml(p.name)}" ${p.name === selected ? "selected" : ""}>${escapeHtml(displayName(p.name))}</option>`).join("");
}

function planNodeLabel(nodes, key, goalId) {
  if (key === goalId || key === "goal") return "Parent goal";
  return (nodes.find((n) => n.key === key)?.key || key || "?");
}

function planFlowHtml(nodes, edges, goalId) {
  if (!edges.length) return `<p class="empty">No dependencies set.</p>`;
  return edges.map((e) =>
    `<span class="kan-plan-edge-pill">${escapeHtml(planNodeLabel(nodes, e.parent, goalId))}<span>→</span>${escapeHtml(planNodeLabel(nodes, e.child, goalId))}</span>`).join("");
}

function dependencyEditorHtml(nodes, edges, goalId) {
  const hasEdge = (parent, child) => edges.some((e) => e.parent === parent && e.child === child);
  const rows = nodes.map((n) => {
    const candidates = nodes.filter((p) => p.key !== n.key);
    return `
      <div class="kan-dep-row">
        <b>${escapeHtml(n.key)}</b>
        <div class="kan-dep-checks">
          ${candidates.map((p) => `
            <label><input type="checkbox" data-dep-parent="${escapeHtml(p.key)}" data-dep-child="${escapeHtml(n.key)}" ${hasEdge(p.key, n.key) ? "checked" : ""} /> waits for ${escapeHtml(p.key)}</label>`).join("") || `<span class="empty">No internal prerequisites</span>`}
        </div>
      </div>`;
  }).join("");
  return `
    <div class="kan-plan-graph" id="kanPlanFlow">${planFlowHtml(nodes, edges, goalId)}</div>
    <div class="kan-dep-editor">
      ${rows}
      <div class="kan-dep-row">
        <b>Parent goal</b>
        <div class="kan-dep-checks">
          ${nodes.map((n) => `
            <label><input type="checkbox" data-goal-parent="${escapeHtml(n.key)}" ${hasEdge(n.key, goalId) ? "checked" : ""} /> waits for ${escapeHtml(n.key)}</label>`).join("")}
        </div>
      </div>
    </div>`;
}

function readPlanEdgesFromDom(id) {
  const edges = [];
  document.querySelectorAll("[data-dep-parent]").forEach((box) => {
    if (box.checked) edges.push({ parent: box.dataset.depParent || "", child: box.dataset.depChild || "" });
  });
  document.querySelectorAll("[data-goal-parent]").forEach((box) => {
    if (box.checked) edges.push({ parent: box.dataset.goalParent || "", child: id });
  });
  return edges.filter((e) => e.parent && e.child);
}

function refreshPlanFlow(id) {
  const flow = $("#kanPlanFlow");
  const current = kanban.orchPlans[id] || {};
  if (!flow) return;
  flow.innerHTML = planFlowHtml(current.nodes || [], readPlanEdgesFromDom(id), id);
}

function renderOrchPlan(id, plan) {
  kanban.orchPlans[id] = plan;
  const box = $("#kanOrchPlan");
  if (!box) return;
  const nodes = plan.nodes || [];
  const edges = plan.edges || [];
  box.innerHTML = `
    <div class="kan-plan-head">
      <span class="tag">${escapeHtml(plan.playbook || "playbook")}</span>
      ${plan.playbook_auto ? `<span class="tag">auto</span>` : ""}
      <span class="kan-id">${nodes.length} task${nodes.length === 1 ? "" : "s"} · ${edges.length} link${edges.length === 1 ? "" : "s"}</span>
    </div>
    ${plan.playbook_reason ? `<div class="kan-plan-reason">${escapeHtml(plan.playbook_auto ? `Auto chose ${plan.playbook}: ${plan.playbook_reason}` : plan.playbook_reason)}</div>` : ""}
    <div class="kan-plan-nodes">
      ${nodes.map((n) => `
        <div class="kan-plan-node" data-node-key="${escapeHtml(n.key)}" data-node-priority="${escapeHtml(n.priority ?? "")}">
          <div class="kan-plan-node-top">
            <span class="tag">${escapeHtml(n.key)}</span>
            <select data-node-field="assignee">${profileSelectHtml(n.assignee || "")}</select>
          </div>
          <input data-node-field="title" value="${escapeHtml(n.title || "")}" maxlength="200" />
          <textarea data-node-field="body" rows="3" maxlength="4000">${escapeHtml(n.body || "")}</textarea>
          <div class="kan-plan-options">
            <input data-node-field="gate" value="${escapeHtml(n.gate || "")}" maxlength="60" placeholder="Gate, if required" />
            <label><input type="checkbox" data-node-field="goal" ${n.goal ? "checked" : ""} /> goal loop</label>
            <input data-node-field="skills" value="${escapeHtml((n.skills || []).join(", "))}" placeholder="skills" />
            <input data-node-field="max_runtime" value="${escapeHtml(n.max_runtime || "")}" maxlength="32" placeholder="max runtime" />
          </div>
        </div>`).join("")}
    </div>
    <h4>Dependencies</h4>
    ${dependencyEditorHtml(nodes, edges, id)}
    <button type="button" class="kan-run-btn kan-commit-btn" data-commit-plan="1">Commit playbook</button>`;
  const commit = box.querySelector("[data-commit-plan]");
  if (commit) commit.addEventListener("click", () => kanbanCommitPlan(id));
  box.querySelectorAll("[data-dep-parent], [data-goal-parent]").forEach((boxEl) =>
    boxEl.addEventListener("change", () => refreshPlanFlow(id)));
}

async function kanbanPreviewPlaybook(id) {
  const playbook = ($("#kanPlaybookKind")?.value || "auto").trim();
  const security = !!$("#kanPlaybookSecurity")?.checked;
  setSync("Building playbook preview…");
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/playbook/preview`, {
      method: "POST", headers: headers(), body: JSON.stringify({ playbook, security }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { setSync(d.error || (r.status === 401 ? "Admin token required" : "Preview failed")); return; }
    renderOrchPlan(id, d);
    setSync(`Playbook preview ready — ${d.playbook || "custom"}`);
  } catch (err) { setSync("Preview failed"); }
}

function readOrchPlanFromDom(id) {
  const current = kanban.orchPlans[id] || {};
  const nodes = Array.from(document.querySelectorAll(".kan-plan-node")).map((row) => {
    const get = (name) => row.querySelector(`[data-node-field="${name}"]`);
    return {
      key: row.dataset.nodeKey || "",
      title: get("title")?.value || "",
      body: get("body")?.value || "",
      assignee: get("assignee")?.value || "",
      priority: row.dataset.nodePriority ? Number(row.dataset.nodePriority) : null,
      gate: get("gate")?.value || "",
      goal: !!get("goal")?.checked,
      skills: (get("skills")?.value || "").split(",").map((s) => s.trim()).filter(Boolean),
      max_runtime: get("max_runtime")?.value || "",
    };
  });
  const edges = readPlanEdgesFromDom(id);
  if (!edges.length) throw new Error("Add at least one dependency");
  return { playbook: current.playbook || "custom", nodes, edges };
}

async function kanbanCommitPlan(id) {
  let plan;
  try { plan = readOrchPlanFromDom(id); }
  catch (err) { setSync(err.message || "Plan is invalid"); return; }
  if (!plan.nodes.length) { setSync("Plan has no tasks"); return; }
  if (!window.confirm("Commit this playbook? Mission Control will create blocked subtasks, link the graph, then unblock the root worker tasks.")) return;
  setSync("Committing playbook…");
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/playbook/commit`, {
      method: "POST", headers: headers(), body: JSON.stringify(plan),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      setSync(d.error || (d.errors?.[0]?.error) || (r.status === 401 ? "Admin token required" : "Commit failed"));
      return;
    }
    delete kanban.orchPlans[id];
    setSync(`Playbook committed — created ${d.created?.length || 0} task${(d.created?.length || 0) === 1 ? "" : "s"}`);
    await loadKanban();
    if (kanban.drawerId === id) refreshDrawer(id);
  } catch (err) { setSync("Commit failed"); }
}

async function kanbanRecordGate(id) {
  const gate = ($("#kanGateName")?.value || "").trim();
  const state = $("#kanGateState")?.value || "pass";
  const evidence = ($("#kanGateEvidence")?.value || "").trim();
  if (!gate) { setSync("Gate name is required"); return; }
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/gate`, {
      method: "POST", headers: headers(), body: JSON.stringify({ gate, state, evidence }),
    });
    const d = await r.json().catch(() => ({}));
    setSync((!r.ok || !d.ok) ? (d.error || (r.status === 401 ? "Admin token required" : "Gate update failed")) : "Gate recorded");
    if (r.ok && d.ok) refreshDrawer(id);
  } catch (err) { setSync("Gate update failed"); }
}

async function loadKanbanEvidence(id) {
  const box = $("#kanEvidence");
  if (!box) return;
  box.innerHTML = `<p class="empty">Loading…</p>`;
  try {
    const [runs, context] = await Promise.all([
      api(`/api/kanban/${encodeURIComponent(id)}/runs`).catch(() => ({})),
      api(`/api/kanban/${encodeURIComponent(id)}/context`).catch(() => ({})),
    ]);
    const runRows = Array.isArray(runs.data) ? runs.data : (Array.isArray(runs.runs) ? runs.runs : []);
    const runHtml = runRows.length
      ? runRows.slice(0, 8).map((r) => `<li><span class="tag">${escapeHtml(r.status || r.outcome || "run")}</span> <small>${escapeHtml(fmtEpoch(r.started_at || r.created_at || r.updated_at))}</small></li>`).join("")
      : `<li class="empty">No run records yet.</li>`;
    box.innerHTML = `
      <div class="kan-evidence-grid">
        <div><h4>Runs</h4><ul class="kan-events">${runHtml}</ul></div>
        <div><h4>Context</h4><pre class="kan-context">${escapeHtml(context.context || context.raw || "")}</pre></div>
      </div>`;
  } catch (err) {
    box.innerHTML = `<p class="empty">Could not load evidence.</p>`;
  }
}

async function kanbanCreate(form) {
  const fd = Object.fromEntries(new FormData(form).entries());
  const body = {
    title: fd.title || "", body: fd.body || "", assignee: fd.assignee || "",
    priority: fd.priority ? Number(fd.priority) : null,
    workspace: fd.workspace || "", triage: fd.triage === "on",
  };
  try {
    const r = await fetch("/api/kanban", { method: "POST", headers: headers(), body: JSON.stringify(body) });
    setSync(r.ok ? "Task created" : (r.status === 401 ? "Admin token required" : "Create failed"));
    if (r.ok) await loadKanban();
  } catch (err) { setSync("Create failed"); }
}

function openKanbanDrawer(id) {
  const task = (kanban.tasks || []).find((t) => t.id === id);
  const seq = ++_drawerLoadSeq;
  kanban.drawerId = id;
  if (task) renderDrawerPreview(task);
  else {
    $("#kanbanDrawerTitle").textContent = id;
    $("#kanbanDrawerBody").innerHTML = `<p class="empty">Loading…</p>`;
  }
  $("#kanbanDrawer").showModal();
  refreshDrawer(id, seq);
}

async function refreshDrawer(id, seq = ++_drawerLoadSeq) {
  try {
    const data = await api(`/api/kanban/${encodeURIComponent(id)}`);
    if (kanban.drawerId !== id || seq !== _drawerLoadSeq) return;
    renderDrawer(data.data || {});
  } catch (err) {
    if (kanban.drawerId !== id || seq !== _drawerLoadSeq) return;
    $("#kanbanDrawerBody").innerHTML = `<p class="empty">Could not load this task.</p>`;
  }
}

function renderDrawerPreview(t) {
  const role = kanbanTaskRole(t);
  const roleChip = role === "goal"
    ? `<span class="kan-role kan-role-goal">◆ Goal${t.subtask_count ? ` ${escapeHtml(t.subtask_count)}` : ""}</span>`
    : role === "subtask"
      ? `<span class="kan-role kan-role-subtask">↳ Subtask</span>`
      : "";
  $("#kanbanDrawerTitle").textContent = t.title || t.id || "Task";
  $("#kanbanDrawerBody").innerHTML = `
    <div class="kan-d-row"><span class="tag">${escapeHtml(t.status || "")}</span>${t.priority ? `<span class="tag">P${escapeHtml(t.priority)}</span>` : ""}${roleChip}<span class="kan-id">${escapeHtml(t.id || "")}</span></div>
    ${t.body ? `<p class="kan-d-body">${escapeHtml(t.body)}</p>` : ""}
    <div class="kan-d-meta">${avatarHtml(t.assignee || "default", 20)} ${escapeHtml(t.assignee ? displayName(t.assignee) : "Unassigned")}</div>
    <p class="empty">Loading full task details…</p>`;
}

function deferDrawerLoad(id, fn) {
  setTimeout(() => {
    if (kanban.drawerId === id) fn();
  }, 80);
}

function renderDrawer(d) {
  const t = d.task || {};
  const comments = (d.comments || []).map((c) =>
    `<div class="kan-comment"><b>${escapeHtml(c.author || "?")}</b> <small>${escapeHtml(fmtEpoch(c.created_at))}</small><div>${escapeHtml(c.body || c.text || "")}</div></div>`).join("") || `<p class="empty">No comments.</p>`;
  const events = (d.events || []).slice().reverse().map((e) =>
    `<li><span class="kan-ev">${escapeHtml(e.kind)}</span> <small>${escapeHtml(fmtEpoch(e.created_at))}</small></li>`).join("");
  const deps = [...(d.parents || []).map((p) => `↑ ${escapeHtml(p)}`), ...(d.children || []).map((c) => `↓ ${escapeHtml(c)}`)].join(" · ") || "none";
  const opts = state.profiles.map((p) => `<option value="${escapeHtml(p.name)}" ${p.name === t.assignee ? "selected" : ""}>${escapeHtml(displayName(p.name))}</option>`).join("");
  const hasRun = ["running", "done", "blocked", "review"].includes(t.status) || (d.runs || []).length > 0;
  // A "goal" is the terminal aggregator of a decomposed effort: it depends on
  // subtasks (has parents) but nothing depends on it (no children). Only there
  // do we offer to archive the whole effort in one shot.
  const isGoal = (d.children || []).length === 0 && (d.parents || []).length > 0;
  // Goal/subtask chip mirroring the board card: the goal is the parent task of a
  // decomposed effort (has prerequisites, nothing depends on it = isGoal); any
  // other linked task is a subtask. The goal carries its subtask (prereq) count.
  const nPrereqs = (d.parents || []).length;
  const dLinked = nPrereqs > 0 || (d.children || []).length > 0;
  const dRole = isGoal ? "goal" : (dLinked ? "subtask" : "");
  const roleChip = dRole === "goal"
    ? `<span class="kan-role kan-role-goal" title="Goal — the parent task, broken into ${nPrereqs} subtask${nPrereqs === 1 ? "" : "s"}">◆ Goal ${nPrereqs}</span>`
    : dRole === "subtask"
      ? `<span class="kan-role kan-role-subtask" title="Subtask of a larger effort">↳ Subtask</span>`
      : "";
  $("#kanbanDrawerTitle").textContent = t.title || t.id || "Task";
  $("#kanbanDrawerBody").innerHTML = `
    <div class="kan-d-row"><span class="tag">${escapeHtml(t.status || "")}</span>${t.priority ? `<span class="tag">P${escapeHtml(t.priority)}</span>` : ""}${roleChip}<span class="kan-id">${escapeHtml(t.id || "")}</span></div>
    ${t.body ? `<p class="kan-d-body">${escapeHtml(t.body)}</p>` : ""}
    ${d.latest_summary ? `<div class="kan-summary"><b>Latest summary</b><div>${escapeHtml(d.latest_summary)}</div></div>` : ""}
    <div class="kan-d-meta">created ${escapeHtml(fmtEpoch(t.created_at))} by ${escapeHtml(t.created_by || "?")} · deps: ${deps} · workspace ${escapeHtml(t.workspace_kind || "scratch")}</div>
    ${t.status === "ready" ? `<button type="button" class="kan-run-btn" data-run="1">▶ Run now — ${escapeHtml(t.assignee ? displayName(t.assignee) : "?")} executes this task</button>` : ""}
    ${t.status === "running" ? `<button type="button" class="kan-run-btn kan-stop-btn" data-stop="1">■ Stop — terminate the running worker</button>` : ""}
    ${t.status === "triage" ? `<button type="button" class="kan-run-btn kan-clarify-btn" data-clarify="1">Clarify — turn this into a concrete spec</button>` : ""}
    ${t.status === "triage" ? `<button type="button" class="kan-run-btn kan-orch-btn" data-decompose="1">⊹ Orchestrate — break this goal into assigned subtasks</button>` : ""}
    ${isGoal && t.status !== "archived" ? `<button type="button" class="kan-run-btn kan-archive-tree-btn" data-archtree="1">⊟ Archive goal + subtasks</button>` : ""}
    ${isGoal && t.status !== "archived" ? `<button type="button" class="kan-run-btn kan-delete-goal-btn" data-delete-goal="1">Delete goal + subtasks permanently</button>` : ""}
    ${t.status !== "archived" ? `
      <h4>Orchestration v2</h4>
      <div class="kan-orch-v2">
        <div class="kan-orch-controls">
          <select id="kanPlaybookKind" title="Playbook type">
            <option value="auto" selected>Auto recommend</option>
            <option value="code">Code delivery</option>
            <option value="research">Research</option>
          </select>
          <label><input type="checkbox" id="kanPlaybookSecurity" /> security gate</label>
          <button type="button" class="ghost-btn" data-preview-plan="1">Preview playbook</button>
        </div>
        <div id="kanOrchPlan" class="kan-plan"><p class="empty">Preview a playbook to edit tasks and dependencies before committing.</p></div>
      </div>` : ""}
    <div class="kan-actions">
      <button type="button" data-act="ready" title="promote/unblock → ready">→ Ready</button>
      <button type="button" data-act="blocked">Block</button>
      <button type="button" data-act="done">Complete</button>
      <button type="button" data-act="archived">Archive</button>
    </div>
    <label class="kan-reassign">Reassign
      <select id="kanReassign">${opts}</select>
    </label>
    <h4>Comments</h4>
    <div class="kan-comments">${comments}</div>
    <form id="kanCommentForm" class="kan-comment-form">
      <input id="kanCommentText" placeholder="Add a comment…" maxlength="2000" autocomplete="off" />
      <button type="submit">Post</button>
    </form>
    <h4>Gates</h4>
    <form id="kanGateForm" class="kan-gate-form">
      <input id="kanGateName" placeholder="Gate name" maxlength="60" />
      <select id="kanGateState"><option value="pass">Pass</option><option value="fail">Fail</option><option value="waived">Waived</option></select>
      <input id="kanGateEvidence" placeholder="Evidence" maxlength="2000" />
      <button type="submit">Record</button>
    </form>
    <h4>Evidence</h4>
    <div id="kanEvidence" class="kan-evidence"><p class="empty">Loading…</p></div>
    <h4>Chat with ${escapeHtml(t.assignee ? displayName(t.assignee) : "(no assignee)")}</h4>
    <div id="kanChatThread" class="kan-chat-thread"><p class="empty">Loading…</p></div>
    <form id="kanChatForm" class="kan-chat-form" data-tid="${escapeHtml(t.id || "")}">
      <textarea id="kanChatText" rows="2" placeholder="${t.status === "running" ? "Agent is running this task — chat available when it finishes." : (t.assignee ? `Ask ${escapeHtml(displayName(t.assignee))} about this task…  (Enter to send · Shift+Enter newline)` : "No assignee — assign first to chat.")}" ${(t.status === "running" || !t.assignee) ? "disabled" : ""}></textarea>
      <div class="kan-chat-row">
        <label class="kan-chat-anchor" title="Tell the agent to re-read artifact files before answering, so it grounds in the actual bytes instead of recalling.">
          <input type="checkbox" id="kanChatAnchor" checked /> Anchor to artifacts
        </label>
        <button type="submit" id="kanChatSend" ${(t.status === "running" || !t.assignee) ? "disabled" : ""}>Send</button>
      </div>
    </form>
    <h4>Artifacts</h4>
    <div id="kanArtifacts" class="kan-artifacts"><p class="empty">Loading…</p></div>
    <h4>History</h4>
    <ul class="kan-events">${events}</ul>
    ${hasRun ? `${outcomeHeaderHtml(t.status)}<div class="kan-log-head"><h4>Worker output${t.status === "running" ? ` <span class="kan-live">live</span>` : ""}</h4><button type="button" id="kanLogRefresh" class="ghost-btn">Refresh</button></div><pre id="kanLog" class="kan-log">Loading…</pre>` : ""}`;
  $("#kanbanDrawerBody").querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.act === "archived" && isGoal) kanbanArchiveTree(t.id);
      else kanbanMove(t.id, b.dataset.act, t.status);
    }));
  const runBtn = $("#kanbanDrawerBody").querySelector("[data-run]");
  if (runBtn) runBtn.addEventListener("click", () => kanbanRun(t.id, t.assignee));
  const stopBtn = $("#kanbanDrawerBody").querySelector("[data-stop]");
  if (stopBtn) stopBtn.addEventListener("click", () => kanbanStop(t.id, t.assignee));
  const clarifyBtn = $("#kanbanDrawerBody").querySelector("[data-clarify]");
  if (clarifyBtn) clarifyBtn.addEventListener("click", () => kanbanClarify(t.id));
  const decBtn = $("#kanbanDrawerBody").querySelector("[data-decompose]");
  if (decBtn) decBtn.addEventListener("click", () => kanbanDecompose(t.id));
  const previewBtn = $("#kanbanDrawerBody").querySelector("[data-preview-plan]");
  if (previewBtn) previewBtn.addEventListener("click", () => kanbanPreviewPlaybook(t.id));
  if (kanban.orchPlans[t.id]) renderOrchPlan(t.id, kanban.orchPlans[t.id]);
  const archTreeBtn = $("#kanbanDrawerBody").querySelector("[data-archtree]");
  if (archTreeBtn) archTreeBtn.addEventListener("click", () => kanbanArchiveTree(t.id));
  const deleteGoalBtn = $("#kanbanDrawerBody").querySelector("[data-delete-goal]");
  if (deleteGoalBtn) deleteGoalBtn.addEventListener("click", () => kanbanDeleteGoal(t.id));
  const sel = $("#kanReassign");
  if (sel) sel.addEventListener("change", () => kanbanAssign(t.id, sel.value));
  const cf = $("#kanCommentForm");
  if (cf) cf.addEventListener("submit", (e) => { e.preventDefault(); kanbanComment(t.id, $("#kanCommentText").value); });
  const gf = $("#kanGateForm");
  if (gf) gf.addEventListener("submit", (e) => { e.preventDefault(); kanbanRecordGate(t.id); });
  const chf = $("#kanChatForm");
  if (chf) {
    chf.addEventListener("submit", (e) => { e.preventDefault(); kanbanChatSend(t.id); });
    const ta = $("#kanChatText");
    if (ta) ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !ta.disabled) { e.preventDefault(); kanbanChatSend(t.id); }
    });
    deferDrawerLoad(t.id, () => kanbanChatLoad(t.id));
  }
  if (hasRun) {
    deferDrawerLoad(t.id, () => loadWorkerLog(t.id));
    const rl = $("#kanLogRefresh");
    if (rl) rl.addEventListener("click", () => loadWorkerLog(t.id));
  }
  deferDrawerLoad(t.id, () => loadArtifacts(t.id));  // durable deliverables (Layer 2); async — survive the run
  deferDrawerLoad(t.id, () => loadKanbanEvidence(t.id));
  // Live-poll the drawer (status + log) while the task is running.
  clearTimeout(_drawerTimer);
  if (t.status === "running" && kanban.drawerId === t.id) {
    _drawerTimer = setTimeout(() => { if (kanban.drawerId === t.id) refreshDrawer(t.id); }, 5000);
  }
}

let _drawerTimer = null;

// Status-derived outcome banner shown above the worker-output log. The column
// status (t.status) is the source of truth; loadWorkerLog() may corroborate by
// downgrading to a failure state if the log tail shows the agent gave up.
const KAN_OUTCOMES = {
  done:    { cls: "done",    icon: "✓",  label: "Completed" },
  running: { cls: "running", icon: "⏳", label: "Running" },
  blocked: { cls: "blocked", icon: "⛔", label: "Blocked" },
  review:  { cls: "review",  icon: "🔍", label: "In review" },
};
function outcomeHeaderHtml(status) {
  const o = KAN_OUTCOMES[status] || { cls: "idle", icon: "•", label: status || "Unknown" };
  return `<div id="kanOutcome" class="kan-outcome kan-outcome-${o.cls}"><span class="kan-outcome-icon">${o.icon}</span><span class="kan-outcome-label">${escapeHtml(o.label)}</span></div>`;
}

async function loadWorkerLog(id) {
  const pre = $("#kanLog");
  if (!pre) return;
  try {
    const d = await api(`/api/kanban/${encodeURIComponent(id)}/log`);
    const log = (d && d.log) ? d.log : "";
    pre.textContent = log || "(no worker output yet)";
    pre.scrollTop = pre.scrollHeight;
    // Corroborate the status-derived banner from the log tail. Only ever
    // downgrade to a failure state — never override a column-status success.
    const out = $("#kanOutcome");
    if (out && log && !out.classList.contains("kan-outcome-done")) {
      const tail = log.slice(-2000).toLowerCase();
      if (/\bgave[ _]up\b|\btask failed\b|\berror:\s/.test(tail)) {
        out.className = "kan-outcome kan-outcome-failed";
        out.innerHTML = `<span class="kan-outcome-icon">✕</span><span class="kan-outcome-label">Failed</span>`;
      }
    }
  } catch (e) { pre.textContent = "(log unavailable)"; }
}

// ── Drawer chat — Q&A with the task's current assignee ──────────────────────
// Backed by /api/kanban/<id>/chat (history) and /chat/stream (one streamed turn
// per message, persisted to MC's task-chat store). The agent receives a
// task-scoped session id so it has continuity across messages for THIS task,
// and — when the Anchor toggle is on — a prefix telling it to re-read the
// shared artifact tree before answering.
function renderChatThread(messages) {
  const box = $("#kanChatThread");
  if (!box) return;
  if (!messages || !messages.length) {
    box.innerHTML = `<p class="empty">No messages yet. Ask the agent about its output for this task.</p>`;
    return;
  }
  box.innerHTML = messages.map((m) => {
    const role = m.role || "user";
    const who = role === "agent" ? (m.assignee ? displayName(m.assignee) : "agent")
              : role === "error" ? "error"
              : "you";
    return `<div class="kan-chat-msg kan-chat-${escapeHtml(role)}">`
         + `<div class="kan-chat-head"><b>${escapeHtml(who)}</b> <small>${escapeHtml(fmtEpoch(m.ts))}</small></div>`
         + `<div class="kan-chat-body">${escapeHtml(m.text || "")}</div>`
         + `</div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

async function kanbanChatLoad(tid) {
  try {
    const d = await api(`/api/kanban/${encodeURIComponent(tid)}/chat`);
    renderChatThread(d.messages || []);
  } catch (e) {
    const box = $("#kanChatThread");
    if (box) box.innerHTML = `<p class="empty">Could not load chat.</p>`;
  }
}

async function kanbanChatSend(tid) {
  const ta = $("#kanChatText");
  const btn = $("#kanChatSend");
  const anchor = $("#kanChatAnchor");
  if (!ta || ta.disabled) return;
  const text = (ta.value || "").trim();
  if (!text) return;
  const wantAnchor = !!(anchor && anchor.checked);
  ta.disabled = true; if (btn) btn.disabled = true;
  ta.value = "";

  // Optimistic append: show user msg + an empty streaming agent msg.
  const box = $("#kanChatThread");
  const nowSec = Math.floor(Date.now() / 1000);
  const empty = box && box.querySelector("p.empty");
  if (empty) box.innerHTML = "";
  if (box) {
    box.insertAdjacentHTML("beforeend",
      `<div class="kan-chat-msg kan-chat-user"><div class="kan-chat-head"><b>you</b> <small>${escapeHtml(fmtEpoch(nowSec))}</small></div><div class="kan-chat-body">${escapeHtml(text)}</div></div>`
      + `<div class="kan-chat-msg kan-chat-agent" id="kanChatStreaming"><div class="kan-chat-head"><b>${escapeHtml(displayName((kanban.drawerId && state.tasks.find((x)=>x.id===kanban.drawerId) || {}).assignee || "agent"))}</b> <small>…</small></div><div class="kan-chat-body"></div></div>`);
    box.scrollTop = box.scrollHeight;
  }
  const liveBody = box && box.querySelector("#kanChatStreaming .kan-chat-body");

  let resp;
  try {
    resp = await fetch(`/api/kanban/${encodeURIComponent(tid)}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, anchor: wantAnchor }),
    });
  } catch (err) {
    if (liveBody) liveBody.textContent = `[network error: ${err}]`;
    ta.disabled = false; if (btn) btn.disabled = false;
    return;
  }
  if (resp.status === 409) {
    const j = await resp.json().catch(() => ({}));
    if (liveBody) liveBody.textContent = `[${j.error || "task busy"}]`;
    ta.disabled = false; if (btn) btn.disabled = false;
    return;
  }
  if (!resp.ok || !resp.body) {
    if (liveBody) liveBody.textContent = `[stream HTTP ${resp.status}]`;
    ta.disabled = false; if (btn) btn.disabled = false;
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let acc = "";
  let streamErr = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of ev.split("\n")) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        let evt; try { evt = JSON.parse(s.slice(5).trim()); } catch { continue; }
        if (evt.type === "chunk") { acc += evt.text || ""; if (liveBody) liveBody.textContent = acc; if (box) box.scrollTop = box.scrollHeight; }
        else if (evt.type === "done") { if (evt.reply) { acc = evt.reply; if (liveBody) liveBody.textContent = acc; } }
        else if (evt.type === "error") { streamErr = evt.error || "stream error"; }
      }
    }
  }
  if (streamErr && liveBody) liveBody.textContent = acc ? acc + `\n\n[stream error: ${streamErr}]` : `[stream error: ${streamErr}]`;
  if (!acc && !streamErr && liveBody) liveBody.textContent = "(empty reply)";

  ta.disabled = false; if (btn) btn.disabled = false;
  // Reload from server so timestamps + persisted role match the canonical store.
  kanbanChatLoad(tid);
}

// ── Artifacts panel (Layer 2) ────────────────────────────────────────────────
// Durable per-task deliverables, listed + served through the board gateway. The
// files survive the run (they live on the shared kanban volume under
// artifacts/<id>/, not the ephemeral scratch dir). Text/markdown gets an in-UI
// reader; everything downloads.
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Is this file safe+sensible to render as text in the reader modal?
function isTextual(name, mime) {
  if (/^text\//i.test(mime || "")) return true;
  if (/(json|xml|yaml|csv|markdown|javascript)/i.test(mime || "")) return true;
  return /\.(md|markdown|txt|log|json|csv|tsv|ya?ml|py|js|ts|sh|html?|xml|ini|cfg|conf|toml)$/i.test(name || "");
}

function fileIcon(name, mime) {
  const n = (name || "").toLowerCase();
  if (/\.(md|markdown)$/.test(n)) return "📝";
  if (/\.(png|jpe?g|gif|svg|webp|bmp)$/.test(n) || /^image\//i.test(mime || "")) return "🖼️";
  if (/\.(csv|tsv|xlsx?)$/.test(n)) return "📊";
  if (/\.(json|ya?ml|toml|ini|cfg|conf|xml)$/.test(n)) return "⚙️";
  if (/\.(zip|tar|gz|tgz|7z)$/.test(n)) return "🗜️";
  if (/\.(pdf)$/.test(n)) return "📕";
  return "📄";
}

// One row in the (recursive) artifact tree. `f.path` is the POSIX-relative path
// under the task's artifact dir; the directory prefix is shown muted so nested
// files read clearly. View/Download route through the nested `?path=` endpoints.
function artifactRow(id, f) {
  const path = f.path || f.name;
  const base = String(path).split("/").pop();
  const dir = path.includes("/") ? path.slice(0, path.length - base.length) : "";
  const dl = `/api/kanban/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`;
  const viewBtn = isTextual(base, f.mime)
    ? `<button type="button" class="art-btn" data-viewpath="${escapeHtml(path)}" data-mime="${escapeHtml(f.mime || "")}">View</button>`
    : "";
  return `<div class="art-row">
      <span class="art-icon">${fileIcon(base, f.mime)}</span>
      <span class="art-name" title="${escapeHtml(path)}">${dir ? `<span class="art-dir">${escapeHtml(dir)}</span>` : ""}${escapeHtml(base)}</span>
      <span class="art-size">${escapeHtml(fmtBytes(f.size))}</span>
      ${viewBtn}
      <a class="art-btn" href="${dl}" download="${escapeHtml(base)}">Download</a>
    </div>`;
}

async function loadArtifacts(id) {
  const box = $("#kanArtifacts");
  if (!box) return;
  try {
    const d = await api(`/api/kanban/${encodeURIComponent(id)}/tree`);
    const files = (d && d.files) || [];
    const appList = (d && d.apps) || [];
    const appsBase = (d && d.apps_base) || "";
    if (!files.length) { box.innerHTML = `<p class="empty">No artifacts yet.</p>`; return; }
    // Runnable apps (folders with an index.html) get Open / New-tab / .zip controls.
    const appsHtml = appList.length
      ? `<div class="art-apps">` + appList.map((ap) => {
          const url = `${appsBase}/${id}/` + (ap ? `${ap}/` : "");
          const name = ap || "app";
          const zip = `/api/kanban/${encodeURIComponent(id)}/zip${ap ? `?sub=${encodeURIComponent(ap)}` : ""}`;
          return `<div class="art-app">
              <span class="art-app-label" title="Runnable web app">▶ ${escapeHtml(name)}</span>
              <button type="button" class="art-btn" data-apppreview="${escapeHtml(url)}" data-name="${escapeHtml(name)}">Open</button>
              <a class="art-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">New tab ↗</a>
              <a class="art-btn" href="${zip}" download>.zip</a>
            </div>`;
        }).join("") + `</div>`
      : "";
    const dlAll = `<div class="art-dlall"><a class="art-btn" href="/api/kanban/${encodeURIComponent(id)}/zip" download>⤓ Download all (.zip)</a></div>`;
    box.innerHTML = appsHtml + dlAll + files.map((f) => artifactRow(id, f)).join("");
    box.querySelectorAll("[data-viewpath]").forEach((b) =>
      b.addEventListener("click", () => openArtifactReader(id, b.dataset.viewpath, b.dataset.mime || "")));
    box.querySelectorAll("[data-apppreview]").forEach((b) =>
      b.addEventListener("click", () => openAppPreview(b.dataset.apppreview, b.dataset.name)));
  } catch (e) {
    box.innerHTML = `<p class="empty">Artifacts unavailable.</p>`;
  }
}

// Read one artifact file in the in-app reader. `path` may be nested (a/b/c) or a
// bare top-level name (Reports view) — both are valid `?path=` values.
async function openArtifactReader(id, path, mime) {
  const dlg = $("#artifactReader");
  if (!dlg) return;
  const base = String(path).split("/").pop();
  $("#artifactReaderTitle").textContent = base;
  $("#artifactReaderBody").innerHTML = `<p class="empty">Loading…</p>`;
  dlg.showModal();
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
                          { headers: headers() });
    if (!r.ok) { $("#artifactReaderBody").innerHTML = `<p class="empty">Could not load this file.</p>`; return; }
    const text = await r.text();
    const isMd = /\.(md|markdown)$/i.test(base);
    $("#artifactReaderBody").innerHTML = isMd
      ? `<div class="md-body">${renderMarkdown(text)}</div>`
      : `<pre class="art-plain">${escapeHtml(text)}</pre>`;
    $("#artifactReaderBody").scrollTop = 0;
  } catch (e) {
    $("#artifactReaderBody").innerHTML = `<p class="empty">Could not load this file.</p>`;
  }
}

// ── Tiny safe Markdown renderer ──────────────────────────────────────────────
// Hand-rolled (Mission Control ships no CDN egress and bundles no JS deps) and
// XSS-safe by construction: every fragment is escapeHtml()'d BEFORE any markup
// is added, so agent-authored content can never inject HTML. Covers headings,
// bold/italic, inline + fenced code, blockquotes, lists, hr, links (http(s)
// only) and paragraphs — enough to read a report cleanly.
function mdInline(s, profile) {
  let t = escapeHtml(s);
  // inline code first so its contents aren't further formatted
  t = t.replace(/`([^`]+)`/g, (m, c) => `<code class="md-ic">${c}</code>`);
  // links [label](url): an upload path becomes a download link (chat only, needs
  // a profile); http(s) opens in a new tab; anything else degrades to its label.
  t = t.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const hit = url.match(UPLOAD_RE);
    if (hit && profile) return dlLink(profile, hit[1], label);
    return /^https?:\/\//i.test(url)
      ? `<a class="ext-link" href="${url}" target="_blank" rel="noopener noreferrer">${label || url}</a>`
      : (label || m);
  });
  // bare upload paths (backtick-wrapped, MEDIA:/sandbox: prefix, or plain) → download link
  if (profile) t = t.replace(UPLOAD_PATH_RE, (m, name) => dlLink(profile, name, name));
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
       .replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
       .replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  return t;
}

const MD_BREAK = /^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s|(?:---|\*\*\*|___)\s*$)/;

function renderMarkdown(src, profile) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let listType = null;
  let listBuf = [];
  const flushList = () => {
    if (listType) { html.push(`<${listType}>${listBuf.join("")}</${listType}>`); listBuf = []; listType = null; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {                                   // fenced code block
      flushList();
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;                                                     // consume closing fence
      html.push(`<pre class="md-code"><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);                 // heading
    if (h) { flushList(); const lvl = h[1].length; html.push(`<h${lvl} class="md-h">${mdInline(h[2], profile)}</h${lvl}>`); i++; continue; }
    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) { flushList(); html.push(`<hr class="md-hr" />`); i++; continue; }  // hr
    const bq = line.match(/^>\s?(.*)$/);                       // blockquote (single line)
    if (bq) { flushList(); html.push(`<blockquote class="md-bq">${mdInline(bq[1], profile)}</blockquote>`); i++; continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);                // unordered list item
    if (ul) { if (listType && listType !== "ul") flushList(); listType = "ul"; listBuf.push(`<li>${mdInline(ul[1], profile)}</li>`); i++; continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);              // ordered list item
    if (ol) { if (listType && listType !== "ol") flushList(); listType = "ol"; listBuf.push(`<li>${mdInline(ol[1], profile)}</li>`); i++; continue; }
    if (!line.trim()) { flushList(); i++; continue; }          // blank line
    flushList();                                               // paragraph (gather until a break)
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !MD_BREAK.test(lines[i])) { para.push(lines[i]); i++; }
    html.push(`<p>${para.map((l) => mdInline(l, profile)).join("<br />")}</p>`);
  }
  flushList();
  return html.join("\n");
}

// ── Reports library (Layer 3) ────────────────────────────────────────────────
// Every kanban task that produced durable artifacts, listed for browse/search.
// Reuses the artifact viewer modal + helpers (isTextual/fileIcon/fmtBytes) from
// the Layer 2 drawer code. Each file can be opened (text) or published to the
// LLM Wiki so it becomes full-text searchable + chat-able at wiki.ironnest.local.
const reports = { items: [], loaded: false, search: "", open: new Set(), showHidden: false };

// Kick off a download without leaving the page. Used for the report .zip links —
// inside a <summary> a plain <a download> would also toggle the <details>, so the
// click handlers preventDefault and call this instead.
function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Hide (soft-delete) or restore one or more reports, then refresh the view. `ids`
// is a comma-separated list (one task for a card, all of a group's tasks for a
// group action). Files are never deleted — a hide just writes a `.hidden` marker.
async function setReportsHidden(ids, hide, btn) {
  const list = String(ids || "").split(",").filter(Boolean);
  if (!list.length) return;
  if (btn) { btn.disabled = true; btn.textContent = hide ? "Deleting…" : "Restoring…"; }
  const action = hide ? "hide" : "unhide";
  try {
    await Promise.all(list.map((id) =>
      fetch(`/api/kanban/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: headers() })));
  } catch (e) { /* reload reflects the real state regardless */ }
  await loadReports();
}

// Permanently delete one or more whole reports — wipes each task's artifact dir
// off the shared volume. Irreversible; gated behind a confirm in the click wiring.
async function purgeReports(ids, btn) {
  const list = String(ids || "").split(",").filter(Boolean);
  if (!list.length) return;
  if (btn) { btn.disabled = true; btn.textContent = "Deleting…"; }
  try {
    await Promise.all(list.map((id) =>
      fetch(`/api/kanban/${encodeURIComponent(id)}/artifacts`, { method: "DELETE", headers: headers() })));
  } catch (e) { /* reload reflects the real state regardless */ }
  await loadReports();
}

// Permanently delete one file from a report. Irreversible; confirm-gated.
async function deleteReportFile(id, name, btn) {
  if (btn) btn.disabled = true;
  try {
    await fetch(`/api/kanban/${encodeURIComponent(id)}/artifact/${encodeURIComponent(name)}`,
                { method: "DELETE", headers: headers() });
  } catch (e) { /* reload reflects the real state regardless */ }
  await loadReports();
}

async function loadReports() {
  const box = $("#reportList");
  try {
    const d = await api("/api/reports");
    reports.items = (d && d.reports) || [];
    reports.loaded = true;
    renderReports();
  } catch (e) {
    if (!reports.loaded && box) box.innerHTML = `<p class="empty">Reports unavailable — is the board gateway up?</p>`;
  }
}

function reportMatches(r, q) {
  if (!q) return true;
  const hay = `${r.title || ""} ${displayName(r.assignee || "")} ${r.assignee || ""} ${r.status || ""} ${(r.files || []).map((f) => f.name).join(" ")}`.toLowerCase();
  return hay.includes(q);
}

function reportCard(r) {
  const files = (r.files || []).map((f) => {
    const dl = `/api/kanban/${encodeURIComponent(r.task_id)}/artifact/${encodeURIComponent(f.name)}`;
    // Click the name to VIEW: text/markdown opens in the reader modal; everything
    // else (images, PDFs, …) opens inline in a new tab — the artifact is served
    // with an inline content-type, so the browser renders it.
    const open = isTextual(f.name, f.mime)
      ? `<button type="button" class="rep-file-name" data-rv="1" data-id="${escapeHtml(r.task_id)}" data-name="${escapeHtml(f.name)}" data-mime="${escapeHtml(f.mime || "")}" title="View ${escapeHtml(f.name)}">${fileIcon(f.name, f.mime)} <span>${escapeHtml(f.name)}</span></button>`
      : `<a class="rep-file-name" href="${dl}" target="_blank" rel="noopener noreferrer" title="View ${escapeHtml(f.name)}">${fileIcon(f.name, f.mime)} <span>${escapeHtml(f.name)}</span> ↗</a>`;
    return `<div class="rep-file">
        ${open}
        <span class="rep-file-size">${escapeHtml(fmtBytes(f.size))}</span>
        <div class="rep-file-acts">
          <a class="rep-file-act" href="${dl}" download="${escapeHtml(f.name)}" title="Download ${escapeHtml(f.name)}">⤓</a>
          <button type="button" class="rep-file-act rep-file-del" data-fdel="1" data-id="${escapeHtml(r.task_id)}" data-name="${escapeHtml(f.name)}" title="Permanently delete ${escapeHtml(f.name)}">🗑</button>
          <button type="button" class="rep-pub-btn" data-rpub="1" data-id="${escapeHtml(r.task_id)}" data-name="${escapeHtml(f.name)}" title="Publish this report into the LLM Wiki">Publish to Wiki</button>
        </div>
      </div>`;
  }).join("");
  const hidden = !!r.hidden;
  const zipName = r.title || r.task_id;
  // Date now lives on its own line directly under the title (was inline in meta).
  const dateHtml = r.completed
    ? `<span class="rep-date" title="Completed ${escapeHtml(fmtEpoch(r.completed))}">✓ Completed ${escapeHtml(fmtDate(r.completed))}</span>`
    : (r.updated ? `<span class="rep-date" title="Last updated ${escapeHtml(fmtEpoch(r.updated))}">${escapeHtml(fmtDate(r.updated))}</span>` : "");
  const actions = `<div class="rep-actions">
        <button type="button" class="rep-act rep-dl" data-dl="1" data-ids="${escapeHtml(r.task_id)}" data-name="${escapeHtml(zipName)}" title="Download all files as a .zip">⤓ Download</button>
        ${hidden
          ? `<button type="button" class="rep-act rep-restore" data-unhide="1" data-ids="${escapeHtml(r.task_id)}" title="Restore this report">↺ Restore</button>`
          : `<button type="button" class="rep-act rep-del" data-hide="1" data-ids="${escapeHtml(r.task_id)}" title="Delete this report from the list (files are kept; restorable)">🗑 Delete</button>`}
        <button type="button" class="rep-act rep-purge" data-purge="1" data-ids="${escapeHtml(r.task_id)}" title="Permanently delete this report and all its files (cannot be undone)">⨯ Delete permanently</button>
      </div>`;
  return `<article class="rep-card${hidden ? " is-hidden" : ""}">
      <header class="rep-head">
        ${avatarHtml(r.assignee || "default", 28)}
        <div class="rep-head-main">
          <strong class="rep-title">${escapeHtml(r.title)}</strong>
          <div class="rep-subline">
            ${dateHtml}
            ${hidden ? `<span class="rep-hidden-tag">hidden</span>` : ""}
          </div>
          <div class="rep-meta">
            ${r.status ? `<span class="tag">${escapeHtml(r.status)}</span>` : ""}
            <span class="rep-assignee">${escapeHtml(r.assignee ? displayName(r.assignee) : "—")}</span>
            <span class="rep-count">${Number(r.file_count) || 0} file${Number(r.file_count) === 1 ? "" : "s"}</span>
          </div>
        </div>
        ${actions}
      </header>
      <div class="rep-files">${files}</div>
    </article>`;
}

function renderReports() {
  const box = $("#reportList");
  if (!box) return;
  if (!reports.items.length) {
    box.innerHTML = `<p class="empty">No reports yet. Files a task saves into its artifacts directory show up here.</p>`;
    return;
  }
  const q = (reports.search || "").trim().toLowerCase();
  const hiddenCount = reports.items.filter((r) => r.hidden).length;
  let rows = reports.items.filter((r) => reportMatches(r, q));
  if (!reports.showHidden) rows = rows.filter((r) => !r.hidden);
  // Toolbar appears only once something is hidden: a toggle to reveal/conceal the
  // soft-deleted reports so they can be restored.
  const toggleBar = hiddenCount
    ? `<div class="rep-toolbar"><button type="button" class="rep-toggle-hidden" data-toggle-hidden="1">${reports.showHidden ? "Hide" : "Show"} ${hiddenCount} hidden report${hiddenCount === 1 ? "" : "s"}</button></div>`
    : "";
  if (!rows.length) {
    box.innerHTML = toggleBar + `<p class="empty">${q ? `No reports match “${escapeHtml(reports.search)}”.` : "No visible reports."}</p>`;
    wireReports(box);
    return;
  }
  // Group reports by their goal (group_id): every report from one decomposed
  // effort nests under a single header. A standalone report (self-group, one
  // task) renders bare. rows are already sorted by updated desc; first-seen
  // order places the most-recently-touched group first.
  const groups = new Map();
  for (const r of rows) {
    const gid = r.group_id || r.task_id;
    if (!groups.has(gid)) groups.set(gid, { id: gid, title: r.group_title || r.title, items: [] });
    groups.get(gid).items.push(r);
  }
  // Collapsible groups (native <details>): default collapsed so the view stays
  // compact; remembered per-group in reports.open across re-renders; force-open
  // while searching so matches aren't hidden inside a collapsed group.
  const searching = !!q;
  box.innerHTML = toggleBar + [...groups.values()].map((g) => {
    const standalone = g.items.length === 1 && g.items[0].task_id === g.id;
    const cards = g.items.map(reportCard).join("");
    if (standalone) return cards;
    const n = g.items.length;
    const open = searching || reports.open.has(g.id);
    const gdate = g.items.reduce((m, r) => Math.max(m, Number(r.completed) || Number(r.updated) || 0), 0);
    const ids = g.items.map((r) => r.task_id).join(",");
    const allHidden = g.items.every((r) => r.hidden);
    const groupActions = `<div class="rep-actions">
            <button type="button" class="rep-act rep-dl" data-dl="1" data-ids="${escapeHtml(ids)}" data-name="${escapeHtml(g.title)}" title="Download every file in this group as a .zip">⤓ Download all</button>
            ${allHidden
              ? `<button type="button" class="rep-act rep-restore" data-unhide="1" data-ids="${escapeHtml(ids)}" title="Restore all reports in this group">↺ Restore</button>`
              : `<button type="button" class="rep-act rep-del" data-hide="1" data-ids="${escapeHtml(ids)}" title="Delete all reports in this group from the list (files are kept; restorable)">🗑 Delete</button>`}
            <button type="button" class="rep-act rep-purge" data-purge="1" data-ids="${escapeHtml(ids)}" title="Permanently delete every report in this group and all their files (cannot be undone)">⨯ Delete permanently</button>
          </div>`;
    return `<details class="rep-group" data-gid="${escapeHtml(g.id)}"${open ? " open" : ""}>
        <summary class="rep-group-head">
          <span class="rep-group-caret" aria-hidden="true">▸</span>
          <div class="rep-group-main">
            <span class="rep-group-title">${escapeHtml(g.title)}</span>
            <div class="rep-group-subline">
              ${gdate ? `<span class="rep-group-date" title="Latest completion ${escapeHtml(fmtEpoch(gdate))}">${escapeHtml(fmtDate(gdate))}</span>` : ""}
              <span class="rep-group-count">${n} report${n === 1 ? "" : "s"}</span>
            </div>
          </div>
          ${groupActions}
        </summary>
        <div class="rep-group-body">${cards}</div>
      </details>`;
  }).join("");
  wireReports(box);
}

// Bind all the interactive controls in the Reports view after a render. Centralised
// so both the populated and empty (toolbar-only) render paths share the wiring.
function wireReports(box) {
  box.querySelectorAll("details.rep-group").forEach((d) =>
    d.addEventListener("toggle", () => {
      if (d.open) reports.open.add(d.dataset.gid); else reports.open.delete(d.dataset.gid);
    }));
  box.querySelectorAll("[data-rv]").forEach((b) =>
    b.addEventListener("click", () => openArtifactReader(b.dataset.id, b.dataset.name, b.dataset.mime || "")));
  box.querySelectorAll("[data-rpub]").forEach((b) =>
    b.addEventListener("click", () => publishToWiki(b.dataset.id, b.dataset.name, b)));
  // Download/delete/restore live inside <summary> at the group level, so stop the
  // click from toggling the <details> (preventDefault) and from bubbling.
  box.querySelectorAll("[data-dl]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const url = `/api/reports/zip?ids=${encodeURIComponent(b.dataset.ids)}&name=${encodeURIComponent(b.dataset.name || "report")}`;
      triggerDownload(url);
    }));
  box.querySelectorAll("[data-hide]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const n = String(b.dataset.ids || "").split(",").filter(Boolean).length;
      const ok = confirm(n > 1
        ? `Delete all ${n} reports in this group from the list? The files are kept and can be restored.`
        : "Delete this report from the list? The files are kept and can be restored.");
      if (ok) setReportsHidden(b.dataset.ids, true, b);
    }));
  box.querySelectorAll("[data-unhide]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      setReportsHidden(b.dataset.ids, false, b);
    }));
  // Permanent, irreversible deletes — guarded by a confirm before anything leaves.
  box.querySelectorAll("[data-purge]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const n = String(b.dataset.ids || "").split(",").filter(Boolean).length;
      const ok = confirm(n > 1
        ? `Permanently delete all ${n} reports in this group and their files? This CANNOT be undone.`
        : "Permanently delete this report and all its files? This CANNOT be undone.");
      if (ok) purgeReports(b.dataset.ids, b);
    }));
  box.querySelectorAll("[data-fdel]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (confirm(`Permanently delete "${b.dataset.name}"? This CANNOT be undone.`))
        deleteReportFile(b.dataset.id, b.dataset.name, b);
    }));
  const tgl = box.querySelector("[data-toggle-hidden]");
  if (tgl) tgl.addEventListener("click", () => { reports.showHidden = !reports.showHidden; renderReports(); });
}

// Publish one artifact to the LLM Wiki via MC → board gateway bridge (which
// holds the wiki token; MC stays secret-free). Surfaces accepted / duplicate /
// quarantined. All UI built with textContent/createElement — never innerHTML of
// server text — so a report's contents can't inject markup.
async function publishToWiki(id, name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
  let kind = "err";
  let msg = "Publish failed.";
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(id)}/publish`,
                          { method: "POST", headers: headers(), body: JSON.stringify({ name }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      msg = (d && d.error) ? String(d.error) : `HTTP ${r.status}`;
    } else if (d.status === "quarantined") {
      kind = "warn";
      msg = "Quarantined by the wiki secret scan — review it in the wiki.";
    } else if (d.status === "duplicate" || d.deduplicated) {
      kind = "ok";
      msg = "Already in the wiki (duplicate).";
    } else {
      kind = "ok";
      msg = "Published — searchable in the wiki.";
    }
  } catch (e) {
    kind = "err";
    msg = "Publish failed — gateway unreachable.";
  }
  showPubResult(btn, kind, msg);
}

function showPubResult(btn, kind, msg) {
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = "Publish to Wiki";
  const row = btn.closest(".rep-file") || btn.parentElement;
  if (!row) return;
  let note = row.querySelector(".rep-pub-note");
  if (!note) { note = document.createElement("span"); row.appendChild(note); }
  note.className = `rep-pub-note rep-pub-${kind}`;
  note.textContent = msg + (kind === "err" ? "" : " ");
  if (kind !== "err") {
    const a = document.createElement("a");
    a.href = "https://wiki.ironnest.local/";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "ext-link";
    a.textContent = "Open wiki ↗";
    note.appendChild(a);
  }
}

let _reportSearchTimer = null;
(() => {
  const el = $("#reportSearch");
  if (!el) return;
  el.addEventListener("input", () => {
    if (_reportSearchTimer) clearTimeout(_reportSearchTimer);
    _reportSearchTimer = setTimeout(() => { reports.search = el.value.trim(); renderReports(); }, 200);
  });
})();

// ── Apps library ─────────────────────────────────────────────────────────────
// Runnable static webapp deliverables (folders with an index.html). Each app runs
// LIVE on the sandboxed apps origin (apps.ironnest.local) — a separate browser
// origin, so agent-authored HTML/JS can never script Mission Control.
const apps = { items: [], loaded: false, search: "", open: new Set(), showHistory: false };

async function loadApps() {
  const box = $("#appList");
  try {
    const d = await api("/api/apps");
    apps.items = (d && d.apps) || [];
    apps.loaded = true;
    renderApps();
  } catch (e) {
    if (!apps.loaded && box) box.innerHTML = `<p class="empty">Apps unavailable — is the board gateway up?</p>`;
  }
}

function appMatches(a, q) {
  if (!q) return true;
  const hay = `${a.name || ""} ${a.title || ""} ${displayName(a.assignee || "")} ${a.assignee || ""} ${a.status || ""}`.toLowerCase();
  return hay.includes(q);
}

function appCard(a) {
  // app_path "" = the whole task is one app; else a named subfolder.
  const sub = a.app_path || "";
  const label = sub || a.title;
  const dateHtml = a.updated
    ? `<span class="rep-date" title="Last updated ${escapeHtml(fmtEpoch(a.updated))}">${escapeHtml(fmtDate(a.updated))}</span>`
    : "";
  const zip = `/api/kanban/${encodeURIComponent(a.task_id)}/zip${sub ? `?sub=${encodeURIComponent(sub)}` : ""}`;
  const release = a.release || null;
  const candidate = a.candidate || null;
  const status = a.catalog_status || "unclassified";
  const candidateMeta = candidate
    ? `<span class="app-candidate-role ${escapeHtml(candidate.role)}">${escapeHtml(candidate.source === "automatic" ? `Suggested ${candidate.role === "product" ? "product" : candidate.role}` : (candidate.role === "product" ? "Release candidate" : candidate.role))}</span>
       <span class="app-check ${a.release_ready ? "ready" : "pending"}">${a.release_ready ? "Checklist complete" : "Checklist incomplete"}</span>`
    : `<span class="app-check pending">Unclassified</span>`;
  const releaseMeta = release
    ? `<span class="app-release-state ${escapeHtml(status)}">${status === "current" ? "● Current" : "History"}</span>
       <span class="app-project">${escapeHtml(release.project_name)}${release.release ? ` · ${escapeHtml(release.release)}` : ""}</span>
       ${release.purpose ? `<span class="app-purpose">${escapeHtml(release.purpose)}</span>` : ""}`
    : candidateMeta;
  const classify = status === "current" ? ""
    : candidate?.role === "product"
      ? `<button type="button" class="rep-act app-classify" data-classify-task="${escapeHtml(a.task_id)}" data-classify-path="${escapeHtml(sub)}" data-classify-name="${escapeHtml(label)}" data-classify-role="product" title="Record the evidence required for this product candidate">Complete checklist</button>`
      : `<button type="button" class="rep-act app-classify" data-classify-task="${escapeHtml(a.task_id)}" data-classify-path="${escapeHtml(sub)}" data-classify-name="${escapeHtml(label)}" data-classify-role="${escapeHtml(candidate?.role || "")}" title="Change the automatic artifact classification if needed">Override</button>`;
  const publish = status === "current" || !a.release_ready ? ""
    : `<button type="button" class="rep-act app-publish" data-publish-task="${escapeHtml(a.task_id)}" data-publish-path="${escapeHtml(sub)}" data-publish-name="${escapeHtml(label)}" title="Make this the current product release">Publish as current</button>`;
  return `<article class="app-card">
      <header class="rep-head">
        ${avatarHtml(a.assignee || "default", 28)}
        <div class="rep-head-main">
          <strong class="rep-title">${escapeHtml(label)}</strong>
          <div class="rep-subline">${dateHtml}</div>
          <div class="rep-meta">
            ${releaseMeta}
            ${a.status ? `<span class="tag">${escapeHtml(a.status)}</span>` : ""}
            <span class="rep-assignee">${escapeHtml(a.assignee ? displayName(a.assignee) : "—")}</span>
            <span class="rep-count">${Number(a.file_count) || 0} file${Number(a.file_count) === 1 ? "" : "s"} · ${escapeHtml(fmtBytes(a.bytes))}</span>
            ${sub ? `<span class="app-path-tag" title="from task ${escapeHtml(a.title)}">${escapeHtml(a.title)}</span>` : ""}
          </div>
        </div>
        <div class="rep-actions">
          <button type="button" class="rep-act app-open" data-open="${escapeHtml(a.url)}" data-name="${escapeHtml(label)}" title="Run this app in a sandboxed preview">▶ Open</button>
          <a class="rep-act" href="${escapeHtml(a.url)}" target="_blank" rel="noopener" title="Open the live app in a new tab">↗ New tab</a>
          <button type="button" class="rep-act rep-dl" data-zip="${escapeHtml(zip)}" data-name="${escapeHtml(label)}" title="Download the whole app folder as a .zip">⤓ .zip</button>
          ${classify}
          ${publish}
        </div>
      </header>
    </article>`;
}

function renderApps() {
  const box = $("#appList");
  if (!box) return;
  if (!apps.items.length) {
    box.innerHTML = `<p class="empty">No apps yet. When a task saves a folder containing an <code>index.html</code> into its artifacts, it appears here as a runnable app.</p>`;
    return;
  }
  const q = (apps.search || "").trim().toLowerCase();
  const rows = apps.items.filter((a) => appMatches(a, q) && (apps.showHistory || a.catalog_status === "current"));
  if (!rows.length) {
    box.innerHTML = apps.showHistory
      ? `<p class="empty">No apps match “${escapeHtml(apps.search)}”.</p>`
      : `<p class="empty">No current products have been published yet. Turn on <strong>Show delivery history</strong>, then choose the artifact that should become the current release.</p>`;
    return;
  }
  // Current releases group by product. Delivery history retains its originating
  // task group so build topology never obscures the product catalogue.
  const groups = new Map();
  for (const a of rows) {
    const published = a.release && a.catalog_status === "current";
    const gid = published ? `product-${a.release.project_id}` : (a.group_id || a.task_id);
    const title = published ? a.release.project_name : (a.group_title || a.title);
    if (!groups.has(gid)) groups.set(gid, { id: gid, title, items: [] });
    groups.get(gid).items.push(a);
  }
  const searching = !!q;
  box.innerHTML = [...groups.values()].map((g) => {
    const standalone = g.items.length === 1 && (g.id.startsWith("product-") || g.items[0].task_id === g.id);
    const cards = g.items.map(appCard).join("");
    if (standalone) return cards;
    const n = g.items.length;
    const open = searching || apps.open.has(g.id);
    const gdate = g.items.reduce((m, a) => Math.max(m, Number(a.updated) || 0), 0);
    return `<details class="rep-group" data-gid="${escapeHtml(g.id)}"${open ? " open" : ""}>
        <summary class="rep-group-head">
          <span class="rep-group-caret" aria-hidden="true">▸</span>
          <span class="rep-group-title">${escapeHtml(g.title)}</span>
          ${gdate ? `<span class="rep-group-date" title="Latest update ${escapeHtml(fmtEpoch(gdate))}">${escapeHtml(fmtDate(gdate))}</span>` : ""}
          <span class="rep-group-count">${n} app${n === 1 ? "" : "s"}</span>
        </summary>
        <div class="rep-group-body">${cards}</div>
      </details>`;
  }).join("");
  box.querySelectorAll("details.rep-group").forEach((d) =>
    d.addEventListener("toggle", () => {
      if (d.open) apps.open.add(d.dataset.gid); else apps.open.delete(d.dataset.gid);
    }));
  box.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openAppPreview(b.dataset.open, b.dataset.name)));
  box.querySelectorAll("[data-zip]").forEach((b) =>
    b.addEventListener("click", () => triggerDownload(b.dataset.zip)));
  box.querySelectorAll("[data-publish-task]").forEach((b) =>
    b.addEventListener("click", () => publishApp(b)));
  box.querySelectorAll("[data-classify-task]").forEach((b) =>
    b.addEventListener("click", () => classifyApp(b)));
}

async function classifyApp(button) {
  let cleanRole = button.dataset.classifyRole || "product";
  if (cleanRole !== "product") {
    const role = window.prompt("Override artifact role: product, implementation, review, deployment, demo, or internal", cleanRole);
    if (role === null) return;
    cleanRole = role.trim().toLowerCase();
  }
  const validRoles = new Set(["product", "implementation", "review", "deployment", "demo", "internal"]);
  if (!validRoles.has(cleanRole)) { window.alert("Choose one of: product, implementation, review, deployment, demo, internal."); return; }
  const payload = { task_id: button.dataset.classifyTask, app_path: button.dataset.classifyPath || "", role: cleanRole };
  if (cleanRole === "product") {
    const version = window.prompt("Release version (for example v1.0):", "v1.0"); if (version === null) return;
    const accepted = window.confirm("Has this exact artifact passed user acceptance testing?");
    const securityReview = window.prompt("Security review evidence (task name, ID, or URL):", ""); if (securityReview === null) return;
    const deploymentUrl = window.prompt("Verified deployment URL:", ""); if (deploymentUrl === null) return;
    const approvedBy = window.prompt("Approved by (person or team):", ""); if (approvedBy === null) return;
    Object.assign(payload, { version: version.trim(), acceptance_passed: accepted, security_review: securityReview.trim(), deployment_url: deploymentUrl.trim(), approved_by: approvedBy.trim() });
  }
  try {
    await api("/api/apps/candidate", { method: "POST", headers: headers(), body: JSON.stringify(payload) });
    await loadApps();
    setSync(cleanRole === "product" ? "Release checklist saved" : "Artifact classified");
  } catch (err) {
    setSync("Could not save artifact classification — admin token may be required");
  }
}

async function publishApp(button) {
  const fallback = button.dataset.publishName || "App";
  const projectName = window.prompt("Product name (this groups its release history):", fallback);
  if (projectName === null || !projectName.trim()) return;
  const release = window.prompt("Release label (for example v1.0):", "v1.0");
  if (release === null) return;
  const purpose = window.prompt("Short purpose (optional):", "");
  if (purpose === null) return;
  try {
    await api("/api/apps/publish", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ task_id: button.dataset.publishTask, app_path: button.dataset.publishPath || "", project_name: projectName.trim(), release: release.trim(), purpose: purpose.trim() }),
    });
    apps.showHistory = false;
    const toggle = $("#appHistoryToggle"); if (toggle) toggle.checked = false;
    await loadApps();
    setSync("Current product published");
  } catch (err) {
    setSync("Could not publish product — admin token may be required");
  }
}

// Open a live app in the sandboxed preview dialog. The iframe points at the apps
// origin (apps.ironnest.local), so it's a separate origin AND sandboxed — it can
// run scripts/forms but cannot reach Mission Control's DOM, storage, or cookies.
function openAppPreview(url, name) {
  const dlg = $("#appPreview");
  if (!dlg) { window.open(url, "_blank", "noopener"); return; }
  $("#appPreviewTitle").textContent = name || "App preview";
  const open = $("#appPreviewOpen");
  if (open) open.href = url;
  const frame = $("#appPreviewFrame");
  if (frame) { frame.dataset.src = url; frame.src = url; }
  dlg.showModal();
}
(() => {
  const reload = $("#appPreviewReload");
  if (reload) reload.addEventListener("click", () => {
    const f = $("#appPreviewFrame");
    if (f && f.dataset.src) f.src = f.dataset.src;
  });
  // Drop the iframe's network/WS when the dialog closes.
  const dlg = $("#appPreview");
  if (dlg) dlg.addEventListener("close", () => {
    const f = $("#appPreviewFrame");
    if (f) f.src = "about:blank";
  });
})();

let _appSearchTimer = null;
(() => {
  const el = $("#appSearch");
  if (!el) return;
  el.addEventListener("input", () => {
    if (_appSearchTimer) clearTimeout(_appSearchTimer);
    _appSearchTimer = setTimeout(() => { apps.search = el.value.trim(); renderApps(); }, 200);
  });
})();
(() => {
  const el = $("#appHistoryToggle");
  if (!el) return;
  el.addEventListener("change", () => { apps.showHistory = el.checked; renderApps(); });
})();

function renderSchedules() {
  renderCronCatchup();
  $("#scheduleList").innerHTML = state.schedules.map((schedule) => `
    <article class="schedule-card">
      <header>
        <div>
          <strong>${escapeHtml(schedule.title)}</strong>
          <p>${escapeHtml(schedule.detail || "No detail.")}</p>
        </div>
        <span class="tag">${escapeHtml(schedule.owner ? displayName(schedule.owner) : "—")}</span>
      </header>
      <div class="tag-row">
        <span class="tag">${escapeHtml(schedule.cadence)}</span>
        <span class="tag">${escapeHtml(schedule.next_run || "unscheduled")}</span>
      </div>
    </article>
  `).join("") || `<p class="empty">No schedules yet.</p>`;
}

function missedCronJobs() {
  return (state.cronJobs || [])
    .filter((j) => j.enabled && j.state !== "paused" && j.missed && j.missed_due_at)
    .sort((a, b) => String(a.missed_due_at).localeCompare(String(b.missed_due_at)));
}

function renderCronCatchup() {
  const panel = $("#cronCatchupPanel");
  const btn = $("#cronCatchupBtn");
  if (!panel || !btn) return;
  const missed = missedCronJobs();
  btn.disabled = cronCatchup.running || missed.length === 0;
  btn.textContent = cronCatchup.running ? "Catching up..." : "Catch up missed";
  panel.hidden = missed.length === 0 && !cronCatchup.running;
  if (panel.hidden) {
    panel.innerHTML = "";
    return;
  }
  const rows = missed.slice(0, 6).map((j) => `
    <div class="cron-missed-item">
      <span>${escapeHtml(displayName(j.owner || ""))}${j.owner ? " / " : ""}${escapeHtml(j.name || j.id || "job")}</span>
      <time>${escapeHtml(formatTime(j.missed_due_at))}</time>
    </div>
  `).join("");
  const more = missed.length > 6 ? `<span class="tag">+${missed.length - 6} more</span>` : "";
  panel.innerHTML = `
    <div class="cron-catchup-head">
      <strong>${missed.length} missed ${missed.length === 1 ? "schedule" : "schedules"}</strong>
      ${more}
    </div>
    <div class="cron-missed-list">${rows || `<p class="empty">Checking schedules...</p>`}</div>
  `;
}

async function catchUpMissedCron() {
  if (cronCatchup.running) return;
  const missed = missedCronJobs();
  if (!missed.length) {
    setSync("No missed schedules");
    return;
  }
  cronCatchup.running = true;
  renderCronCatchup();
  try {
    const result = await api("/api/schedules/cron/catch-up", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    const ran = (result && result.ran && result.ran.length) || 0;
    const skipped = (result && result.skipped && result.skipped.length) || 0;
    setSync(ran ? `Caught up ${ran} missed ${ran === 1 ? "schedule" : "schedules"}` : (skipped ? "Nothing ran" : "No missed schedules"));
    await loadCron();
  } catch (err) {
    setSync("Catch-up failed");
  } finally {
    cronCatchup.running = false;
    renderCronCatchup();
  }
}

// ── 7-day calendar view ──────────────────────────────────────────────────────
// Schedules carry free-text `cadence` (e.g. "daily 09:00", "weekdays at 6am",
// "mon,thu", a 5-field cron, or "manual") and `next_run` (e.g. an ISO date).
// We resolve, for each of the next 7 days, the run times that land on that day.
const DOW_NAMES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekDays() {
  const out = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push(d);
  }
  return out;
}

// Pull a "HH:MM" (24h) out of free text — accepts 24h ("18:30") and 12h ("6pm",
// "9:15 am"). Returns null if none found.
function parseTimeOfDay(str) {
  if (!str) return null;
  const s = String(str);
  let m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  m = s.match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s*([ap])\.?m\.?\b/i);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (m[3].toLowerCase() === "p") h += 12;
    return `${String(h).padStart(2, "0")}:${m[2] || "00"}`;
  }
  return null;
}

// Match one cron field (e.g. "*", "1-5", "*/2", "0,30") against a value.
function cronFieldMatches(field, value, lo, hi) {
  if (!field || field === "*") return true;
  for (const part of field.split(",")) {
    let expr = part;
    let step = 1;
    if (expr.includes("/")) {
      const [a, b] = expr.split("/");
      expr = a;
      step = parseInt(b, 10) || 1;
    }
    let start;
    let end;
    if (expr === "*") { start = lo; end = hi; }
    else if (expr.includes("-")) { const [a, b] = expr.split("-"); start = +a; end = +b; }
    else { start = end = +expr; }
    for (let v = start; v <= end; v += step) {
      if (v === value) return true;
    }
  }
  return false;
}

function parseCron(s) {
  const fields = (s || "").trim().split(/\s+/);
  if (fields.length !== 5 || !/^[\d*/,\-]+$/.test(fields.join(""))) return null;
  const [min, hr, dom, mon, dow] = fields;
  let time = null;
  if (/^\d+$/.test(hr) && /^\d+$/.test(min)) {
    time = `${hr.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  return { min, hr, dom, mon, dow, time };
}

function cronMatchesDay(c, d) {
  if (!cronFieldMatches(c.mon, d.getMonth() + 1, 1, 12)) return false;
  const domOk = cronFieldMatches(c.dom, d.getDate(), 1, 31);
  // cron allows 0 or 7 for Sunday; normalise 7 -> 0 before matching getDay().
  const dowOk = cronFieldMatches(c.dow.replace(/\b7\b/g, "0"), d.getDay(), 0, 6);
  if (c.dom !== "*" && c.dow !== "*") return domOk || dowOk;
  return domOk && dowOk;
}

// Expand a single cron field (minute or hour) to the sorted list of values it
// matches in [lo, hi]. Handles "*", lists, ranges, and steps.
function cronFieldValues(field, lo, hi) {
  const out = new Set();
  for (const part of (field || "*").split(",")) {
    let expr = part;
    let step = 1;
    if (expr.includes("/")) {
      const [a, b] = expr.split("/");
      expr = a;
      step = parseInt(b, 10) || 1;
    }
    let start;
    let end;
    if (expr === "*" || expr === "") { start = lo; end = hi; }
    else if (expr.includes("-")) { const [a, b] = expr.split("-"); start = +a; end = +b; }
    else { start = end = +expr; }
    for (let v = start; v <= end; v += step) {
      if (v >= lo && v <= hi) out.add(v);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// Concrete "HH:MM" run-times a cron expr fires at within a day, sorted. Returns
// null when the minute×hour grid is too dense to enumerate sanely (e.g. a
// per-minute job) — the caller then shows a generic "cron" chip instead.
function cronRunTimes(c) {
  const mins = cronFieldValues(c.min, 0, 59);
  const hrs = cronFieldValues(c.hr, 0, 23);
  if (mins.length * hrs.length > 48) return null;
  const out = [];
  for (const h of hrs) {
    for (const m of mins) {
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return out.sort();
}

// Resolve a schedule to a per-day list of run entries across `days`.
// Returns an array (length = days.length) of [{ time, times, label }]; ONE entry
// per job per day. `times` is every run-time that day (so the chip label can be
// honest — a list for a few, a range + ×N for many); `time` is the first run,
// used only for sorting; `label` carries a non-clock descriptor ("hourly"/"cron").
function occurrencesFor(schedule, days) {
  const res = days.map(() => []);
  const cadence = (schedule.cadence || "").trim();
  const nextRun = (schedule.next_run || "").trim();
  const hay = `${cadence} ${nextRun}`.toLowerCase();
  const time = parseTimeOfDay(cadence) || parseTimeOfDay(nextRun);

  const cron = parseCron(cadence);
  if (cron) {
    days.forEach((d, i) => {
      if (!cronMatchesDay(cron, d)) return;
      const times = cronRunTimes(cron);
      if (!times || times.length === 0) {
        res[i].push({ time: cron.time, label: cron.time ? null : "cron" });
      } else {
        res[i].push({ time: times[0], times });  // one chip; full run list rides along
      }
    });
    return res;
  }

  const hourly = /\bhourly\b|every\s+hour/.test(hay);
  const everyDay = hourly || /\bdaily\b|every\s*day|everyday/.test(hay);
  let dowSet = null;
  if (/weekday|business day|mon(day)?\s*[-–]\s*fri(day)?/.test(hay)) dowSet = new Set([1, 2, 3, 4, 5]);
  if (/weekend/.test(hay)) { dowSet = dowSet || new Set(); [0, 6].forEach((n) => dowSet.add(n)); }
  for (const [name, n] of Object.entries(DOW_NAMES)) {
    if (new RegExp(`\\b${name}\\b`).test(hay)) { dowSet = dowSet || new Set(); dowSet.add(n); }
  }

  if (everyDay) {
    days.forEach((_, i) => res[i].push({ time, label: hourly && !time ? "hourly" : null }));
  } else if (dowSet && dowSet.size) {
    days.forEach((d, i) => { if (dowSet.has(d.getDay())) res[i].push({ time, label: null }); });
  }

  // A concrete ISO date in next_run (one-off) — add it if it lands in-window and
  // a recurrence rule hasn't already covered that day.
  const iso = nextRun.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const key = `${iso[1]}-${iso[2]}-${iso[3]}`;
    days.forEach((d, i) => { if (dateKey(d) === key && res[i].length === 0) res[i].push({ time, label: null }); });
  }

  return res;
}

// Map a Hermes cron job into the shape occurrencesFor() understands: its cron
// `expr` becomes the cadence (the parser handles 5-field cron), and next_run_at
// the next_run. Owner + a short detail line ride along for the card tooltip.
function cronJobToSchedule(j) {
  const bits = [];
  if (j.deliver) bits.push(`→ ${j.deliver}`);
  if (j.skill) bits.push(`skill: ${j.skill}`);
  else if (j.script) bits.push(`script: ${j.script}`);
  return {
    title: j.name,
    owner: j.owner,
    cadence: j.expr || j.schedule_display || "",
    next_run: j.next_run_at || "",
    detail: bits.join(" • "),
    source: "cron",
  };
}

// Human-readable run label for a day's chip: a single time, a short comma list
// (≤3 runs), or a "first–last" range with a ×N count for many runs.
function runDisplay(e) {
  const t = e.times;
  if (t && t.length) {
    if (t.length === 1) return { text: t[0], count: 0 };
    if (t.length <= 3) return { text: t.join(", "), count: 0 };
    return { text: `${t[0]}–${t[t.length - 1]}`, count: t.length };
  }
  return { text: e.time || e.label || "—", count: 0 };
}

function renderCalendar() {
  const el = $("#weekGrid");
  if (!el) return;
  const days = weekDays();
  const todayKey = dateKey(new Date());
  const perDay = days.map(() => []);
  // Real Hermes cron jobs (enabled, not paused) + MC's manual schedule store.
  const cron = (state.cronJobs || [])
    .filter((j) => j.enabled && j.state !== "paused")
    .map(cronJobToSchedule);
  const manual = (state.schedules || []).map((s) => ({ ...s, source: "manual" }));
  [...cron, ...manual].forEach((s) => {
    occurrencesFor(s, days).forEach((list, i) => {
      list.forEach((o) => perDay[i].push({ ...o, s }));
    });
  });

  el.innerHTML = days.map((d, i) => {
    const entries = perDay[i].sort((a, b) => (a.time || "~~").localeCompare(b.time || "~~"));
    const dayName = d.toLocaleDateString(undefined, { weekday: "short" });
    const dayNum = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const isToday = dateKey(d) === todayKey;
    const runs = entries.length ? entries.map((e) => {
      const disp = runDisplay(e);
      const allTimes = e.times && e.times.length > 3 ? ` • runs: ${e.times.join(", ")}` : "";
      const tip = `${e.s.title} — ${e.s.cadence || ""}${allTimes}${e.s.detail ? ` • ${e.s.detail}` : ""}`;
      return `
      <div class="cal-run cal-run--${e.s.source === "cron" ? "cron" : "manual"}" title="${escapeHtml(tip)}">
        <div class="cal-run-top">
          <span class="cal-time">${escapeHtml(disp.text)}</span>
          ${disp.count ? `<span class="cal-count">×${disp.count}</span>` : ""}
        </div>
        <span class="cal-title">${escapeHtml(e.s.title)}</span>
        ${e.s.owner ? `<span class="cal-owner">${escapeHtml(displayName(e.s.owner))}</span>` : ""}
      </div>`;
    }).join("") : `<p class="cal-empty">—</p>`;
    return `<article class="day-col${isToday ? " today" : ""}">
      <header><span class="day-name">${escapeHtml(dayName)}</span><span class="day-num">${escapeHtml(dayNum)}</span></header>
      <div class="day-runs">${runs}</div>
    </article>`;
  }).join("");
}

function renderMemory() {
  $("#memoryList").innerHTML = state.profiles.map((profile) => `
    <article class="namespace-card">
      <strong>${escapeHtml(profile.name)}</strong>
      <p>${escapeHtml(profile.namespace)}</p>
      <p>${escapeHtml(profile.approved_shared_namespace)}</p>
    </article>
  `).join("");
  const memoryEvents = state.activity.filter((item) => ["read", "write", "search", "publish-approved"].includes(item.operation));
  $("#memorySignals").innerHTML = memoryEvents.slice(0, 12).map((item) => `
    <article class="feed-item">
      <small>${escapeHtml(formatTime(item.ts))}</small>
      <div><strong>${escapeHtml(item.profile)}</strong><div class="muted">${escapeHtml(item.operation)} ${escapeHtml(item.uri)}</div></div>
      <span class="decision ${item.decision === "deny" ? "deny" : ""}">${escapeHtml(item.decision)}</span>
    </article>
  `).join("") || `<p class="empty">No memory activity in the recent audit window.</p>`;
}

function renderDocs() {
  const docs = [
    ["Architecture", "/docs/01-ARCHITECTURE.md", "System map and trust boundaries."],
    ["Operations", "/docs/12-OPERATIONS-RUNBOOK.md", "Runtime checks and response paths."],
    ["Security", "/docs/08-SECURITY-MODEL.md", "Policy, auth, audit, and isolation model."],
    ["Memory", "/docs/18-AUTOMATIC-CONVERSATIONAL-MEMORY.md", "Hermes memory lifecycle path."],
  ];
  $("#docsIndex").innerHTML = docs.map(([title, path, detail]) => `
    <article class="doc-card">
      <strong>${title}</strong>
      <p>${detail}</p>
      <div class="tag-row"><span class="tag">${path}</span></div>
    </article>
  `).join("");
}

function renderOrg() {
  const el = $("#orgMap");
  if (!el) return;   // Org map was removed from the Team view; directory replaces it.
  el.innerHTML = state.profiles.map((profile) => {
    const lead = profile.name === "default" ? "Lead operator" : profile.tags.includes("dynamic") ? "Specialist" : "Profile agent";
    return `
      <article class="org-card">
        <header>
          <strong>${escapeHtml(displayName(profile.name))}</strong>
          <span class="tag">${lead}</span>
        </header>
        <p>${escapeHtml(profile.notes || "No mission statement recorded yet.")}</p>
      </article>
    `;
  }).join("");
}

// ── Team directory (overhauled Team view) ───────────────────────────────────
const TEAM_TOOL_LABEL = {
  web: "Web", browser: "Browser", terminal: "Terminal", code_execution: "Code",
  vision: "Vision", image_gen: "Images", tts: "Voice", video: "Video",
  delegation: "Delegation", cronjob: "Cron", kanban: "Kanban",
};
// Built-in plumbing every agent carries — suppressed so a card highlights what
// differentiates an agent, not the baseline.
const TEAM_GENERIC_TOOLSETS = new Set(
  ["memory", "skills", "todo", "clarify", "session_search", "messaging", "file", "computer_use"]);
const TEAM_RARE_MAX = 2;  // a skill carried by ≤2 agents is a "specialist" skill
// Recreational/generic categories + names never count as a "specialty" even when
// rare — otherwise a skill that's rare only because it was pruned elsewhere
// (e.g. a game on the one agent that kept it) would masquerade as a specialty.
const TEAM_NONSPECIAL_CATS = new Set(["gaming", "smart-home", "social-media", "media", "builtin"]);
const TEAM_NONSPECIAL_NAMES = new Set(["airtable", "yuanbao", "spotify", "gif-search", "xurl"]);
function teamIsSpecialist(name, cat, counts) {
  return (counts[name] || 99) <= TEAM_RARE_MAX
    && !TEAM_NONSPECIAL_CATS.has(cat) && !TEAM_NONSPECIAL_NAMES.has(name);
}

// How many of the loaded agents carry each skill — the cross-agent rarity that
// flags specialists (only Mission Control sees the whole roster, so it computes
// this, not the per-container bridge).
function teamSkillCounts() {
  const count = {};
  for (const p of state.profiles) {
    const sk = (chat.agentInfo[p.name] || {}).skills;
    if (!sk || !sk.by_category) continue;
    const names = new Set();
    Object.values(sk.by_category).forEach((arr) => arr.forEach((n) => names.add(n)));
    names.forEach((n) => { count[n] = (count[n] || 0) + 1; });
  }
  return count;
}

function mcpFallbackServers(m) {
  return (((m.tools || {}).mcp) || []).map((name) => ({
    name, status: "unknown", transport: "", lifecycle: "unknown",
    scope: "Agent tool surface", gated: false,
  }));
}

function mcpDataFor(name, m) {
  const live = chat.mcpHealth[name];
  const fallback = mcpFallbackServers(m || {});
  const servers = (live && Array.isArray(live.servers) && live.servers.length) ? live.servers : fallback;
  const summary = live && live.summary ? live.summary : {
    configured: servers.length,
    online: servers.filter((s) => s.status === "online").length,
    standby: servers.filter((s) => s.status === "standby").length,
    disabled: servers.filter((s) => s.status === "disabled").length,
    offline: servers.filter((s) => s.status === "offline").length,
    unknown: servers.filter((s) => !s.status || s.status === "unknown").length,
    gated: servers.filter((s) => s.gated).length,
    on_demand: servers.filter((s) => s.lifecycle === "on-demand").length,
  };
  return { servers, summary, error: live && live.error, cached: live && live.cached };
}

function mcpSummaryHtml(name, m) {
  const data = mcpDataFor(name, m);
  const configured = Number(data.summary.configured || data.servers.length || 0);
  if (!configured) return "";
  const online = Number(data.summary.online || 0);
  const parts = [
    `<button type="button" class="tc-mcp-summary" data-mcp="${escapeHtml(name)}" title="View MCP servers">MCP ${online}/${configured}</button>`,
  ];
  if (data.summary.gated) parts.push(`<span class="tc-chip mcp-state">Gated</span>`);
  if (data.summary.on_demand) parts.push(`<span class="tc-chip mcp-state">On-demand</span>`);
  if (data.summary.standby) parts.push(`<span class="tc-chip mcp-standby">${data.summary.standby} standby</span>`);
  if (data.summary.offline) parts.push(`<span class="tc-chip mcp-offline">${data.summary.offline} offline</span>`);
  if (data.summary.unknown && !online) parts.push(`<span class="tc-chip more">checking</span>`);
  return `<div class="tc-row-label">MCP</div><div class="tc-chips tc-mcp-line">${parts.join("")}</div>`;
}

let _teamLoading = false;
async function loadTeam() {
  if (_teamLoading) return;
  _teamLoading = true;
  const grid = $("#teamGrid");
  if (grid) renderTeam();
  try {
    const jobs = state.profiles.map(async (p) => {
      const cached = chat.agentInfo[p.name];
      if (cached && cached.loaded && cached.online !== false) return;
      await loadAgentInfo(p.name);
      if ($("#view-team")?.classList.contains("active")) renderTeam();
    });
    await Promise.allSettled(jobs);
  } finally {
    _teamLoading = false;
    renderTeam();
  }
}

function renderTeam() {
  const grid = $("#teamGrid");
  if (!grid) return;
  const counts = teamSkillCounts();
  grid.innerHTML = state.profiles.map((p) => teamCard(p, counts)).join("");
}

function teamCard(p, counts) {
  const name = p.name;
  const m = chat.agentInfo[name] || {};
  const tools = m.tools || { toolsets: [], mcp: [] };
  const skills = m.skills || { count: 0, by_category: {} };
  const nonGeneric = (tools.toolsets || []).filter((t) => !TEAM_GENERIC_TOOLSETS.has(t));
  const shownTools = nonGeneric.slice(0, 4);
  const moreCaps = nonGeneric.length - shownTools.length;
  const capChips = [
    ...shownTools.map((t) => `<span class="tc-chip">${escapeHtml(TEAM_TOOL_LABEL[t] || t)}</span>`),
    ...(moreCaps > 0 ? [`<span class="tc-chip more">+${moreCaps}</span>`] : []),
  ].join("");

  const specAll = [];
  for (const [cat, names] of Object.entries(skills.by_category || {}))
    for (const n of names) if (teamIsSpecialist(n, cat, counts)) specAll.push(n);
  const specChips = specAll.slice().sort().slice(0, 4)
    .map((n) => `<span class="tc-chip spec">${escapeHtml(n)}</span>`).join("");
  const skillsLabel = skills.count
    ? `${skills.count} skills${specAll.length ? ` · <span class="tc-spec-n">${specAll.length} specialist</span>` : ""}`
    : "no skills";
  const skillsBtn = `<button type="button" class="tc-skills-btn" data-skills="${escapeHtml(name)}" title="See all skills">${skillsLabel}</button>`;

  const model = m.model
    ? `${escapeHtml(m.model)}${m.provider ? ` <span class="tc-prov">${escapeHtml(m.provider)}</span>` : ""}`
    : `<span class="muted">model unknown</span>`;
  const bio = m.bio || m.description || p.description || (m.loaded ? "No description." : "Loading…");
  const title = m.role_title ? `<div class="tc-role">${escapeHtml(m.role_title)}</div>` : "";
  const dotCls = m.online === false ? "offline" : (m.loaded ? "online" : "");

  return `
    <article class="tc-card">
      <div class="tc-head">
        <button type="button" class="tc-ava" data-team-settings="${escapeHtml(name)}" title="Edit ${escapeHtml(displayName(name))}">${avatarHtml(name, 54)}</button>
        <div class="tc-id">
          <div class="tc-name">${escapeHtml(displayName(name))}<span class="tc-dot ${dotCls}"></span></div>
          ${title}
          <div class="tc-model"><span class="tc-model-ic" aria-hidden="true">⚙</span>${model}</div>
        </div>
      </div>
      <p class="tc-bio">${escapeHtml(bio)}</p>
      <div class="tc-row-label">Capabilities</div>
      <div class="tc-chips">${capChips || '<span class="muted">—</span>'}</div>
      ${mcpSummaryHtml(name, m)}
      <div class="tc-row-label">Skills</div>
      <div class="tc-chips">${specChips}${skillsBtn}</div>
      <div class="tc-foot">
        <div class="tc-tags">${(p.tags || []).slice(0, 2).map((t) => `<span class="tc-tag">${escapeHtml(t)}</span>`).join("")}</div>
        <div class="tc-actions">
          <button type="button" class="tc-btn" data-team-settings="${escapeHtml(name)}">Settings</button>
          <button type="button" class="tc-btn primary" data-team-chat="${escapeHtml(name)}">Chat</button>
        </div>
      </div>
    </article>`;
}

function openSkillsDialog(name) {
  const m = chat.agentInfo[name] || {};
  const skills = m.skills || { count: 0, by_category: {} };
  const counts = teamSkillCounts();
  const cats = Object.keys(skills.by_category || {}).sort();
  const body = cats.map((cat) => {
    const items = skills.by_category[cat].slice().sort().map((n) => {
      const spec = teamIsSpecialist(n, cat, counts);
      return `<span class="tc-chip ${spec ? "spec" : ""}">${escapeHtml(n)}</span>`;
    }).join("");
    return `<div class="sk-cat"><div class="sk-cat-h">${escapeHtml(cat)} · ${skills.by_category[cat].length}</div><div class="sk-cat-chips">${items}</div></div>`;
  }).join("") || `<p class="empty">No skills.</p>`;
  $("#skillsDialogTitle").textContent = `${displayName(name)} · ${skills.count} skills`;
  $("#skillsDialogBody").innerHTML = body;
  $("#skillsDialog").showModal();
}

function mcpStatusClass(status) {
  if (status === "online") return "online";
  if (status === "standby" || status === "disabled") return "standby";
  if (status === "offline") return "offline";
  return "unknown";
}

function mcpActionButtons(name, server) {
  const safeProfile = escapeHtml(name);
  const safeServer = escapeHtml(server.name || "");
  const refresh = `<button type="button" class="art-btn" data-mcp-refresh="${safeProfile}">Test</button>`;
  const config = `<button type="button" class="art-btn" data-mcp-config="${safeServer}">View Config</button>`;
  const lifecycle = server.lifecycle === "on-demand"
    ? `<button type="button" class="art-btn" data-mcp-lifecycle="start" data-profile="${safeProfile}" data-server="${safeServer}">Request Start</button>
       <button type="button" class="art-btn" data-mcp-lifecycle="restart" data-profile="${safeProfile}" data-server="${safeServer}">Request Restart</button>`
    : "";
  return `${refresh}${config}${lifecycle}`;
}

function openMcpDialog(name) {
  const m = chat.agentInfo[name] || {};
  const data = mcpDataFor(name, m);
  const summary = data.summary || {};
  const configured = Number(summary.configured || data.servers.length || 0);
  const title = `${displayName(name)} · MCP ${Number(summary.online || 0)}/${configured}`;
  $("#mcpDialogTitle").textContent = title;
  const breakdown = configured
    ? `<div class="mcp-breakdown">
        <span>Online: ${Number(summary.online || 0)}</span>
        <span>Standby: ${Number(summary.standby || 0)}</span>
        <span>Disabled: ${Number(summary.disabled || 0)}</span>
        <span>Offline: ${Number(summary.offline || 0)}</span>
        <span>Unknown: ${Number(summary.unknown || 0)}</span>
      </div>`
    : `<p class="empty">No configured MCP servers.</p>`;
  const rows = data.servers.map((server) => {
    const status = server.status || "unknown";
    const detail = [
      server.transport ? `Transport: ${server.transport}` : "",
      server.lifecycle ? `Lifecycle: ${server.lifecycle}` : "",
      server.scope ? `Scope: ${server.scope}` : "",
      server.duration_ms != null ? `Last test: ${server.duration_ms}ms` : "",
      server.message || "",
    ].filter(Boolean).join(" · ");
    return `<article class="mcp-row">
      <div class="mcp-row-main">
        <div>
          <strong>${escapeHtml(server.name || "unknown")}</strong>
          <p>${escapeHtml(detail || "No detail available.")}</p>
        </div>
        <span class="mcp-status ${mcpStatusClass(status)}">${escapeHtml(status)}</span>
      </div>
      <div class="mcp-row-tags">
        ${server.gated ? `<span class="tc-chip mcp-state">Gated</span>` : ""}
        ${server.lifecycle === "on-demand" ? `<span class="tc-chip mcp-state">On-demand</span>` : ""}
        ${server.enabled === false ? `<span class="tc-chip mcp-standby">Disabled</span>` : ""}
      </div>
      <div class="mcp-row-actions">${mcpActionButtons(name, server)}</div>
    </article>`;
  }).join("");
  $("#mcpDialogBody").innerHTML = `${breakdown}${rows || ""}<p id="mcpDialogStatus" class="settings-status" aria-live="polite">${data.error ? escapeHtml(data.error) : ""}</p>`;
  $("#mcpDialog").showModal();
}

async function requestMcpLifecycle(profile, server, action) {
  const status = $("#mcpDialogStatus");
  if (status) status.textContent = `Requesting ${action} for ${server}...`;
  try {
    await api("/api/operations/requests", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        action,
        target: server,
        requested_by: "operator",
        reason: `MCP lifecycle request from Team drawer for ${displayName(profile)}.`,
      }),
    });
    if (status) status.textContent = `${action} request created.`;
    loadOperations();
  } catch (err) {
    if (status) status.textContent = "Request failed. Check admin token and approved targets.";
  }
}

function gotoChat(name) {
  activateView("agent");
  selectProfile(name);
}

// Team grid actions (delegated) + the Directory/Org-map toggle.
(function wireTeam() {
  const grid = $("#teamGrid");
  if (grid) grid.addEventListener("click", (e) => {
    const mcp = e.target.closest("[data-mcp]");
    if (mcp) { openMcpDialog(mcp.dataset.mcp); return; }
    const sk = e.target.closest("[data-skills]");
    if (sk) { openSkillsDialog(sk.dataset.skills); return; }
    const ch = e.target.closest("[data-team-chat]");
    if (ch) { gotoChat(ch.dataset.teamChat); return; }
    const se = e.target.closest("[data-team-settings]");
    if (se) { openAgentSettings(se.dataset.teamSettings); return; }
  });
  const toggle = $("#teamToggle");
  if (toggle) toggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".tt-btn");
    if (!btn) return;
    toggle.querySelectorAll(".tt-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const isOrg = btn.dataset.teamView === "org";
    $("#teamGrid").hidden = isOrg;
    $("#orgMap").hidden = !isOrg;
  });
})();

const _mcpDialogBody = $("#mcpDialogBody");
if (_mcpDialogBody) _mcpDialogBody.addEventListener("click", async (e) => {
  const refresh = e.target.closest("[data-mcp-refresh]");
  if (refresh) {
    const status = $("#mcpDialogStatus");
    if (status) status.textContent = "Testing MCP servers...";
    await loadAgentsHealth();
    openMcpDialog(refresh.dataset.mcpRefresh);
    return;
  }
  const lifecycle = e.target.closest("[data-mcp-lifecycle]");
  if (lifecycle) {
    await requestMcpLifecycle(lifecycle.dataset.profile, lifecycle.dataset.server, lifecycle.dataset.mcpLifecycle);
    return;
  }
  const config = e.target.closest("[data-mcp-config]");
  if (config) {
    const status = $("#mcpDialogStatus");
    if (status) status.textContent = `Config details for ${config.dataset.mcpConfig} are shown in its row.`;
  }
});

function renderOffice() {
  $("#officeMap").innerHTML = state.profiles.map((profile) => {
    const active = state.tasks.filter((task) => task.assignee === profile.name && task.status !== "done").length;
    return `
      <article class="desk">
        <div class="avatar">${escapeHtml(profile.name.slice(0, 2).toUpperCase())}</div>
        <div>
          <strong>${escapeHtml(displayName(profile.name))}</strong>
          <p class="muted">${active} open tasks</p>
        </div>
      </article>
    `;
  }).join("");
}

function renderSelects() {
  const options = state.profiles.map((profile) => `<option value="${escapeHtml(profile.name)}">${escapeHtml(displayName(profile.name))}</option>`).join("");
  $("#taskAssignee").innerHTML = options;
  $("#scheduleOwner").innerHTML = options;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

// (Old /api/tasks moveTask/createTask removed — the board is now the shared
//  Hermes kanban, driven by the kanban* functions above.)

async function createSchedule(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const response = await fetch("/api/schedules", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(data),
  });
  setSync(response.ok ? "Schedule created" : (response.status === 401 ? "Admin token required" : "Create failed"));
  await loadState();
}

// Switch to a view: highlight its nav item, show its section, lazy-load its
// data, and remember it so a refresh returns here instead of Overview.
const VIEW_STORE_KEY = "mc.activeView";

function activateView(view) {
  const section = $(`#view-${view}`);
  if (!section) return false;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const navBtn = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navBtn) navBtn.classList.add("active");
  section.classList.add("active");
  if (view === "terminal") ensureTerminal();
  if (view === "wiki") ensureWiki();
  if (view === "tasks") loadKanban();
  if (view === "approvals") loadOperations();
  if (view === "reports") loadReports();
  if (view === "apps") loadApps();
  if (view === "calendar") loadCron();
  if (view === "team") loadTeam();
  try { localStorage.setItem(VIEW_STORE_KEY, view); } catch (e) { /* storage unavailable */ }
  return true;
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    // External-link nav items (e.g. Memory → LLM Wiki) open in a new tab and
    // do NOT change the in-app view or active highlight.
    if (button.dataset.href) {
      window.open(button.dataset.href, "_blank", "noopener");
      return;
    }
    activateView(button.dataset.view);
  });
});

// Lazy-load the embedded ttyd iframe only when the Terminal view is first opened
// (avoids holding a WebSocket to the agent terminal while it's not in view).
function savedTerminalTarget() {
  try { return localStorage.getItem(TERMINAL_STORE_KEY) || "platform"; } catch (e) { return "platform"; }
}
terminal.activeId = savedTerminalTarget();

function currentTerminalTarget() {
  return terminal.targets.find((t) => t.id === terminal.activeId) || terminal.targets[0] || DEFAULT_TERMINAL_TARGET;
}

function terminalTargetOffline(target) {
  if (!target || !target.url) return true;
  if (target.kind === "agent") {
    const profile = state.profiles.find((p) => p.name === target.id);
    if (profile && profile.status !== "enabled") return true;
    if (chat.health[target.id] === false) return true;
  }
  return target.status === "offline";
}

function terminalTargetLabel(target) {
  if (!target) return "Terminal";
  return target.kind === "agent" ? displayName(target.id) : (target.label || "Platform");
}

function terminalTargetSubtitle(target) {
  if (!target || target.kind === "platform") {
    return "hermes-platform management terminal · runs as the hermes user · FIDO-gated";
  }
  const container = target.container_name || `hermes-pf-${target.id}`;
  if ((target.url || "").replace(/\/+$/, "") === DEFAULT_TERMINAL_TARGET.url.replace(/\/+$/, "")) {
    return `${terminalTargetLabel(target)} selected · platform terminal · ${container} · FIDO-gated`;
  }
  return `${terminalTargetLabel(target)} shell · ${container} · FIDO-gated`;
}

function terminalTargetAvatar(target, size) {
  if (target.kind === "agent") return avatarHtml(target.id, size);
  const box = `width:${size}px;height:${size}px`;
  return `<span class="ava term-platform-ava" style="${box};font-size:${Math.round(size * 0.38)}px">PF</span>`;
}

function syncTerminalTarget(loadFrame = false) {
  const target = currentTerminalTarget();
  const url = target.url || DEFAULT_TERMINAL_TARGET.url;
  const f = $("#termFrame");
  const open = $("#termOpen");
  const sub = $("#termSub");
  if (f) {
    f.dataset.src = url;
    f.title = `${terminalTargetLabel(target)} terminal`;
    if (loadFrame || (f.getAttribute("src") && f.getAttribute("src") !== url)) f.src = url;
  }
  if (open) open.href = url;
  if (sub) sub.textContent = terminalTargetSubtitle(target);
}

function selectTerminalTarget(id, loadFrame = true) {
  const target = terminal.targets.find((t) => t.id === id);
  if (!target || terminalTargetOffline(target)) return;
  terminal.activeId = id;
  try { localStorage.setItem(TERMINAL_STORE_KEY, id); } catch (e) { /* storage unavailable */ }
  renderTerminalTargets();
  syncTerminalTarget(loadFrame);
}

function renderTerminalTargets() {
  const box = $("#termTargetDock");
  if (!box) return;
  const targets = terminal.targets.length ? terminal.targets : [DEFAULT_TERMINAL_TARGET];
  if (terminal.loaded && !targets.some((t) => t.id === terminal.activeId && !terminalTargetOffline(t))) {
    terminal.activeId = (targets.find((t) => !terminalTargetOffline(t)) || targets[0]).id;
  }
  box.innerHTML = targets.map((target) => {
    const active = target.id === terminal.activeId || (!terminal.loaded && target.id === "platform");
    const offline = terminalTargetOffline(target);
    const cls = ["term-target", active ? "active" : "", offline ? "offline" : ""].filter(Boolean).join(" ");
    const status = offline ? "offline" : "online";
    const disabled = offline ? "disabled" : "";
    const label = terminalTargetLabel(target);
    return `<button type="button" class="${cls}" data-term-target="${escapeHtml(target.id)}" ${disabled} role="tab" aria-selected="${active ? "true" : "false"}" aria-label="${escapeHtml(label)} shell" title="${escapeHtml(label)} · ${status}">
      ${terminalTargetAvatar(target, active ? 34 : 30)}<span class="status-dot"></span><span class="term-target-name">${escapeHtml(label)}</span>
    </button>`;
  }).join("");
  box.querySelectorAll("[data-term-target]").forEach((el) => {
    el.addEventListener("click", () => selectTerminalTarget(el.dataset.termTarget, true));
  });
  syncTerminalTarget(false);
}

async function loadTerminalTargets() {
  try {
    const data = await api("/api/terminal-targets");
    const targets = (data && Array.isArray(data.targets) ? data.targets : []).filter((t) => t && t.id);
    terminal.targets = targets.length ? targets : [DEFAULT_TERMINAL_TARGET];
    terminal.loaded = true;
  } catch (err) {
    terminal.targets = terminal.targets.length ? terminal.targets : [DEFAULT_TERMINAL_TARGET];
  }
  renderTerminalTargets();
}

function ensureTerminal() {
  if (!terminal.loaded) loadTerminalTargets();
  syncTerminalTarget(false);
  const f = $("#termFrame");
  if (f && !f.getAttribute("src") && f.dataset.src) f.src = f.dataset.src;
}
const _termReload = $("#termReload");
if (_termReload) _termReload.addEventListener("click", () => {
  syncTerminalTarget(false);
  const f = $("#termFrame");
  if (f && f.dataset.src) f.src = f.dataset.src;  // reconnect = reload the frame
});

function setWikiStatus(text) {
  const el = $("#wikiStatus");
  if (el) el.textContent = text;
}

function ensureWikiSession() {
  if (!wiki.sessionPromise) {
    wiki.sessionPromise = fetch("/api/wiki/session", {
      method: "POST",
      headers: headers(),
      credentials: "same-origin",
    }).then(async (resp) => {
      let data = {};
      try { data = await resp.json(); } catch (e) { data = {}; }
      if (!resp.ok) throw new Error(data.error || data.detail || `HTTP ${resp.status}`);
      return data;
    }).catch((err) => {
      wiki.sessionPromise = null;
      throw err;
    });
  }
  return wiki.sessionPromise;
}

// Lazy-load the embedded LLM Wiki iframe only after MC mints the wiki session.
function ensureWiki() {
  const f = $("#wikiFrame");
  if (!f || f.getAttribute("src") || !f.dataset.src) return;
  setWikiStatus("Connecting the embedded wiki session...");
  ensureWikiSession().then(() => {
    if (!f.getAttribute("src")) f.src = f.dataset.src;
    setWikiStatus("Embedded LLM Wiki dashboard connected through Mission Control.");
  }).catch((err) => {
    if (!f.getAttribute("src")) f.src = f.dataset.src;
    setWikiStatus(`Wiki auto-connect failed: ${err.message}. Manual token entry is still available in the iframe.`);
  });
}
const _wikiReload = $("#wikiReload");
if (_wikiReload) _wikiReload.addEventListener("click", () => {
  const f = $("#wikiFrame");
  if (!f || !f.dataset.src) return;
  setWikiStatus("Refreshing the embedded wiki session...");
  ensureWikiSession().then(() => {
    f.src = f.dataset.src;  // reload the frame
    setWikiStatus("Embedded LLM Wiki dashboard connected through Mission Control.");
  }).catch((err) => {
    f.src = f.dataset.src;
    setWikiStatus(`Wiki auto-connect failed: ${err.message}. Manual token entry is still available in the iframe.`);
  });
});

$("#refreshBtn").addEventListener("click", () => { loadState(); loadKanban(); loadOperations(); });
$("#offlineRetryBtn").addEventListener("click", () => { loadState(); loadKanban(); loadOperations(); });
$("#addScheduleBtn").addEventListener("click", () => $("#scheduleDialog").showModal());
$("#cronCatchupBtn").addEventListener("click", catchUpMissedCron);

// Generic top-right ✕ for any dialog carrying a .dialog-close button — just
// closes its parent <dialog> without submitting the form.
document.querySelectorAll(".dialog-close").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest("dialog")?.close());
});

$("#requestApprovalBtn").addEventListener("click", () => {
  $("#operationTarget").innerHTML = operations.targets.map((target) =>
    `<option value="${escapeHtml(target)}">${escapeHtml(target)}</option>`).join("") || `<option value="">No eligible targets</option>`;
  $("#approvalRequestDialog").showModal();
});

$("#approvalRequestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#approvalRequestDialog").close(); return; }
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    body.requested_by = "operator";
    await api("/api/operations/requests", { method: "POST", headers: headers(), body: JSON.stringify(body) });
    $("#approvalRequestDialog").close(); event.currentTarget.reset();
    setSync("Docker action sent for review"); await loadOperations();
  } catch (err) { setSync("Request failed — check the admin token and runner"); }
});

$("#approvalExecuteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#approvalExecuteDialog").close(); return; }
  const form = event.currentTarget;
  if (form.dataset.submitting === "1") return;
  const operation = operations.selected;
  if (!operation) return;
  form.dataset.submitting = "1";
  const body = Object.fromEntries(new FormData(form).entries());
  // Approval has been explicitly submitted. Close promptly rather than making
  // the operator wait behind a potentially slow action runner.
  $("#approvalExecuteDialog").close();
  form.reset(); operations.selected = null;
  setSync("Approval submitted — executing action…");
  try {
    await api(`/api/operations/${encodeURIComponent(operation.id)}/approve`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    setSync("Approved Docker action executed"); await loadOperations();
  } catch (err) {
    setSync("Approval submitted, but execution failed — check Approvals for details");
    await loadOperations();
  } finally { form.dataset.submitting = "0"; }
});

// Kanban: create dialog + archived toggle wiring
$("#addTaskBtn").addEventListener("click", () => {
  $("#kanbanAssignee").innerHTML = state.profiles.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(displayName(p.name))}</option>`).join("");
  $("#kanbanDialog").showModal();
});
$("#kanbanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#kanbanDialog").close(); return; }
  const form = event.currentTarget;
  // Guard against an accidental double-click on Create firing two submits (and
  // minting two identical tasks). Ignore re-entrant submits and disable the
  // button while the create is in flight.
  if (form.dataset.submitting === "1") return;
  form.dataset.submitting = "1";
  const createBtn = form.querySelector('button[value="submit"]');
  if (createBtn) createBtn.disabled = true;
  try {
    await kanbanCreate(form);
    form.reset();
    $("#kanbanDialog").close();
  } finally {
    form.dataset.submitting = "0";
    if (createBtn) createBtn.disabled = false;
  }
});
const _kanArch = $("#kanbanArchivedToggle");
if (_kanArch) _kanArch.addEventListener("change", () => { kanban.showArchived = _kanArch.checked; loadKanban(); });
const _kanBulkClarify = $("#kanBulkClarify");
if (_kanBulkClarify) _kanBulkClarify.addEventListener("click", () => kanbanBulkAction("clarify"));
const _kanBulkDecompose = $("#kanBulkDecompose");
if (_kanBulkDecompose) _kanBulkDecompose.addEventListener("click", () => kanbanBulkAction("decompose"));
const _kanBulkClear = $("#kanBulkClear");
if (_kanBulkClear) _kanBulkClear.addEventListener("click", () => { kanban.selected.clear(); renderKanban(); });
const _kanClose = $("#kanbanDrawerClose");
if (_kanClose) _kanClose.addEventListener("click", () => { kanban.drawerId = null; clearTimeout(_drawerTimer); $("#kanbanDrawer").close(); });

// ── Automation (per-agent auto-dispatch) ────────────────────────────────────
async function openAutomation() {
  const statusEl = $("#automationStatus");
  if (statusEl) statusEl.textContent = "";
  $("#automationList").innerHTML = `<p class="empty">Loading…</p>`;
  $("#automationDialog").showModal();
  // Orchestrator selector (which agent runs decompose).
  let orch = "default";
  try { orch = (await api(`/api/orchestrator`)).orchestrator || "default"; } catch (e) { /* default */ }
  const osel = $("#orchestratorSelect");
  if (osel) {
    osel.innerHTML = state.profiles.map((p) => `<option value="${escapeHtml(p.name)}" ${p.name === orch ? "selected" : ""}>${escapeHtml(displayName(p.name))}</option>`).join("");
    osel.onchange = () => setOrchestrator(osel.value);
  }
  const rows = await Promise.all(state.profiles.map(async (p) => {
    let st = { enabled: false, max: 1 };
    try { st = await api(`/api/kanban/agent/${encodeURIComponent(p.name)}/autodispatch`); } catch (e) { /* offline */ }
    return { name: p.name, enabled: !!st.enabled, max: st.max || 1 };
  }));
  $("#automationList").innerHTML = rows.map((r) => `
    <div class="auto-row" data-agent="${escapeHtml(r.name)}">
      ${avatarHtml(r.name, 26)}
      <span class="auto-name">${escapeHtml(r.name)}</span>
      <label class="auto-max">max <input type="number" class="auto-max-in" min="1" max="4" value="${r.max}"></label>
      <label class="auto-switch"><input type="checkbox" class="auto-en" ${r.enabled ? "checked" : ""}> auto-run</label>
    </div>`).join("") || `<p class="empty">No agents.</p>`;
  $("#automationList").querySelectorAll(".auto-row").forEach((row) => {
    const name = row.dataset.agent;
    const en = row.querySelector(".auto-en");
    const mx = row.querySelector(".auto-max-in");
    const save = () => setAutodispatch(name, en.checked, Number(mx.value) || 1);
    en.addEventListener("change", save);
    mx.addEventListener("change", save);
  });
}

async function setAutodispatch(name, enabled, max) {
  const statusEl = $("#automationStatus");
  if (statusEl) statusEl.textContent = `Saving ${name}…`;
  try {
    const r = await fetch(`/api/kanban/agent/${encodeURIComponent(name)}/autodispatch`, {
      method: "POST", headers: headers(), body: JSON.stringify({ enabled, max }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { if (statusEl) statusEl.textContent = d.error || (r.status === 401 ? "Admin token required" : "Save failed"); return; }
    if (statusEl) statusEl.textContent = `${name}: auto-run ${d.enabled ? "ON" : "off"} · max ${d.max}`;
  } catch (e) { if (statusEl) statusEl.textContent = "Save failed"; }
}

async function setOrchestrator(profile) {
  const statusEl = $("#automationStatus");
  if (statusEl) statusEl.textContent = `Setting orchestrator…`;
  try {
    const r = await fetch(`/api/orchestrator`, { method: "POST", headers: headers(), body: JSON.stringify({ profile }) });
    const d = await r.json().catch(() => ({}));
    if (statusEl) statusEl.textContent = (!r.ok || !d.ok) ? (d.detail || d.error || (r.status === 401 ? "Admin token required" : "Failed")) : `Orchestrator = ${d.orchestrator}`;
  } catch (e) { if (statusEl) statusEl.textContent = "Failed"; }
}

$("#automationBtn").addEventListener("click", openAutomation);
$("#automationClose").addEventListener("click", () => $("#automationDialog").close());

$("#scheduleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    $("#scheduleDialog").close();
    return;
  }
  await createSchedule(event.currentTarget);
  event.currentTarget.reset();
  $("#scheduleDialog").close();
});

// ── Agent chat ───────────────────────────────────────────────────────────
const chat = {
  transcripts: {},   // convId -> [{role, text, attachments, streaming}]
  convs: {},         // profile -> [{id, title, updated_at}]
  activeConv: {},    // profile -> convId
  loadedList: {},    // profile -> true once conversation list fetched
  loadedHist: {},    // convId -> true once that thread's history fetched
  pending: [],       // staged attachments {name, mime, content_b64}
  busyProfiles: {},  // profile -> true while a turn is in flight for that agent
  search: "",        // active conversation-search query (current profile)
  searchResults: [], // [{id, title, snippet, matches}]
  profile: null,     // currently selected agent
  agentMeta: {},     // profile -> {emoji?|image?} custom avatar
  agentInfo: {},     // profile -> {model, soul_summary} from the bridge
  health: {},        // profile -> bool (bridge reachable); undefined = unknown
  mcpHealth: {},     // profile -> {summary, servers[]} from live MCP health polling
};

function agentColor(name) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 60% 62%)`;
}
function agentInitials(name) {
  const parts = (name || "?").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ");
  return ((parts[0] && parts[0][0]) || "?").toUpperCase() + ((parts[1] && parts[1][0]) || "").toUpperCase();
}
function resizeImageToAvatar(file, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const s = Math.min(img.naturalWidth, img.naturalHeight); // center-crop to square (cover)
      const sx = (img.naturalWidth - s) / 2;
      const sy = (img.naturalHeight - s) / 2;
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
      let out = canvas.toDataURL("image/png");
      if (out.length > 450 * 1024) out = canvas.toDataURL("image/jpeg", 0.9); // keep under the cap
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

// Operator-facing display name: the optional `label` from agent-meta, else the
// raw profile id. The id stays canonical everywhere data-side; this is cosmetic.
function displayName(profile) {
  return (chat.agentMeta[profile] || {}).label || profile;
}

function avatarHtml(profile, size) {
  const meta = chat.agentMeta[profile] || {};
  const box = `width:${size}px;height:${size}px`;
  if (meta.image) return `<span class="ava" style="${box}"><img src="${escapeHtml(meta.image)}" alt="" /></span>`;
  const isBrand = profile === "__brand";
  const isYou = profile === "__you";
  const bg = isBrand ? "#e8ecf2" : agentColor(profile);
  if (meta.emoji) return `<span class="ava" style="${box};background:${bg};font-size:${Math.round(size * 0.58)}px">${escapeHtml(meta.emoji)}</span>`;
  if (isYou) return `<span class="ava" style="${box};background:${bg};font-size:${Math.round(size * 0.6)}px">👤</span>`;
  const label = isBrand ? "IN" : agentInitials(profile);
  const color = isBrand ? "color:#15171b;" : "";
  return `<span class="ava" style="${box};background:${bg};${color}font-size:${Math.round(size * 0.42)}px">${escapeHtml(label)}</span>`;
}

function renderBrand() {
  const mark = document.querySelector(".brand .mark");
  if (!mark) return;
  const meta = chat.agentMeta["__brand"] || {};
  if (meta.image) {
    mark.classList.add("has-img");
    mark.innerHTML = `<img src="${escapeHtml(meta.image)}" alt="" />`;
  } else {
    mark.classList.remove("has-img");
    mark.textContent = meta.emoji || "IN";
  }
}

function highlight(text, q) {
  const esc = escapeHtml(text || "");
  const eq = escapeHtml(q || "");
  if (!eq) return esc;
  const low = esc.toLowerCase();
  const lq = eq.toLowerCase();
  let out = "", i = 0, idx;
  while ((idx = low.indexOf(lq, i)) >= 0) {
    out += esc.slice(i, idx) + "<mark>" + esc.slice(idx, idx + lq.length) + "</mark>";
    i = idx + lq.length;
  }
  return out + esc.slice(i);
}

const CHAT_HINT = `<p class="chat-hint">Pick an agent and start chatting. Turns run a real <code>hermes</code> session (tools + memory). Paste an image or drop files in. Use <strong>+ New</strong> for a separate thread with the same agent.</p>`;

function currentProfile() { return chat.profile || null; }
function currentConv() { return chat.activeConv[currentProfile()] || null; }
function convKey(profile, convId) { return `${profile || ""}::${convId || ""}`; }
function savedChatProfile() {
  try { return localStorage.getItem(CHAT_PROFILE_STORE_KEY) || ""; } catch (e) { return ""; }
}
function saveChatProfile(profile) {
  if (!profile) return;
  try { localStorage.setItem(CHAT_PROFILE_STORE_KEY, profile); } catch (e) { /* storage unavailable */ }
}
function savedChatConvs() {
  try { return JSON.parse(localStorage.getItem(CHAT_CONV_STORE_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function savedChatConv(profile) {
  return savedChatConvs()[profile] || "";
}
function saveChatConv(profile, convId) {
  if (!profile || !convId) return;
  try {
    const saved = savedChatConvs();
    saved[profile] = convId;
    localStorage.setItem(CHAT_CONV_STORE_KEY, JSON.stringify(saved));
  } catch (e) { /* storage unavailable */ }
}

async function loadAgentMeta() {
  try {
    const data = await api(`/api/agents/meta`);
    chat.agentMeta = (data && data.meta) || {};
    renderAgentPicker();
    renderAgentCard();
    renderChat();
    renderBrand();
    renderTerminalTargets();
  } catch (err) { /* ignore — generated defaults still render */ }
}

async function loadAgentsHealth() {
  const [agentResult, mcpResult] = await Promise.allSettled([
    api(`/api/agents/health`),
    api(`/api/agents/mcp-health`),
  ]);
  if (agentResult.status === "fulfilled") {
    const data = agentResult.value;
    chat.health = (data && data.health) || {};
  }
  if (mcpResult.status === "fulfilled") {
    const data = mcpResult.value;
    chat.mcpHealth = (data && data.health) || {};
  }
  renderAgentPicker();
  renderTerminalTargets();
  renderKpis();
  if ($("#view-team")?.classList.contains("active")) renderTeam();
}

// ── Token-usage card (Card 1) ───────────────────────────────────────────────
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

// Token-usage tiles — one metric per tile, joining the shared metrics grid.
function renderUsage(u) {
  const box = $("#usageCard");
  if (!box) return;
  if (!u || !u.ok) { box.innerHTML = `<div class="stat-empty">Token usage unavailable</div>`; return; }
  const avg = u.period_days ? (u.total_sessions / u.period_days) : 0;
  const tiles = [
    [fmtNum(u.total_tokens), "Total Tokens", ""],
    [fmtNum(u.input_tokens), "Input", ""],
    [fmtNum(u.output_tokens), "Output", ""],
    [String(u.total_sessions), "Sessions", `${avg.toFixed(1)}/day`],
    [fmtNum(u.api_calls), "API Calls", ""],
  ];
  box.innerHTML = tiles.map(([v, l, sub]) =>
    `<article class="metric-tile"><span class="tile-label">${escapeHtml(l)}</span>` +
    `<strong class="tile-num">${escapeHtml(v)}` +
    (sub ? `<span class="tile-sub">${escapeHtml(sub)}</span>` : ``) +
    `</strong></article>`
  ).join("");
}

function fmtDay(iso) {
  const d = new Date((iso || "") + "T00:00:00");
  return isNaN(d.getTime()) ? (iso || "") : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Daily Token Usage panel — stacked bars (Output at base, Input above), native
// hover tooltip per day. SVG stretches to fill (preserveAspectRatio none).
function renderUsageChart(daily) {
  const box = $("#usageChart");
  if (!box) return;
  const days = (daily || []).filter((d) => d.day);
  if (!days.length) { box.innerHTML = `<div class="stat-empty">No usage history</div>`; return; }
  const max = Math.max(1, ...days.map((d) => (d.input || 0) + (d.output || 0)));
  const H = 100, bw = 6, slot = 10;
  const W = days.length * slot;
  const bars = days.map((d, i) => {
    const inp = d.input || 0, out = d.output || 0, tot = inp + out;
    const inH = (inp / max) * (H - 4), outH = (out / max) * (H - 4);
    const x = i * slot + (slot - bw) / 2;
    const tip = `${d.day}\nInput: ${inp.toLocaleString()}\nOutput: ${out.toLocaleString()}\nTotal: ${tot.toLocaleString()}`;
    return `<g><title>${escapeHtml(tip)}</title>` +
      `<rect x="${x}" y="${H - outH}" width="${bw}" height="${outH}" fill="var(--green)"/>` +
      `<rect x="${x}" y="${H - outH - inH}" width="${bw}" height="${inH}" fill="#c2b280"/></g>`;
  }).join("");
  box.innerHTML =
    `<svg class="usage-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily token usage">${bars}</svg>` +
    `<div class="chart-axis"><span>${escapeHtml(fmtDay(days[0].day))}</span><span>${escapeHtml(fmtDay(days[days.length - 1].day))}</span></div>`;
}

function setTileStatus(tileId, cls) {
  const el = document.getElementById(tileId);
  if (!el) return;
  el.classList.remove("is-ok", "is-warn", "is-bad", "is-info");
  if (cls) el.classList.add(cls);
}

// Operational KPI tiles — from data we already have (no extra fetch).
// These carry a semantic status accent (proposal 2); usage tiles stay neutral.
function renderKpis() {
  const online = Object.values(chat.health || {}).filter(Boolean).length;
  const total = (state.profiles || []).length;
  const o = $("#kpiOnline");
  if (o) o.textContent = total ? `${online}/${total}` : "—";
  setTileStatus("tileOnline", !total ? null : (online === total ? "is-ok" : (online === 0 ? "is-bad" : "is-warn")));

  const open = (state.tasks || []).filter((t) => t.status !== "done").length;
  const t = $("#kpiTasks");
  if (t) t.textContent = String(open);
  setTileStatus("tileTasks", open > 0 ? "is-info" : null);

  const denies = (state.metrics && state.metrics.recent_denies) || 0;
  const d = $("#kpiDenies");
  if (d) d.textContent = String(denies);
  setTileStatus("tileDenies", denies > 0 ? "is-bad" : "is-ok");
}

async function loadUsage() {
  try {
    const u = await api(`/api/usage`);
    renderUsage(u);
    renderUsageChart(u && u.daily);
  } catch (err) { renderUsage(null); renderUsageChart(null); }
}

// Real scheduled scripts: every agent's Hermes cron jobs, aggregated server-side.
async function loadCron() {
  try {
    const d = await api(`/api/schedules/cron`);
    state.cronJobs = (d && d.jobs) || [];
  } catch (err) {
    state.cronJobs = [];
  }
  renderCronCatchup();
  renderCalendar();
}

async function api(path, opts) {
  const resp = await fetch(path, opts);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function populateAgentProfiles() {
  const names = state.profiles.map((p) => p.name);
  if (!chat.profile || !names.includes(chat.profile)) {
    const saved = savedChatProfile();
    chat.profile = saved && names.includes(saved) ? saved : names[0] || null;
  }
  if (chat.profile) saveChatProfile(chat.profile);
  renderAgentPicker();
  renderAgentCard();
  loadAgentInfo(currentProfile());
  loadConversations(currentProfile());
}

function renderAgentPicker() {
  const box = $("#agentPicker");
  if (!box) return;
  box.innerHTML = state.profiles.map((p) => {
    const n = p.name;
    const offline = p.status !== "enabled" || chat.health[n] === false;
    const cls = ["agent-ava",
      n === chat.profile ? "active" : "",
      chat.busyProfiles[n] ? "busy" : "",
      offline ? "offline" : ""].filter(Boolean).join(" ");
    const status = offline ? "offline" : (chat.busyProfiles[n] ? "working…" : "online");
    return `<button class="${cls}" data-profile="${escapeHtml(n)}" title="${escapeHtml(displayName(n))} · ${status} — Shift+click to edit">${avatarHtml(n, 42)}<span class="status-dot"></span></button>`;
  }).join("");
  box.querySelectorAll("[data-profile]").forEach((el) =>
    el.addEventListener("click", (e) => {
      const p = el.dataset.profile;
      if (e.shiftKey) {
        e.preventDefault();
        openAgentSettings(p);   // Shift+click an agent → settings (SOUL.md, model, icon)
      } else {
        selectProfile(p);
      }
    }));
  updateActiveAgentAva();
}

function updateBusyIndicators() {
  document.querySelectorAll("#agentPicker .agent-ava").forEach((el) => {
    el.classList.toggle("busy", !!chat.busyProfiles[el.dataset.profile]);
  });
}

function updateActiveAgentAva() {
  const el = $("#activeAgentAva");
  if (el) el.innerHTML = currentProfile() ? avatarHtml(currentProfile(), 32) : "";
}

// ── Selected-agent profile card (model + SOUL.md summary from the bridge) ────
function profileByName(name) { return state.profiles.find((p) => p.name === name) || null; }

function renderAgentCard() {
  const box = $("#agentCard");
  if (!box) return;
  const name = currentProfile();
  const p = profileByName(name);
  if (!p) { box.innerHTML = ""; box.style.display = "none"; return; }
  box.style.display = "";
  const info = chat.agentInfo[name] || {};
  const prov = info.provider ? `<span class="ac-model-prov">${escapeHtml(info.provider)}</span>` : "";
  const model = info.model
    ? `<span class="ac-model-ic" aria-hidden="true">⚙</span>${escapeHtml(info.model)}${prov}`
    : `<span class="ac-model-ic" aria-hidden="true">⚙</span><span class="muted">model unknown</span>`;
  const text = info.description || info.soul_summary || p.description || "";
  const refining = info.description_kind && info.description_kind !== "role"
    ? `<span class="ac-desc-tag" title="The agent is summarising its role from SOUL.md">refining…</span>` : "";
  const desc = text && text.trim()
    ? `<div class="ac-desc">${escapeHtml(text)}${refining}</div>`
    : `<div class="ac-desc empty">${info.loaded ? "No SOUL.md summary." : "Loading…"}</div>`;
  box.innerHTML = `
    <div class="ac-head">
      <button type="button" class="ac-ava" data-settings="${escapeHtml(name)}"
              title="Shift+click to edit ${escapeHtml(name)}">${avatarHtml(name, 44)}</button>
      <div class="ac-id">
        <div class="ac-name">${escapeHtml(displayName(name))}</div>
        <div class="ac-model" title="AI model">${model}</div>
      </div>
    </div>
    ${desc}`;
  const ava = box.querySelector("[data-settings]");
  if (ava) ava.addEventListener("click", (e) => {
    if (!e.shiftKey) return;        // shift+click only — matches the picker
    e.preventDefault();
    openAgentSettings(name);
  });
}

// Fetch a profile's model + role description from the bridge (via MC proxy) and
// re-render the card. The role description is an LLM summary generated lazily on
// the agent side, so while description_kind != "role" we poll a few times to
// pick it up (the agent turn that generates it can take ~5-30s).
const _roleTimers = {};   // profile -> timeout id (one pending re-poll per profile)
async function loadAgentInfo(profile, attempt = 0) {
  if (!profile) return;
  try {
    const data = await api(`/api/agent/${encodeURIComponent(profile)}/meta`);
    chat.agentInfo[profile] = {
      model: data.model || "", provider: data.provider || "",
      description: data.description || "", description_kind: data.description_kind || "",
      soul_summary: data.soul_summary || "", loaded: true, online: true,
      bio: data.bio || "", role_title: data.role_title || "",
      tools: data.tools || { toolsets: [], mcp: [] },
      skills: data.skills || { count: 0, by_category: {} },
    };
  } catch (err) {
    chat.agentInfo[profile] = { ...(chat.agentInfo[profile] || {}), loaded: true, online: false };
  }
  if (profile === currentProfile()) renderAgentCard();
  if ($("#view-team")?.classList.contains("active")) renderTeam();
  // Re-poll until the role summary lands (or we give up after ~5 tries).
  const kind = (chat.agentInfo[profile] || {}).description_kind;
  clearTimeout(_roleTimers[profile]);
  if (kind && kind !== "role" && attempt < 5) {
    _roleTimers[profile] = setTimeout(() => loadAgentInfo(profile, attempt + 1), 7000);
  }
}

function updateSendButton() {
  const btn = $("#sendBtn");
  if (btn) btn.disabled = !!chat.busyProfiles[currentProfile()];
}

function selectProfile(name) {
  if (!name) return;
  chat.profile = name;
  saveChatProfile(name);
  clearSearch();
  renderAgentPicker();
  renderAgentCard();
  loadAgentInfo(name);
  loadConversations(name);
  renderConvList();
  updateConvTitle();
  renderChat();
  updateSendButton();
}

async function loadConversations(profile, force) {
  if (!profile || (chat.loadedList[profile] && !force)) return;
  chat.loadedList[profile] = true;
  try {
    const data = await api(`/api/agent/${encodeURIComponent(profile)}/conversations`);
    let convs = (data && data.conversations) || [];
    if (!convs.length) {
      const created = await api(`/api/agent/${encodeURIComponent(profile)}/conversations`, { method: "POST" });
      convs = [created.conversation];
      const key = convKey(profile, created.conversation.id);
      chat.loadedHist[key] = true;
      chat.transcripts[key] = [];
    }
    chat.convs[profile] = convs;
    if (!chat.activeConv[profile] || !convs.some((c) => c.id === chat.activeConv[profile])) {
      const savedConv = savedChatConv(profile);
      const firstActive = (savedConv && convs.find((c) => c.id === savedConv)) || convs.find((c) => !c.archived) || convs[0];
      chat.activeConv[profile] = firstActive.id;
    }
    if (chat.activeConv[profile]) saveChatConv(profile, chat.activeConv[profile]);
    if (profile === currentProfile()) {
      renderConvList();
      updateConvTitle();
      loadConvHistory(chat.activeConv[profile]);
    }
  } catch (err) { /* ignore — chat still usable */ }
}

async function loadConvHistory(convId) {
  if (!convId) { renderChat(); return; }
  const profile = currentProfile();
  const key = convKey(profile, convId);
  if (chat.loadedHist[key]) { renderChat(); return; }
  chat.loadedHist[key] = true;
  try {
    const data = await api(`/api/agent/${encodeURIComponent(profile)}/conversations/${encodeURIComponent(convId)}/history`);
    chat.transcripts[key] = ((data && data.messages) || []).map((m) => ({
      role: m.role === "user" ? "user" : m.role === "error" ? "error" : m.role === "system" ? "system" : "agent",
      text: m.text || "",
      attachments: m.attachments || [],
      ts: m.ts || "",
      approval_id: m.approval_id || "",
      approval_status: m.approval_status || "",
      approval_action: m.approval_action || "",
      approval_target: m.approval_target || "",
    }));
  } catch (err) {
    chat.transcripts[key] = chat.transcripts[key] || [];
  }
  if (convId === currentConv()) renderChat();
}

function convTitleOf(profile, convId) {
  const c = (chat.convs[profile] || []).find((x) => x.id === convId);
  return c ? (c.title || "New chat") : "Agent Chat";
}

function updateConvTitle() {
  const el = $("#convTitle");
  if (el) el.textContent = currentConv() ? convTitleOf(currentProfile(), currentConv()) : "Agent Chat";
}

// One conversation row: name + a ⋯ kebab that opens the shared actions menu.
function convItemHtml(c, profile, archived) {
  const active = c.id === chat.activeConv[profile] ? "active" : "";
  const pinned = !!c.pinned && !archived;
  return `<div class="conv-item ${active} ${archived ? "archived" : ""} ${pinned ? "pinned" : ""}" data-conv="${escapeHtml(c.id)}">
            ${pinned ? `<span class="conv-pin" title="Pinned" aria-label="Pinned">📌</span>` : ""}
            <span class="conv-name">${escapeHtml(c.title || "New chat")}</span>
            <button class="conv-kebab" type="button" data-kebab="${escapeHtml(c.id)}"
                    data-archived="${archived ? "1" : "0"}"
                    data-pinned="${pinned ? "1" : "0"}" aria-label="Conversation actions">⋯</button>
          </div>`;
}

function renderConvList() {
  const box = $("#convList");
  if (!box) return;
  closeConvMenu();
  const profile = currentProfile();
  if (chat.search) {
    const rs = chat.searchResults;
    const pinnedResults = rs.filter((r) => r.pinned && !r.archived);
    const regularResults = rs.filter((r) => !(r.pinned && !r.archived));
    const resultHtml = (r) =>
      `<div class="conv-item result ${r.id === chat.activeConv[profile] ? "active" : ""} ${r.pinned && !r.archived ? "pinned" : ""}" data-conv="${escapeHtml(r.id)}">
         <span class="conv-result-title">${r.pinned && !r.archived ? `<span class="conv-pin" title="Pinned" aria-label="Pinned">📌</span>` : ""}<span class="conv-name">${highlight(r.title || "New chat", chat.search)}</span></span>
         <span class="conv-snippet">${highlight(r.snippet || "", chat.search)}</span>
       </div>`;
    box.innerHTML = rs.length
      ? `${pinnedResults.length ? `<div class="conv-section-label">Pinned</div>${pinnedResults.map(resultHtml).join("")}` : ""}`
        + `${pinnedResults.length && regularResults.length ? `<div class="conv-section-label">Recent</div>` : ""}`
        + regularResults.map(resultHtml).join("")
      : `<p class="conv-empty">No matches</p>`;
  } else {
    const all = chat.convs[profile] || [];
    const active = all.filter((c) => !c.archived);
    const pinned = active.filter((c) => c.pinned);
    const recent = active.filter((c) => !c.pinned);
    const archived = all.filter((c) => c.archived);
    let html = active.length
      ? `${pinned.length ? `<div class="conv-section-label">Pinned</div>${pinned.map((c) => convItemHtml(c, profile, false)).join("")}` : ""}`
        + `${pinned.length && recent.length ? `<div class="conv-section-label">Recent</div>` : ""}`
        + recent.map((c) => convItemHtml(c, profile, false)).join("")
      : `<p class="conv-empty">No conversations</p>`;
    if (archived.length) {
      const open = !!chat.showArchived;
      html += `<button class="conv-archived-toggle" type="button" id="convArchivedToggle" aria-expanded="${open}">
                 <span class="caret">${open ? "▾" : "▸"}</span> Archived (${archived.length})
               </button>`;
      if (open) {
        html += `<div class="conv-archived-group">` +
                archived.map((c) => convItemHtml(c, profile, true)).join("") + `</div>`;
      }
    }
    box.innerHTML = html;
  }
  box.querySelectorAll("[data-conv]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-kebab]")) return;   // kebab handled separately
      selectConv(el.dataset.conv);
    }));
  box.querySelectorAll("[data-kebab]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openConvMenu(el);
    }));
  const toggle = $("#convArchivedToggle");
  if (toggle) toggle.addEventListener("click", () => {
    chat.showArchived = !chat.showArchived;
    renderConvList();
  });
}

// ── Shared per-conversation actions menu (rename / archive / delete) ─────────
function closeConvMenu() {
  const m = $("#convMenu");
  if (m) m.hidden = true;
}

function openConvMenu(kebabEl) {
  const m = $("#convMenu");
  if (!m) return;
  const convId = kebabEl.dataset.kebab;
  const isArchived = kebabEl.dataset.archived === "1";
  const isPinned = kebabEl.dataset.pinned === "1";
  if (!m.hidden && m.dataset.conv === convId) { closeConvMenu(); return; }  // toggle off
  m.dataset.conv = convId;
  m.querySelector('[data-act="pin"]').textContent = isPinned ? "Unpin" : "Pin to top";
  m.querySelector('[data-act="archive"]').textContent = isArchived ? "Unarchive" : "Archive";
  m.hidden = false;
  // Position under the kebab, kept within the viewport.
  const r = kebabEl.getBoundingClientRect();
  const mw = m.offsetWidth || 160;
  let left = r.right - mw;
  if (left < 8) left = 8;
  m.style.top = `${Math.round(r.bottom + 4)}px`;
  m.style.left = `${Math.round(left)}px`;
}

let _searchTimer = null;
function onSearchInput() {
  const q = $("#convSearch").value.trim();
  chat.search = q;
  if (_searchTimer) clearTimeout(_searchTimer);
  if (!q) { chat.searchResults = []; renderConvList(); return; }
  _searchTimer = setTimeout(() => runSearch(currentProfile(), q), 250);
}

async function runSearch(profile, q) {
  try {
    const data = await api(`/api/agent/${encodeURIComponent(profile)}/search?q=${encodeURIComponent(q)}`);
    if (chat.search !== q || currentProfile() !== profile) return; // stale
    chat.searchResults = (data && data.results) || [];
    renderConvList();
  } catch (err) { /* ignore */ }
}

function clearSearch() {
  const inp = $("#convSearch");
  if (inp) inp.value = "";
  chat.search = "";
  chat.searchResults = [];
}

function selectConv(convId) {
  const profile = currentProfile();
  chat.activeConv[profile] = convId;
  saveChatConv(profile, convId);
  renderConvList();
  updateConvTitle();
  loadConvHistory(convId);
}

async function newConv() {
  const profile = currentProfile();
  clearSearch();
  try {
    const data = await api(`/api/agent/${encodeURIComponent(profile)}/conversations`, { method: "POST" });
    const c = data.conversation;
    chat.convs[profile] = [c, ...(chat.convs[profile] || [])];
    const key = convKey(profile, c.id);
    chat.transcripts[key] = [];
    chat.loadedHist[key] = true;
    selectConv(c.id);
  } catch (err) { /* ignore */ }
}

async function renameConv(convId) {
  const profile = currentProfile();
  convId = convId || currentConv();
  if (!convId) return;
  const title = window.prompt("Conversation name:", convTitleOf(profile, convId));
  if (!title) return;
  try {
    await fetch(`/api/agent/${encodeURIComponent(profile)}/conversations/${encodeURIComponent(convId)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
    });
    const c = (chat.convs[profile] || []).find((x) => x.id === convId);
    if (c) c.title = title.slice(0, 80);
    renderConvList();
    updateConvTitle();
  } catch (err) { /* ignore */ }
}

async function archiveConv(convId, archived) {
  const profile = currentProfile();
  convId = convId || currentConv();
  if (!convId) return;
  try {
    await fetch(`/api/agent/${encodeURIComponent(profile)}/conversations/${encodeURIComponent(convId)}/archive`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }),
    });
  } catch (err) { /* ignore — UI still updates optimistically */ }
  const c = (chat.convs[profile] || []).find((x) => x.id === convId);
  if (c) c.archived = archived;
  // If we just archived the open conversation, move focus to the newest active one.
  if (archived && convId === chat.activeConv[profile]) {
    const nextActive = (chat.convs[profile] || []).find((x) => !x.archived);
    if (nextActive) selectConv(nextActive.id);
    else { chat.activeConv[profile] = null; updateConvTitle(); renderChat(); }
  }
  renderConvList();
}

async function pinConv(convId, pinned) {
  const profile = currentProfile();
  convId = convId || currentConv();
  if (!convId) return;
  try {
    await fetch(`/api/agent/${encodeURIComponent(profile)}/conversations/${encodeURIComponent(convId)}/pin`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned }),
    });
  } catch (err) { /* ignore — UI still updates optimistically */ }
  const c = (chat.convs[profile] || []).find((x) => x.id === convId);
  if (c) {
    c.pinned = pinned;
    c.pinned_at = pinned ? new Date().toISOString() : null;
  }
  chat.searchResults = (chat.searchResults || []).map((r) =>
    r.id === convId ? { ...r, pinned, pinned_at: pinned ? new Date().toISOString() : null } : r);
  renderConvList();
}

async function deleteConv(convId) {
  const profile = currentProfile();
  convId = convId || currentConv();
  if (!convId) return;
  if (!window.confirm("Delete this conversation? Clears its history and resets the agent's session for it.")) return;
  try {
    await fetch(`/api/agent/${encodeURIComponent(profile)}/conversations/${encodeURIComponent(convId)}`, { method: "DELETE" });
  } catch (err) { /* ignore */ }
  chat.convs[profile] = (chat.convs[profile] || []).filter((x) => x.id !== convId);
  delete chat.transcripts[convKey(profile, convId)];
  delete chat.loadedHist[convKey(profile, convId)];
  chat.activeConv[profile] = null;
  const next = (chat.convs[profile] || []).find((x) => !x.archived) || chat.convs[profile][0];
  if (next) {
    selectConv(next.id);
  } else {
    await loadConversations(profile, true); // creates a fresh empty thread
  }
}

// Recognised file references that mdInline() turns into real download links to
// our proxy (when given a profile). Handles all the shapes the agent uses:
// markdown [label](sandbox:…), backtick `…`, MEDIA:/sandbox: prefix, or a bare
// /opt/data/.mission-control-uploads/<name> path. http(s) links open in a new
// tab. Everything is escaped before markup is added, so there is no injection
// surface.
const UPLOAD_RE = /\.mission-control-uploads\/([A-Za-z0-9._-]+)/;
// bare upload path, optionally prefixed with sandbox:/media:/file: and absolute
const UPLOAD_PATH_RE = /(?:sandbox:|media:|file:)?\/?opt\/data\/\.mission-control-uploads\/([A-Za-z0-9._-]+)/gi;

function dlLink(profile, name, label) {
  const href = `/api/agent/${encodeURIComponent(profile)}/file/${encodeURIComponent(name)}`;
  return `<a class="dl-link" href="${href}" download="${escapeHtml(name)}">${escapeHtml(label || name)} ↓</a>`;
}

function renderChat(options = {}) {
  const log = $("#chatLog");
  const oldScrollTop = log ? log.scrollTop : 0;
  const distanceFromBottom = log ? (log.scrollHeight - log.clientHeight - log.scrollTop) : 0;
  const wasNearBottom = distanceFromBottom < 48;
  const preserveScroll = !!options.preserveScroll && !wasNearBottom;
  const convId = currentConv();
  const profile = currentProfile();
  const msgs = (convId && chat.transcripts[convKey(profile, convId)]) || [];
  if (!msgs.length) {
    log.innerHTML = CHAT_HINT;
    return;
  }
  const agentMeta = `${avatarHtml(profile, 22)}<span>${escapeHtml(displayName(profile))}</span>`;
  const messagesHtml = msgs.map((m) => {
    if (m.role === "thinking" || (m.role === "agent" && m.streaming && !m.text)) {
      return `<div class="msg agent"><span class="meta">${agentMeta}</span><span class="thinking-dots"><span></span><span></span><span></span></span></div>`;
    }
    const cls = m.role === "user" ? "user" : m.role === "error" ? "error" : m.role === "system" ? "system" : "agent";
    const youName = (chat.agentMeta["__you"] || {}).label || "you";
    const youMeta = `<button type="button" class="you-ava-btn" title="Click to change your icon">${avatarHtml("__you", 22)}</button><button type="button" class="you-name-btn" title="Click to rename">${escapeHtml(youName)}</button>`;
    const metaInner = m.role === "agent" ? agentMeta
      : m.role === "user" ? youMeta
      : `<span>${escapeHtml(m.role === "system" ? "command" : "error")}</span>`;
    const atts = (m.attachments || []).map((a) =>
      (a.mime || "").startsWith("image/") && a.content_b64
        ? `<img class="att-img" src="data:${a.mime};base64,${a.content_b64}" alt="${escapeHtml(a.name)}" />`
        : `<span class="att">[file] ${escapeHtml(a.name)}</span>`
    ).join("");
    const cursor = m.role === "agent" && m.streaming ? `<span class="cursor"></span>` : "";
    const timeHtml = m.ts ? `<time class="msg-time" datetime="${escapeHtml(m.ts)}">${escapeHtml(formatTime(m.ts))}</time>` : "";
    const approvalAction = m.approval_id && m.approval_status === "requested"
      ? `<button type="button" class="chat-approval-btn" data-chat-approval="${escapeHtml(m.approval_id)}">Approve &amp; execute</button>` : "";
    // Agents commonly cite proposal IDs in their own response. Make those
    // references actionable in-place, rather than making the operator hunt for
    // a separate system notification below the reply.
    const referenced = m.role === "agent"
      ? [...new Set((m.text.match(/op-[a-f0-9]{32}/gi) || []))]
          .map((id) => operations.requests.find((item) => item.id === id && item.status === "pending_approval"))
          .filter(Boolean) : [];
    const referencedActions = referenced.length ? `<div class="chat-inline-approvals">${referenced.map((item) =>
      `<button type="button" class="chat-approval-btn" data-chat-approval="${escapeHtml(item.id)}">Approve ${escapeHtml(operationLabel(item.action))}</button>`).join("")}</div>` : "";
    return `<div class="msg ${cls}"><span class="meta">${metaInner}${timeHtml}</span><div class="md-body msg-md">${renderMarkdown(m.text, profile)}</div>${approvalAction}${referencedActions}${cursor}${atts}</div>`;
  }).join("");
  const pendingApprovals = operations.requests.filter((item) =>
    item.status === "pending_approval" && item.requested_by === profile);
  const approvalPanel = pendingApprovals.length ? `<section class="chat-approval-panel">
    <div class="chat-approval-panel-title">🛡️ Pending approvals <span>${pendingApprovals.length}</span></div>
    ${pendingApprovals.map((item) => `<div class="chat-approval-row"><div><strong>${escapeHtml(operationLabel(item.action))}</strong><p>${escapeHtml(item.target)} · ${escapeHtml(item.reason)}</p></div><button type="button" class="chat-approval-btn" data-chat-approval="${escapeHtml(item.id)}">Approve &amp; execute</button></div>`).join("")}
  </section>` : "";
  log.innerHTML = messagesHtml + approvalPanel;
  if (preserveScroll) log.scrollTop = oldScrollTop;
  else log.scrollTop = log.scrollHeight;
}

function pushMsg(convId, msg) {
  const key = convKey(currentProfile(), convId);
  (chat.transcripts[key] = chat.transcripts[key] || []).push(msg);
  if (convId === currentConv()) renderChat();
}

function renderPending() {
  const box = $("#chatAttachments");
  box.innerHTML = chat.pending.map((a, i) =>
    `<span class="att-chip">${(a.mime || "").startsWith("image/") ? "[img]" : "[file]"} ${escapeHtml(a.name)} <button data-rm="${i}" title="Remove">x</button></span>`
  ).join("");
  box.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => { chat.pending.splice(Number(b.dataset.rm), 1); renderPending(); }));
}

function fileToAttachment(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name || "pasted",
      mime: file.type || "application/octet-stream",
      content_b64: String(reader.result).split(",")[1] || "",
    });
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  for (const f of fileList) {
    if (f.size > 25 * 1024 * 1024) continue; // 25MB cap
    chat.pending.push(await fileToAttachment(f));
  }
  renderPending();
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

// Non-streaming fallback. Returns "busy" | "done".
async function fallbackChat(profile, convId, text, attachments, agentMsg) {
  try {
    const resp = await fetch(`/api/agent/${encodeURIComponent(profile)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, session: convId, attachments }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 429 || /busy/i.test(data.error || "")) return "busy";
    agentMsg.streaming = false;
    if (resp.ok && data.ok) {
      agentMsg.text = data.reply || "(empty reply)";
    } else {
      agentMsg.role = "error";
      agentMsg.text = data.error || `request failed (HTTP ${resp.status})`;
    }
  } catch (err) {
    agentMsg.streaming = false;
    agentMsg.role = "error";
    agentMsg.text = String(err);
  }
  if (convId === currentConv()) renderChat();
  return "done";
}

// One streamed turn. Returns "busy" (agent occupied, safe to retry) | "done".
async function streamTurn(profile, convId, text, attachments, agentMsg, scheduleRender) {
  let resp;
  try {
    resp = await fetch(`/api/agent/${encodeURIComponent(profile)}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, session: convId, attachments }),
    });
    if (!resp.ok || !resp.body) throw new Error(`stream HTTP ${resp.status}`);
  } catch (err) {
    return await fallbackChat(profile, convId, text, attachments, agentMsg);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let streamError = null;
  let sawData = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of rawEvent.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        let evt;
        try { evt = JSON.parse(t.slice(5).trim()); } catch { continue; }
        sawData = true;
        if (evt.type === "chunk") { agentMsg.text += evt.text; scheduleRender(); }
        else if (evt.type === "done") {
          agentMsg.streaming = false;
          // Bridge sends a rewritten reply when it turned a MEDIA: directive into
          // a download link — swap it in so the message renders the real link.
          if (evt.reply) agentMsg.text = evt.reply;
        }
        else if (evt.type === "error") { streamError = evt.error; }
      }
    }
  }
  agentMsg.streaming = false;
  if (!sawData) return await fallbackChat(profile, convId, text, attachments, agentMsg);
  if (streamError) {
    if (/busy/i.test(streamError) && !agentMsg.text) return "busy";
    if (!agentMsg.text) { agentMsg.role = "error"; agentMsg.text = streamError; }
    else agentMsg.text += `\n\n[stream error: ${streamError}]`;
    if (convId === currentConv()) renderChat();
    return "done";
  }
  if (!agentMsg.text) agentMsg.text = "(empty reply)";
  if (convId === currentConv()) renderChat();
  return "done";
}

async function sendChat() {
  const profile = currentProfile();
  if (!profile || chat.busyProfiles[profile]) return;
  const raw = $("#chatText").value.trim();

  // Slash commands: intercept only KNOWN commands so a legitimate message that
  // happens to start with "/" still goes to the agent.
  if (raw.startsWith("/")) {
    const cmd = raw.slice(1).split(/\s/)[0].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SLASH_COMMANDS, cmd)) {
      $("#chatText").value = "";
      autoGrow($("#chatText"));
      await handleSlash(profile, cmd, raw.slice(1).slice(cmd.length).trim());
      return;
    }
  }

  let convId = currentConv();
  if (!convId) { await newConv(); convId = currentConv(); if (!convId) return; }
  const text = raw;
  if (!text && !chat.pending.length) return;
  const attachments = chat.pending.slice();
  pushMsg(convId, { role: "user", text, attachments, ts: new Date().toISOString() });
  chat.pending = [];
  renderPending();
  $("#chatText").value = "";
  autoGrow($("#chatText"));

  // optimistic auto-title to match the server's first-message titling
  const cObj = (chat.convs[profile] || []).find((x) => x.id === convId);
  if (cObj && (!cObj.title || cObj.title === "New chat") && text) {
    cObj.title = text.split(/\s+/).join(" ").slice(0, 48);
    renderConvList();
    updateConvTitle();
  }

  await executeTurn(profile, convId, text, attachments);
}

// Runs one agent turn (streaming + busy-retry) and fires first-turn titling.
// The user message (if any) must already be in the transcript.
async function executeTurn(profile, convId, text, attachments) {
  chat.busyProfiles[profile] = true;
  updateSendButton();
  updateBusyIndicators();
  const agentMsg = { role: "agent", text: "", streaming: true, ts: new Date().toISOString() };
  pushMsg(convId, agentMsg);

  let renderScheduled = false;
  const scheduleRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => { renderScheduled = false; if (convId === currentConv()) renderChat(); }, 60);
  };

  try {
    for (let attempt = 0; ; attempt++) {
      const status = await streamTurn(profile, convId, text, attachments, agentMsg, scheduleRender);
      if (status !== "busy") break;
      if (attempt >= 25) { // ~75s of waiting out an earlier turn before giving up
        agentMsg.role = "error";
        agentMsg.streaming = false;
        agentMsg.text = "The agent is still finishing a previous reply. Please try again in a moment.";
        if (convId === currentConv()) renderChat();
        break;
      }
      // agent is occupied by an earlier turn — keep the thinking state and retry
      agentMsg.streaming = true;
      agentMsg.text = "";
      if (convId === currentConv()) renderChat();
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (agentMsg.role === "agent" && agentMsg.text) maybeAutoTitle(profile, convId);
  } finally {
    chat.busyProfiles[profile] = false;
    updateSendButton();
    updateBusyIndicators();
    if (profile === currentProfile()) $("#chatText").focus();
  }
}

// ── Slash commands ──────────────────────────────────────────────────────────
const SLASH_COMMANDS = {
  help:   "show this list",
  clear:  "clear the agent's context for this thread (keeps the transcript)",
  new:    "start a new conversation — /new [title]",
  retry:  "re-ask your last message (the agent answers again)",
  rename: "rename this thread — /rename <title>",
  model:  "show or switch the model — /model [name]",
};

function pushSystem(convId, text) {
  if (convId) pushMsg(convId, { role: "system", text });
}

async function doRename(profile, convId, title) {
  await api(`/api/agent/${encodeURIComponent(profile)}/conversations/${encodeURIComponent(convId)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
  });
  const c = (chat.convs[profile] || []).find((x) => x.id === convId);
  if (c) c.title = title;
  if (convId === currentConv()) updateConvTitle();
  if (profile === currentProfile()) renderConvList();
}

async function handleSlash(profile, cmd, arg) {
  let convId = currentConv();

  if (cmd === "help") {
    if (!convId) { await newConv(); convId = currentConv(); }
    const lines = Object.entries(SLASH_COMMANDS).map(([k, v]) => `/${k} — ${v}`).join("\n");
    pushSystem(convId, "Available commands:\n" + lines);
    return;
  }

  if (cmd === "new") {
    await newConv();
    convId = currentConv();
    if (arg && convId) { try { await doRename(profile, convId, arg.slice(0, 80)); } catch (e) {} }
    return;
  }

  if (!convId) { await newConv(); convId = currentConv(); if (!convId) return; }

  if (cmd === "clear") {
    try {
      await api(`/api/agent/${encodeURIComponent(profile)}/conversations/${encodeURIComponent(convId)}/reset`, { method: "POST" });
      pushSystem(convId, "🧹 Context cleared — the agent starts fresh from your next message. (Transcript kept; use Delete to remove it.)");
    } catch (e) { pushSystem(convId, "Could not clear context (bridge unreachable)."); }
    return;
  }

  if (cmd === "rename") {
    if (!arg) { pushSystem(convId, "Usage: /rename <new title>"); return; }
    try { await doRename(profile, convId, arg.slice(0, 80)); pushSystem(convId, `Renamed to “${arg.slice(0, 80)}”.`); }
    catch (e) { pushSystem(convId, "Rename failed."); }
    return;
  }

  if (cmd === "model") {
    if (!arg) {
      try {
        const r = await api(`/api/agent/${encodeURIComponent(profile)}/meta`);
        const m = (r && (r.model || (r.meta && r.meta.model) || (r.payload && r.payload.model))) || "unknown";
        pushSystem(convId, `Current model: ${m}\nSwitch with /model <name>.`);
      } catch (e) { pushSystem(convId, "Could not read the model."); }
    } else {
      try {
        await api(`/api/agent/${encodeURIComponent(profile)}/model`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: arg }),
        });
        pushSystem(convId, `Model set to ${arg}. (Applies on the next turn; the agent session reloads.)`);
        renderAgentCard();
      } catch (e) { pushSystem(convId, `Could not set model to “${arg}”.`); }
    }
    return;
  }

  if (cmd === "retry") {
    const msgs = chat.transcripts[convKey(profile, convId)] || [];
    let lastUser = null;
    for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === "user") { lastUser = msgs[i]; break; } }
    if (!lastUser) { pushSystem(convId, "Nothing to re-ask yet."); return; }
    // drop trailing agent/error/system bubbles so the new reply replaces them
    while (msgs.length && ["agent", "error", "system"].includes(msgs[msgs.length - 1].role)) msgs.pop();
    renderChat();
    await executeTurn(profile, convId, lastUser.text || "", lastUser.attachments || []);
    return;
  }
}

// After the FIRST exchange in a conversation, ask the server to generate a topic
// title (LLM via the bridge). Fire-and-forget; updates the title when it lands.
// Skipped if the user has renamed the thread (server enforces this too).
async function maybeAutoTitle(profile, convId) {
  chat.autoTitled = chat.autoTitled || new Set();
  const key = convKey(profile, convId);
  if (chat.autoTitled.has(key)) return;
  const msgs = (chat.transcripts[key] || []).filter((m) => m.role === "user" || m.role === "agent");
  if (msgs.length !== 2) return;  // only the very first user+agent exchange
  chat.autoTitled.add(key);
  try {
    const r = await api(`/api/agent/${encodeURIComponent(profile)}/conversations/${encodeURIComponent(convId)}/autotitle`, { method: "POST" });
    if (r && r.ok && r.title) {
      const c = (chat.convs[profile] || []).find((x) => x.id === convId);
      if (c) c.title = r.title;
      if (convId === currentConv()) updateConvTitle();
      if (profile === currentProfile()) renderConvList();
    }
  } catch (err) { /* best-effort — keep the first-message title */ }
}

$("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
$("#convSearch").addEventListener("input", onSearchInput);
$("#newConvBtn").addEventListener("click", newConv);
$("#convRenameBtn").addEventListener("click", () => renameConv());
$("#convDeleteBtn").addEventListener("click", () => deleteConv());

// Shared conversation actions menu: route each item to the stored target conv.
(function wireConvMenu() {
  const m = $("#convMenu");
  if (!m) return;
  m.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const convId = m.dataset.conv;
    const act = btn.dataset.act;
    closeConvMenu();
    if (!convId) return;
    if (act === "rename") renameConv(convId);
    else if (act === "delete") deleteConv(convId);
    else if (act === "pin") {
      const c = (chat.convs[currentProfile()] || []).find((x) => x.id === convId);
      pinConv(convId, !(c && c.pinned));
    }
    else if (act === "archive") {
      const c = (chat.convs[currentProfile()] || []).find((x) => x.id === convId);
      archiveConv(convId, !(c && c.archived));
    }
  });
  // Click-away / Escape closes the menu.
  document.addEventListener("click", (e) => {
    if (m.hidden) return;
    if (e.target.closest("#convMenu") || e.target.closest("[data-kebab]")) return;
    closeConvMenu();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeConvMenu(); });
})();

// ── Avatar editor (works for an agent or the dashboard brand "__brand") ──
let pendingAvatar = null; // {emoji} | {image}
let avatarTarget = null;  // profile name or "__brand"

function openAvatarEditor(target, label) {
  if (!target) return;
  avatarTarget = target;
  pendingAvatar = null;
  $("#avatarAgentName").textContent = label;
  $("#avatarEmoji").value = (chat.agentMeta[target] || {}).emoji || "";
  $("#avatarPreview").innerHTML = avatarHtml(target, 64);
  $("#avatarDialog").showModal();
}

const _brandMark = document.querySelector(".brand .mark");
if (_brandMark) {
  _brandMark.title = "Set dashboard icon";
  _brandMark.addEventListener("click", () => openAvatarEditor("__brand", "the dashboard"));
}

// On any "you" bubble: click the avatar to set a custom icon, or the name to
// rename yourself. Both use the reserved __you key (icon + label) in agent-meta.
const _chatLogEl = $("#chatLog");
if (_chatLogEl) {
  _chatLogEl.addEventListener("click", (e) => {
    const youName = (chat.agentMeta["__you"] || {}).label || "you";
    const approval = e.target.closest("[data-chat-approval]");
    if (approval) openChatApproval(approval.dataset.chatApproval);
    else if (e.target.closest(".you-ava-btn")) openAvatarEditor("__you", youName);
    else if (e.target.closest(".you-name-btn")) editYouName();
  });
}

async function editYouName() {
  const cur = (chat.agentMeta["__you"] || {}).label || "you";
  const name = window.prompt("Your display name:", cur);
  if (name === null) return;                       // cancelled
  const label = name.trim().slice(0, 64);
  try {
    const r = await fetch(`/api/agent/__you/label`, {
      method: "PUT", headers: headers(), body: JSON.stringify({ label }),
    });
    if (r.ok) {
      const d = await r.json();
      chat.agentMeta["__you"] = (d && d.meta) || chat.agentMeta["__you"] || {};
    }
  } catch (err) { /* ignore — keep current name */ }
  renderChat();
}

$("#avatarUploadBtn").addEventListener("click", () => $("#avatarFile").click());
$("#avatarFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  let dataUrl;
  try {
    dataUrl = await resizeImageToAvatar(f, 256); // normalize to a crisp 256² square
  } catch (err) {
    window.alert("Could not read that image. Try a PNG or JPEG.");
    return;
  }
  pendingAvatar = { image: dataUrl };
  $("#avatarEmoji").value = "";
  $("#avatarPreview").innerHTML = `<span class="ava" style="width:64px;height:64px"><img src="${escapeHtml(dataUrl)}" alt="" /></span>`;
});
$("#avatarEmoji").addEventListener("input", () => {
  const v = $("#avatarEmoji").value.trim();
  if (!v) { pendingAvatar = null; return; }
  pendingAvatar = { emoji: v };
  const bg = avatarTarget === "__brand" ? "#e8ecf2" : agentColor(avatarTarget);
  $("#avatarPreview").innerHTML = `<span class="ava" style="width:64px;height:64px;background:${bg};font-size:36px">${escapeHtml(v)}</span>`;
});
$("#avatarForm").addEventListener("submit", async (e) => {
  const action = e.submitter && e.submitter.value;
  const target = avatarTarget;
  if (action === "cancel" || !target) return; // let the dialog close normally
  e.preventDefault();
  if (action === "reset") {
    try { await fetch(`/api/agent/${encodeURIComponent(target)}/avatar`, { method: "DELETE" }); } catch (err) { /* ignore */ }
    delete chat.agentMeta[target];
  } else if (action === "save" && pendingAvatar) {
    try {
      const r = await api(`/api/agent/${encodeURIComponent(target)}/avatar`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pendingAvatar),
      });
      chat.agentMeta[target] = (r && r.avatar) || pendingAvatar;
    } catch (err) { /* ignore */ }
  }
  $("#avatarDialog").close();
  renderAgentPicker();
  renderAgentCard();
  renderChat();
  renderBrand();
  renderTerminalTargets();
});
// ── Agent settings (SOUL.md + model + icon) ─────────────────────────────────
let settingsTarget = null;

function setSettingsStatus(msg) {
  const el = $("#settingsStatus");
  if (el) el.textContent = msg || "";
}

async function openAgentSettings(profile) {
  if (!profile) return;
  settingsTarget = profile;
  $("#settingsAgentName").textContent = profile;
  $("#settingsLabel").value = (chat.agentMeta[profile] || {}).label || "";
  setSettingsStatus("");
  // Model picker: show a loading placeholder, then fill it from the bridge.
  const sel = $("#settingsModelSelect");
  const custom = $("#settingsModelCustom");
  custom.hidden = true;
  custom.value = "";
  sel.innerHTML = '<option value="">Loading models…</option>';
  sel.disabled = true;
  const soul = $("#settingsSoul");
  soul.value = "Loading SOUL.md…";
  soul.disabled = true;
  $("#settingsDialog").showModal();
  loadModelPicker(profile);   // fire-and-forget; fills the <select> when it lands
  try {
    const data = await api(`/api/agent/${encodeURIComponent(profile)}/soul`);
    soul.value = data.soul || "";
  } catch (err) {
    soul.value = "";
    setSettingsStatus("Could not load SOUL.md (agent offline?).");
  }
  soul.disabled = false;
}

// Fetch the available providers/models (same source as the Telegram `/model`
// picker) and render them as grouped options. Falls back to a single "current"
// entry when the bridge is unreachable, so the picker is never empty.
async function loadModelPicker(profile) {
  const fallbackModel = (chat.agentInfo[profile] || {}).model || "";
  const fallbackProvider = (chat.agentInfo[profile] || {}).provider || "";
  try {
    const data = await api(`/api/agent/${encodeURIComponent(profile)}/models`);
    if (profile !== settingsTarget) return;   // dialog already moved on
    populateModelSelect(data || {}, fallbackModel, fallbackProvider);
  } catch (err) {
    if (profile !== settingsTarget) return;
    populateModelSelect(
      { current_model: fallbackModel, current_provider: fallbackProvider, providers: [] },
      fallbackModel, fallbackProvider);
  }
}

function populateModelSelect(data, fallbackModel, fallbackProvider) {
  const sel = $("#settingsModelSelect");
  const cur = data.current_model || fallbackModel || "";
  const curProv = data.current_provider || fallbackProvider || "";
  sel.innerHTML = "";
  let matched = false;
  const providers = Array.isArray(data.providers) ? data.providers : [];
  for (const p of providers) {
    const models = Array.isArray(p.models) ? p.models : [];
    if (!models.length) continue;
    const og = document.createElement("optgroup");
    const count = (p.total_models != null) ? p.total_models : models.length;
    og.label = `${p.name || p.slug} (${count})`;
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      o.dataset.provider = p.slug || "";
      if (!matched && m === cur && (!curProv || p.slug === curProv)) {
        o.selected = true;
        matched = true;
      }
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  // Current model not present in any list (custom / off-catalog): surface it
  // first so the picker still reflects what's actually configured.
  if (cur && !matched) {
    const og = document.createElement("optgroup");
    og.label = "Current";
    const o = document.createElement("option");
    o.value = cur;
    o.textContent = `${cur} (current)`;
    o.dataset.provider = curProv;
    o.selected = true;
    og.appendChild(o);
    sel.insertBefore(og, sel.firstChild);
  }
  if (!sel.options.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No models available";
    sel.appendChild(o);
  }
  // Always offer a manual entry path for off-catalog ids.
  const cog = document.createElement("optgroup");
  cog.label = "Other";
  const co = document.createElement("option");
  co.value = "__custom__";
  co.textContent = "✏ Custom model id…";
  cog.appendChild(co);
  sel.appendChild(cog);
  sel.disabled = false;
}

async function saveSoul() {
  const profile = settingsTarget;
  if (!profile) return;
  setSettingsStatus("Saving SOUL.md…");
  try {
    const r = await fetch(`/api/agent/${encodeURIComponent(profile)}/soul`, {
      method: "PUT", headers: headers(), body: JSON.stringify({ text: $("#settingsSoul").value }),
    });
    if (!r.ok) { setSettingsStatus(r.status === 401 ? "Admin token required." : "Save failed."); return; }
    setSettingsStatus("SOUL.md saved · agent session reset.");
    await loadAgentInfo(profile);
  } catch (err) { setSettingsStatus("Save failed (agent unreachable)."); }
}

async function saveLabel() {
  const profile = settingsTarget;
  if (!profile) return;
  const label = $("#settingsLabel").value.trim();
  setSettingsStatus("Saving display name…");
  try {
    const r = await fetch(`/api/agent/${encodeURIComponent(profile)}/label`, {
      method: "PUT", headers: headers(), body: JSON.stringify({ label }),
    });
    if (!r.ok) { setSettingsStatus(r.status === 401 ? "Admin token required." : "Could not set name."); return; }
    const data = await r.json();
    chat.agentMeta[profile] = (data && data.meta) || chat.agentMeta[profile];
    setSettingsStatus(label ? "Display name saved." : "Display name cleared.");
    renderAgentPicker(); renderAgentCard(); renderChat(); renderBrand(); renderTerminalTargets();
  } catch (err) { setSettingsStatus("Save failed (unreachable)."); }
}

async function saveModel() {
  const profile = settingsTarget;
  if (!profile) return;
  const sel = $("#settingsModelSelect");
  let model = sel.value;
  let provider = "";
  if (model === "__custom__") {
    model = $("#settingsModelCustom").value.trim();
    // provider left empty → bridge keeps the current provider
  } else {
    const opt = sel.options[sel.selectedIndex];
    provider = opt ? (opt.dataset.provider || "") : "";
  }
  if (!model) { setSettingsStatus("Pick a model or enter a custom id first."); return; }
  setSettingsStatus("Setting model…");
  try {
    const body = { model };
    if (provider) body.provider = provider;
    const r = await fetch(`/api/agent/${encodeURIComponent(profile)}/model`, {
      method: "PUT", headers: headers(), body: JSON.stringify(body),
    });
    if (!r.ok) { setSettingsStatus(r.status === 401 ? "Admin token required." : "Could not set model."); return; }
    setSettingsStatus("Model updated · agent session reset.");
    await loadAgentInfo(profile);
  } catch (err) { setSettingsStatus("Update failed (agent unreachable)."); }
}

$("#settingsSaveSoul").addEventListener("click", saveSoul);
$("#settingsSaveLabel").addEventListener("click", saveLabel);
$("#settingsSaveModel").addEventListener("click", saveModel);
// Reveal the free-text input only when "Custom model id…" is chosen.
$("#settingsModelSelect").addEventListener("change", () => {
  const isCustom = $("#settingsModelSelect").value === "__custom__";
  const custom = $("#settingsModelCustom");
  custom.hidden = !isCustom;
  if (isCustom) custom.focus();
});
$("#settingsIconBtn").addEventListener("click", () => {
  const p = settingsTarget;
  $("#settingsDialog").close();
  if (p) openAvatarEditor(p, p);   // hand off to the existing icon editor
});

$("#attachBtn").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

const chatText = $("#chatText");
chatText.addEventListener("input", () => autoGrow(chatText));
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
chatText.addEventListener("paste", (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) addFiles([f]);
    }
  }
});

const chatLog = $("#chatLog");
["dragover", "dragenter"].forEach((ev) => chatLog.addEventListener(ev, (e) => { e.preventDefault(); chatLog.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) => chatLog.addEventListener(ev, (e) => { e.preventDefault(); chatLog.classList.remove("dragover"); }));
chatLog.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

loadState();
loadAgentMeta();
loadAgentsHealth();
loadUsage();
loadCron();
loadKanban();
loadOperations();
setInterval(loadState, 15000);
setInterval(() => updateFreshnessStatus(), 15000);
setInterval(loadAgentsHealth, 15000);
setInterval(loadUsage, 30000);
setInterval(() => { if ($("#view-tasks").classList.contains("active")) loadKanban(); }, 15000);
setInterval(() => { if ($("#view-calendar").classList.contains("active")) loadCron(); }, 30000);
setInterval(loadOperations, 15000);

// Return to the view the operator was last on (Overview is the HTML default).
try {
  const saved = localStorage.getItem(VIEW_STORE_KEY);
  if (saved && saved !== "overview") activateView(saved);
} catch (e) { /* storage unavailable — stay on Overview */ }
