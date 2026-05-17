// Normalized status vocabulary + audit emitter. MUST stay in sync with the
// worker-side mirror at worker/worker.js — both copies update together
// when a new status string ships. Dashboards group on status_kind, not on
// the raw status. An unmapped status falls through to "unknown" so an
// alert on `status_kind:unknown` surfaces drift.
//
// `policy_version` is anchored to the (sites.json, clients.json) pair in
// effect at emit time so operators querying historical lines can correlate
// "which policy was active when this event fired" without commit history
// or container-restart timestamps.

const STATUS_KIND = {
  success: ["ok", "logged_in", "logged_out", "dry_run", "listed_sites"],
  needs_user: ["awaiting_otp", "awaiting_fresh_sms", "needs_user_action"],
  session_expired: ["session_expired", "no_session"],
  rate_limited: ["rate_limited"],
  needs_update: ["needs_extractor_update", "needs_site_selector_update"],
  denied: ["denied_by_client_policy", "denied_invalid_args"],
  error: ["failed", "extractor_timeout"]
};

const _statusKindIndex = new Map();
for (const [kind, statuses] of Object.entries(STATUS_KIND)) {
  for (const s of statuses) _statusKindIndex.set(s, kind);
}

function statusToKind(status) {
  if (typeof status !== "string" || status.length === 0) return "unknown";
  return _statusKindIndex.get(status) || "unknown";
}

// Create the audit emitter. `policyVersionFn` is a getter that returns the
// current policy version string; passed in rather than imported to avoid a
// dependency cycle and to keep this module purely functional. `component`
// is the JSON field shipped to Wazuh that identifies which container emitted.
function createAudit({ component, policyVersionFn }) {
  return function audit(event) {
    const status_kind = "status_kind" in event ? event.status_kind : statusToKind(event.result);
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      component,
      event_type: "audit",
      status_kind,
      policy_version: policyVersionFn(),
      ...event
    })}\n`);
  };
}

// Sanitize an error message before logging it to stderr or returning it to a
// JSON-RPC caller. Worker errors propagated through workerCall can include
// the underlying Playwright text — URLs in those errors often carry session
// tokens. Replace any URL with origin+pathname only and truncate so a stray
// page-HTML dump can't blow up an audit log line. Mirrored in worker.js.
const URL_REDACT_RE = /https?:\/\/[^\s"'<>`]+/g;
function redactErrorMessage(err) {
  if (!err) return "";
  const raw = err.message || String(err);
  const sanitized = raw.replace(URL_REDACT_RE, (m) => {
    try {
      const u = new URL(m);
      return `${u.origin}${u.pathname}`;
    } catch {
      return "[URL]";
    }
  });
  return sanitized.length > 500 ? `${sanitized.slice(0, 500)}…[truncated]` : sanitized;
}

module.exports = {
  STATUS_KIND,
  statusToKind,
  createAudit,
  redactErrorMessage
};
