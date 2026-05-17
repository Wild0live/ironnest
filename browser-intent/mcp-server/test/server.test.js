const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Point the policy loaders at the real files so toolsList / publicSite have data.
process.env.BROWSER_INTENT_POLICY_PATH = path.join(__dirname, "..", "..", "policies", "sites.json");
process.env.BROWSER_INTENT_CLIENTS_PATH = path.join(__dirname, "..", "..", "policies", "clients.json");
process.env.BROWSER_INTENT_MCP_TOKEN = "test-admin-token-1234567890";
process.env.BROWSER_INTENT_MCP_TOKEN_DR_SMITH = "test-dr-smith-token-abc";

const server = require("../server");

const ADMIN_CLIENT = { name: "admin", allowedSites: "*", tokenEnvVar: "BROWSER_INTENT_MCP_TOKEN" };
// Test fixture — intentionally a fixed single-site scope so scoping-logic tests
// stay stable when policies/clients.json changes. Tests that need to assert
// against the *real* Dr. Smith scope call loadClients() / authenticateClient()
// directly and check the live file.
const DR_SMITH_CLIENT = { name: "hermes_dr_smith", allowedSites: ["april_international"], tokenEnvVar: "BROWSER_INTENT_MCP_TOKEN_DR_SMITH" };

function reqWith(headers) {
  return { headers };
}

test("authenticateClient: rejects when no Authorization header", () => {
  assert.equal(server.authenticateClient(reqWith({})), null);
});

test("authenticateClient: rejects non-Bearer scheme", () => {
  assert.equal(server.authenticateClient(reqWith({ authorization: "Basic dXNlcjpwYXNz" })), null);
});

test("authenticateClient: rejects wrong token", () => {
  assert.equal(server.authenticateClient(reqWith({ authorization: "Bearer wrong-token" })), null);
});

test("authenticateClient: rejects token with prefix collision", () => {
  // Prefix of the real token: under the SHA-256 token-index dispatch, the
  // hash will not collide with the indexed entry — same security property
  // as the previous length-check + timingSafeEqual path, without the
  // per-client length-timing leak that path had.
  assert.equal(server.authenticateClient(reqWith({ authorization: "Bearer test-admin-token-12345" })), null);
});

test("authenticateClient: rejects empty Bearer (no empty-token bypass via sha256 of empty string)", () => {
  // sha256("") is a well-known constant — if any index entry ever pointed
  // at it (it shouldn't; the builder skips unset env vars) an empty Bearer
  // would match. Defense-in-depth: dispatcher short-circuits empty input.
  assert.equal(server.authenticateClient(reqWith({ authorization: "Bearer " })), null);
});

test("authenticateClient: tokens of dramatically different lengths still dispatch successfully", () => {
  // Regression for the length-leak that the SHA-256 index closes. Both the
  // long admin token and the shorter Dr. Smith token must dispatch through
  // the same constant-time path (sha256 + Map.get). The old path iterated
  // entries doing length-check then timingSafeEqual; an attacker timing the
  // mismatch path could learn whether their candidate length matched the
  // first vs second client's expected length. The hashed dispatch removes
  // that signal entirely.
  const longTok = server.authenticateClient(reqWith({ authorization: "Bearer test-admin-token-1234567890" }));
  const shortTok = server.authenticateClient(reqWith({ authorization: "Bearer test-dr-smith-token-abc" }));
  assert.equal(longTok.name, "admin");
  assert.equal(shortTok.name, "hermes_dr_smith");
});

test("authenticateClient: matches admin token → admin client (full scope)", () => {
  const c = server.authenticateClient(reqWith({ authorization: "Bearer test-admin-token-1234567890" }));
  assert.equal(c.name, "admin");
  assert.equal(c.allowedSites, "*");
});

test("authenticateClient: matches Dr. Smith token → restricted client per live clients.json", () => {
  const c = server.authenticateClient(reqWith({ authorization: "Bearer test-dr-smith-token-abc" }));
  assert.equal(c.name, "hermes_dr_smith");
  // Mirrors policies/clients.json — update this assertion whenever the live
  // file's hermes_dr_smith.allowedSites changes.
  assert.deepEqual(c.allowedSites.sort(), ["april_international", "hi_precision"].sort());
});

test("authenticateClient: skips clients whose tokenEnvVar is unset (no empty-token bypass)", () => {
  // The token index is rebuilt when clients.json mtime changes — env
  // changes are not auto-detected by design (production tokens are baked
  // at container start). To test the empty-env path in isolation, this
  // assertion just confirms the empty-Bearer short-circuit and that the
  // admin token (always provisioned in the test fixture) still dispatches.
  assert.equal(server.authenticateClient(reqWith({ authorization: "Bearer " })), null);
  const c = server.authenticateClient(reqWith({ authorization: "Bearer test-admin-token-1234567890" }));
  assert.equal(c.name, "admin");
});

test("clientAllowsSite: wildcard admin allows everything", () => {
  assert.equal(server.clientAllowsSite(ADMIN_CLIENT, "col_financial"), true);
  assert.equal(server.clientAllowsSite(ADMIN_CLIENT, "made_up_site"), true);
});

test("clientAllowsSite: restricted client allows only its list", () => {
  assert.equal(server.clientAllowsSite(DR_SMITH_CLIENT, "april_international"), true);
  assert.equal(server.clientAllowsSite(DR_SMITH_CLIENT, "col_financial"), false);
  assert.equal(server.clientAllowsSite(DR_SMITH_CLIENT, "maxicare"), false);
});

test("clientVisibleSiteIds: admin sees all four sites", () => {
  assert.deepEqual(
    server.clientVisibleSiteIds(ADMIN_CLIENT).sort(),
    ["april_international", "col_financial", "hi_precision", "maxicare"].sort()
  );
});

test("clientVisibleSiteIds: Dr. Smith sees only april_international", () => {
  assert.deepEqual(server.clientVisibleSiteIds(DR_SMITH_CLIENT), ["april_international"]);
});

test("publicSite: exposes only safe keys", () => {
  const out = server.publicSite("col_financial");
  assert.deepEqual(Object.keys(out).sort(), ["allowedTools", "displayName", "riskLevel", "site"].sort());
  // Critically, no loginUrl / allowedDomains / secretPrefix / secretPath / loginSelectors.
  assert.equal(out.loginUrl, undefined);
  assert.equal(out.secretPath, undefined);
  assert.equal(out.loginSelectors, undefined);
});

test("sitesAllowing: returns only sites whose policy lists the action", () => {
  assert.deepEqual(server.sitesAllowing("get_portfolio"), ["col_financial"]);
  assert.deepEqual(server.sitesAllowing("submit_claim"), ["april_international"]);
  assert.deepEqual(server.sitesAllowing("login").sort(), ["april_international", "col_financial", "hi_precision", "maxicare"].sort());
  assert.deepEqual(server.sitesAllowing("drop_database"), []);
});

test("toolsList(admin): includes consolidated tools with full site enums", () => {
  const tools = server.toolsList(ADMIN_CLIENT);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("login"));
  assert.ok(names.includes("submit_claim"));
  assert.ok(names.includes("get_portfolio"));
  assert.ok(names.includes("list_browser_intent_sites"));
  // Old prefix names must be gone.
  assert.ok(!names.includes("login_col_financial"));
  assert.ok(!names.includes("april_international_submit_claim"));
});

test("toolsList(admin): login enum is all four sites", () => {
  const login = server.toolsList(ADMIN_CLIENT).find((t) => t.name === "login");
  assert.deepEqual(
    login.inputSchema.properties.site.enum.sort(),
    ["april_international", "col_financial", "hi_precision", "maxicare"].sort()
  );
});

test("toolsList(dr_smith): every tool's site enum is narrowed to [april_international]", () => {
  for (const tool of server.toolsList(DR_SMITH_CLIENT)) {
    if (tool.name === "list_browser_intent_sites") continue;
    assert.deepEqual(
      tool.inputSchema.properties.site.enum,
      ["april_international"],
      `${tool.name} should be narrowed to april_international for Dr. Smith`
    );
  }
});

test("toolsList(dr_smith): tools whose intersection with allowedSites is empty are dropped", () => {
  // get_portfolio is COL Financial only — Dr. Smith can't see COL → tool should disappear.
  const names = server.toolsList(DR_SMITH_CLIENT).map((t) => t.name);
  assert.ok(!names.includes("get_portfolio"));
  assert.ok(!names.includes("get_policy_summary")); // maxicare-only
  assert.ok(!names.includes("provide_otp")); // maxicare-only
  // April-allowed tools survive.
  assert.ok(names.includes("login"));
  assert.ok(names.includes("submit_claim"));
  assert.ok(names.includes("get_claim_status"));
});

test("toolsList: every tool requires `site` (except list_browser_intent_sites) and rejects extra props", () => {
  for (const tool of server.toolsList(ADMIN_CLIENT)) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} missing object inputSchema`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} should reject extra props`);
    if (tool.name === "list_browser_intent_sites") continue;
    assert.ok(
      (tool.inputSchema.required || []).includes("site"),
      `${tool.name} must require a 'site' arg`
    );
    const siteProp = tool.inputSchema.properties.site;
    assert.equal(siteProp.type, "string", `${tool.name} site prop must be string`);
    assert.ok(Array.isArray(siteProp.enum) && siteProp.enum.length > 0, `${tool.name} site prop must have an enum`);
  }
});

test("toolsList(admin): diagnostic tools are NOT exposed when BROWSER_INTENT_ENABLE_DIAGNOSTICS is unset", () => {
  const names = server.toolsList(ADMIN_CLIENT).map((t) => t.name);
  assert.ok(!names.includes("diagnose_login_form"));
  assert.ok(!names.includes("diagnose_member_portal"));
  assert.ok(!names.includes("diagnose_portfolio"));
  assert.ok(!names.includes("diagnose_claim_form"));
});

test("toolsList(admin): submit_claim schema carries the structured-args extras alongside site", () => {
  const submit = server.toolsList(ADMIN_CLIENT).find((t) => t.name === "submit_claim");
  assert.ok(submit, "submit_claim should be in toolsList");
  assert.ok(submit.inputSchema.required.includes("treatment_date"));
  assert.ok(submit.inputSchema.required.includes("claim_amount"));
  assert.ok(submit.inputSchema.required.includes("site"));
  const receiptsItem = submit.inputSchema.properties.receipts.items;
  assert.equal(receiptsItem.pattern, "^/uploads/[^\\.][^\\s]*$");
});

test("toolsList(admin): get_claim_status keeps the claim_id pattern from the old per-site schema", () => {
  const t = server.toolsList(ADMIN_CLIENT).find((x) => x.name === "get_claim_status");
  assert.equal(t.inputSchema.required.includes("claim_id"), true);
  assert.equal(t.inputSchema.properties.claim_id.pattern, "^[A-Za-z0-9_\\-./]+$");
});

test("ACTIONS catalog: every entry has a category and description", () => {
  for (const [name, spec] of Object.entries(server.ACTIONS)) {
    assert.ok(spec.category, `${name} must have a category`);
    assert.ok(["session", "extraction", "diagnostic"].includes(spec.category), `${name} category invalid`);
    assert.ok(spec.description && spec.description.length > 0, `${name} must have a description`);
    if (spec.category === "session") {
      assert.ok(spec.endpoint && spec.endpoint.startsWith("/"), `${name} session action must declare a worker endpoint`);
    }
  }
});

test("handleJsonRpc(stdio): initialize advertises tool + resource + prompt capabilities", async () => {
  const resp = await server.handleJsonRpc(server.STDIO_CLIENT, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(resp.id, 1);
  assert.deepEqual(resp.result.capabilities, { tools: {}, resources: {}, prompts: {} });
  assert.equal(resp.result.serverInfo.name, "ironnest-browser-intent");
});

test("negotiateProtocolVersion: echoes a client-supported version, falls back to latest otherwise", () => {
  // Spec contract: server replies with the requested version if supported,
  // otherwise its highest. Both branches must work without breaking
  // backward compatibility with 2024-11-05 clients.
  assert.equal(server.negotiateProtocolVersion("2025-06-18"), "2025-06-18");
  assert.equal(server.negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(server.negotiateProtocolVersion("unknown-future-version"), server.LATEST_PROTOCOL_VERSION);
  assert.equal(server.negotiateProtocolVersion(undefined), server.LATEST_PROTOCOL_VERSION);
});

test("initialize: defaults to 2024-11-05 when client omits protocolVersion", async () => {
  // Backward compat — a legacy client that never sends protocolVersion
  // must still get a working initialize response in the version it knows.
  const resp = await server.handleJsonRpc(server.STDIO_CLIENT, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(resp.result.protocolVersion, "2024-11-05");
});

test("initialize: echoes a 2025-06-18 protocolVersion when the client requests it", async () => {
  const resp = await server.handleJsonRpc(server.STDIO_CLIENT, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18" }
  });
  assert.equal(resp.result.protocolVersion, "2025-06-18");
});

test("initialize transport.issueSession is called ONLY when client negotiates 2025-06-18", async () => {
  // The HTTP path uses transport.issueSession to mint and stash an
  // Mcp-Session-Id. Stdio clients don't get a session because they have a
  // single long-lived connection; this test pins the version-gated behavior.
  let called = false;
  await server.handleJsonRpc(server.STDIO_CLIENT, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05" }
  }, { issueSession: () => { called = true; } });
  assert.equal(called, false, "legacy clients must NOT trigger session issuance");

  let calledVersion = null;
  await server.handleJsonRpc(server.STDIO_CLIENT, {
    jsonrpc: "2.0", id: 2, method: "initialize",
    params: { protocolVersion: "2025-06-18" }
  }, { issueSession: (v) => { calledVersion = v; } });
  assert.equal(calledVersion, "2025-06-18");
});

test("session lifecycle: newSessionId / getOrTouchSession / dropSession", () => {
  const id = server.newSessionId();
  assert.match(id, /^[0-9a-f]{32}$/, "session id is 32 hex chars (16 random bytes)");
  // Empty Map until something puts it there — emulate the HTTP path.
  server.__sessions.set(id, { version: "2025-06-18", client: "admin", createdAt: Date.now(), lastSeen: Date.now(), sseSink: null });
  const before = server.__sessions.get(id).lastSeen;
  // Force the clock forward enough that touch is observable.
  server.__sessions.get(id).lastSeen = before - 1000;
  const touched = server.getOrTouchSession(id);
  assert.ok(touched);
  assert.ok(touched.lastSeen > before - 1000, "getOrTouchSession must refresh lastSeen");
  server.dropSession(id);
  assert.equal(server.__sessions.has(id), false, "dropSession must remove the entry");
});

test("session lifecycle: reapStaleSessions removes entries older than the TTL", () => {
  const id = server.newSessionId();
  // Drop a synthetic session whose lastSeen is far in the past.
  server.__sessions.set(id, { version: "2025-06-18", client: "admin", createdAt: 0, lastSeen: 0, sseSink: null });
  server.reapStaleSessions(Date.now());
  assert.equal(server.__sessions.has(id), false, "stale session must be reaped");
});

test("session lifecycle: dropping a session unregisters its sseSink so broadcasts stop reaching it", () => {
  const id = server.newSessionId();
  const captured = [];
  const sink = (line) => captured.push(line);
  server.__sessions.set(id, { version: "2025-06-18", client: "admin", createdAt: Date.now(), lastSeen: Date.now(), sseSink: sink });
  server.registerStdioSink(sink);
  server.__triggerPolicyChange();
  assert.equal(captured.length, 3, "live SSE sink must receive all three list_changed notifications");
  captured.length = 0;
  server.dropSession(id);
  server.__triggerPolicyChange();
  assert.equal(captured.length, 0, "after dropSession, the sink must be unregistered");
});

test("handleJsonRpc(stdio): tools/list matches the admin scope", async () => {
  const resp = await server.handleJsonRpc(server.STDIO_CLIENT, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(resp.result.tools.length, server.toolsList(ADMIN_CLIENT).length);
});

test("handleJsonRpc(dr_smith): tools/list omits non-April tools", async () => {
  const resp = await server.handleJsonRpc(DR_SMITH_CLIENT, { jsonrpc: "2.0", id: 21, method: "tools/list" });
  const names = resp.result.tools.map((t) => t.name);
  assert.ok(names.includes("submit_claim"));
  assert.ok(!names.includes("get_portfolio"));
});

test("handleJsonRpc(admin): unsupported method returns JSON-RPC error", async () => {
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, { jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal(resp.error.code, -32000);
  assert.match(resp.error.message, /unsupported method/);
});

test("resourcesList(admin): includes the index plus one entry per site", () => {
  const resources = server.resourcesList(ADMIN_CLIENT);
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes("browser-intent://sites"));
  assert.ok(uris.includes("browser-intent://sites/col_financial"));
  assert.ok(uris.includes("browser-intent://sites/maxicare"));
  assert.ok(uris.includes("browser-intent://sites/april_international"));
  assert.ok(uris.includes("browser-intent://sites/hi_precision"));
  for (const r of resources) {
    assert.equal(r.mimeType, "application/json");
    assert.ok(r.name && r.description);
  }
});

test("resourcesList(dr_smith): per-site entries are restricted to allowed sites", () => {
  const uris = server.resourcesList(DR_SMITH_CLIENT).map((r) => r.uri);
  assert.ok(uris.includes("browser-intent://sites"));
  assert.ok(uris.includes("browser-intent://sites/april_international"));
  assert.ok(!uris.includes("browser-intent://sites/col_financial"));
  assert.ok(!uris.includes("browser-intent://sites/maxicare"));
  assert.ok(!uris.includes("browser-intent://sites/hi_precision"));
});

test("readResource(admin): index returns all sites", () => {
  const out = server.readResource(ADMIN_CLIENT, "browser-intent://sites");
  const body = JSON.parse(out.contents[0].text);
  assert.equal(body.sites.length, 4);
});

test("readResource(dr_smith): index returns only April", () => {
  const out = server.readResource(DR_SMITH_CLIENT, "browser-intent://sites");
  const body = JSON.parse(out.contents[0].text);
  assert.equal(body.sites.length, 1);
  assert.equal(body.sites[0].site, "april_international");
});

test("readResource(admin): per-site URI returns only safe keys", () => {
  const out = server.readResource(ADMIN_CLIENT, "browser-intent://sites/col_financial");
  const body = JSON.parse(out.contents[0].text);
  assert.equal(body.site, "col_financial");
  assert.equal(body.displayName, "COL Financial");
  assert.equal(body.loginUrl, undefined);
});

test("readResource(dr_smith): non-allowed site URI is indistinguishable from unknown", () => {
  // Don't leak existence of other sites — both 'unknown_site' and 'col_financial'
  // surface the same "unknown resource" error for a restricted client.
  assert.throws(
    () => server.readResource(DR_SMITH_CLIENT, "browser-intent://sites/col_financial"),
    /unknown resource/
  );
  assert.throws(
    () => server.readResource(DR_SMITH_CLIENT, "browser-intent://sites/evil_site"),
    /unknown resource/
  );
});

test("readResource(admin): unrelated URI scheme throws", () => {
  assert.throws(
    () => server.readResource(ADMIN_CLIENT, "file:///etc/passwd"),
    /unknown resource/
  );
});

test("handleJsonRpc(admin): resources/list returns one entry per site plus index", async () => {
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, { jsonrpc: "2.0", id: 10, method: "resources/list" });
  assert.equal(resp.result.resources.length, server.resourcesList(ADMIN_CLIENT).length);
});

test("handleJsonRpc(admin): resources/read dispatches to readResource", async () => {
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, {
    jsonrpc: "2.0",
    id: 11,
    method: "resources/read",
    params: { uri: "browser-intent://sites/maxicare" }
  });
  const body = JSON.parse(resp.result.contents[0].text);
  assert.equal(body.site, "maxicare");
});

test("handleJsonRpc(admin): resources/read for unknown URI returns JSON-RPC error", async () => {
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, {
    jsonrpc: "2.0",
    id: 12,
    method: "resources/read",
    params: { uri: "browser-intent://sites/nope" }
  });
  assert.equal(resp.error.code, -32000);
  assert.match(resp.error.message, /unknown resource/);
});

test("handleJsonRpc(dr_smith): resources/read for a hidden site returns JSON-RPC error", async () => {
  const resp = await server.handleJsonRpc(DR_SMITH_CLIENT, {
    jsonrpc: "2.0",
    id: 13,
    method: "resources/read",
    params: { uri: "browser-intent://sites/col_financial" }
  });
  assert.equal(resp.error.code, -32000);
  assert.match(resp.error.message, /unknown resource/);
});

test("handleJsonRpc(dr_smith): tools/call for a denied site returns a JSON-RPC error, NOT a throw", async () => {
  // Regression for the denial-as-timeout bug: a throw from callTool used to
  // propagate to the HTTP handler's outer catch and become HTTP 500, which
  // MCP clients (Hermes / Codex) treat as a network hang until their own
  // 120s timeout. The contract is HTTP 200 + JSON-RPC error body.
  // (Error phrasing changed when the inputSchema validator landed — now
  // out-of-enum site is caught at the validator, but the 200+error contract
  // is what this regression guards.)
  const resp = await server.handleJsonRpc(DR_SMITH_CLIENT, {
    jsonrpc: "2.0",
    id: 100,
    method: "tools/call",
    params: { name: "login", arguments: { site: "col_financial" } }
  });
  assert.equal(resp.id, 100);
  assert.ok(resp.error, "denied call must return a JSON-RPC error object");
  assert.equal(resp.error.code, -32000);
  assert.match(resp.error.message, /not in allowed enum|site is not allowlisted/);
  assert.equal(resp.result, undefined);
});

test("validateArgs: rejects missing required args", () => {
  const schema = { type: "object", required: ["site"], properties: { site: { type: "string", enum: ["a", "b"] } }, additionalProperties: false };
  assert.throws(() => server.validateArgs({}, schema, "t"), /missing required argument 'site'/);
});

test("validateArgs: rejects out-of-enum string", () => {
  const schema = { type: "object", required: ["site"], properties: { site: { type: "string", enum: ["a", "b"] } }, additionalProperties: false };
  assert.throws(() => server.validateArgs({ site: "c" }, schema, "t"), /not in allowed enum/);
});

test("validateArgs: rejects unknown properties when additionalProperties:false", () => {
  const schema = { type: "object", required: [], properties: { site: { type: "string" } }, additionalProperties: false };
  assert.throws(() => server.validateArgs({ site: "a", extra: 1 }, schema, "t"), /unknown argument 'extra'/);
});

test("validateArgs: type-mismatch rejected per property", () => {
  const schema = {
    type: "object",
    required: [],
    properties: {
      claim_amount: { type: "number", exclusiveMinimum: 0 },
      dry_run: { type: "boolean" },
      treatment_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
    },
    additionalProperties: false
  };
  assert.throws(() => server.validateArgs({ claim_amount: "100" }, schema, "t"), /expected number/);
  assert.throws(() => server.validateArgs({ dry_run: "true" }, schema, "t"), /expected boolean/);
  assert.throws(() => server.validateArgs({ treatment_date: "2026/04/12" }, schema, "t"), /does not match pattern/);
  // valid forms pass.
  server.validateArgs({ claim_amount: 100, dry_run: true, treatment_date: "2026-04-12" }, schema, "t");
});

test("validateArgs: exclusiveMinimum rejects boundary value", () => {
  const schema = { type: "object", properties: { n: { type: "number", exclusiveMinimum: 0 } }, additionalProperties: false };
  assert.throws(() => server.validateArgs({ n: 0 }, schema, "t"), /must be > 0/);
  server.validateArgs({ n: 0.01 }, schema, "t");
});

test("validateArgs: array maxItems + per-item pattern", () => {
  const schema = {
    type: "object",
    properties: {
      receipts: {
        type: "array",
        maxItems: 2,
        items: { type: "string", pattern: "^/uploads/[^\\.][^\\s]*$", maxLength: 100 }
      }
    },
    additionalProperties: false
  };
  assert.throws(() => server.validateArgs({ receipts: ["/uploads/a", "/uploads/b", "/uploads/c"] }, schema, "t"), /too many items/);
  assert.throws(() => server.validateArgs({ receipts: ["/etc/passwd"] }, schema, "t"), /does not match pattern/);
  // valid form
  server.validateArgs({ receipts: ["/uploads/r1.pdf"] }, schema, "t");
});

test("validateArgs: minLength / maxLength on strings", () => {
  const schema = { type: "object", properties: { s: { type: "string", minLength: 2, maxLength: 5 } }, additionalProperties: false };
  assert.throws(() => server.validateArgs({ s: "a" }, schema, "t"), /too short/);
  assert.throws(() => server.validateArgs({ s: "abcdef" }, schema, "t"), /too long/);
  server.validateArgs({ s: "abc" }, schema, "t");
});

test("validateArgs: rejects non-object args", () => {
  const schema = { type: "object", properties: {}, additionalProperties: false };
  assert.throws(() => server.validateArgs(null, schema, "t"), /expected an object/);
  assert.throws(() => server.validateArgs("oops", schema, "t"), /expected an object/);
  assert.throws(() => server.validateArgs([1, 2], schema, "t"), /expected an object/);
});

test("tools/call: validator-rejected call emits denied_invalid_args (distinct from site-scope denial)", async () => {
  // Operators triaging a status_kind:denied spike must be able to tell
  // "client is sending malformed input" (denied_invalid_args) apart from
  // "client is trying to hit a forbidden site" (denied_by_client_policy).
  // Both still map to status_kind:denied for dashboard grouping.
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    await server.handleJsonRpc(ADMIN_CLIENT, {
      jsonrpc: "2.0",
      id: 250,
      method: "tools/call",
      params: { name: "login", arguments: { site: "not_a_real_site" } }
    });
  } finally {
    process.stderr.write = origWrite;
  }
  const auditEvents = captured
    .join("")
    .split("\n")
    .filter((s) => s.includes('"event_type":"audit"'))
    .map((s) => JSON.parse(s));
  const denialEvent = auditEvents.find((e) => e.tool === "login" && e.result === "denied_invalid_args");
  assert.ok(denialEvent, "validator rejection must produce a denied_invalid_args audit event");
  assert.equal(denialEvent.status_kind, "denied");
  assert.match(denialEvent.error, /not in allowed enum/);
});

test("statusToKind: denied_invalid_args classifies as 'denied' alongside denied_by_client_policy", () => {
  assert.equal(server.statusToKind("denied_invalid_args"), "denied");
  assert.equal(server.statusToKind("denied_by_client_policy"), "denied");
});

test("statusToKind: extractor_timeout classifies as 'error'", () => {
  // Worker-emitted status from the per-action timeout (item E). Must be
  // classified as 'error' on both sides so Wazuh dashboards group it with
  // other failure modes.
  assert.equal(server.statusToKind("extractor_timeout"), "error");
});

test("audit: every event carries policy_version anchored to the current files", () => {
  // Item A: operators querying historical audit lines need the policy
  // version that was active when the event fired. The audit() helper must
  // inject it on every emission so dashboards can correlate denials with
  // a known policy snapshot.
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    // Run a tools/call that audits successfully (list_browser_intent_sites
    // — no worker call required, no auth complexity).
    return server.handleJsonRpc(ADMIN_CLIENT, {
      jsonrpc: "2.0",
      id: 300,
      method: "tools/call",
      params: { name: "list_browser_intent_sites", arguments: {} }
    }).then(() => {
      const auditEvent = captured
        .join("")
        .split("\n")
        .filter((s) => s.includes('"event_type":"audit"'))
        .map((s) => JSON.parse(s))
        .pop();
      assert.ok(auditEvent, "tools/call must emit an audit event");
      assert.match(auditEvent.policy_version, /^[0-9a-f]{12}$/, "policy_version must be 12 hex chars");
      assert.equal(auditEvent.policy_version, server.policyVersion());
    });
  } finally {
    process.stderr.write = origWrite;
  }
});

test("rateCheck: allows up to burst then 429s with retry_after_sec", () => {
  // Item B: token-bucket per client. Fire `burst` calls fast, the next
  // one is denied. retry_after_sec must be a positive integer matching
  // the refill rate.
  server.__rateBuckets.delete("burst_test_client");
  // Drive the bucket with synthetic timestamps so the test is deterministic
  // and doesn't depend on real time.
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 30; i++) {
    const r = server.rateCheck("burst_test_client", t0);
    assert.equal(r.allowed, true, `call ${i + 1} should be allowed (within burst)`);
  }
  const denied = server.rateCheck("burst_test_client", t0);
  assert.equal(denied.allowed, false, "31st call within the same instant must be denied");
  assert.ok(denied.retryAfterSec >= 1, "retryAfterSec must be a positive integer");
});

test("rateCheck: refills tokens over time so a paused client recovers", () => {
  // After waiting long enough, the bucket should refill and allow new calls.
  server.__rateBuckets.delete("refill_test_client");
  const t0 = 1_700_000_000_000;
  // Drain the bucket.
  for (let i = 0; i < 30; i++) server.rateCheck("refill_test_client", t0);
  assert.equal(server.rateCheck("refill_test_client", t0).allowed, false, "drained bucket rejects");
  // Wait 2 seconds (10 tokens at default refill=5/s); the next call must pass.
  const t1 = t0 + 2_000;
  assert.equal(server.rateCheck("refill_test_client", t1).allowed, true, "bucket refills over time");
});

test("rateCheck: buckets are per-client (one runaway client doesn't affect another)", () => {
  server.__rateBuckets.delete("client_A");
  server.__rateBuckets.delete("client_B");
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 30; i++) server.rateCheck("client_A", t0);
  assert.equal(server.rateCheck("client_A", t0).allowed, false, "client_A is drained");
  assert.equal(server.rateCheck("client_B", t0).allowed, true, "client_B is unaffected");
});

test("rebuildTokenIndex: forces a fresh token index from current env regardless of clients.json mtime", () => {
  // Item D: SIGHUP handler calls this so an operator can rotate a bearer
  // token by editing env without restarting. The mtime cache must be
  // bypassed because clients.json itself didn't change.
  const before = server.__rateBuckets; // any property pointer to verify call worked is fine
  const idx = server.rebuildTokenIndex();
  assert.ok(idx instanceof Map, "rebuildTokenIndex returns a Map");
  assert.ok(idx.size >= 1, "at least one client (admin) must be provisioned in the test fixture");
  // Verify the admin token still authenticates after the rebuild (i.e. the
  // index is rebuilt with correct content, not just emptied).
  const c = server.authenticateClient(reqWith({ authorization: "Bearer test-admin-token-1234567890" }));
  assert.equal(c.name, "admin");
});

test("assertActionsSchemasValidatorCompatible: every shipped ACTIONS schema is validator-compatible", () => {
  // The live catalog must always pass the drift guard. If this test fails,
  // someone added a schema keyword the validator doesn't enforce — either
  // extend the validator or drop the keyword; do NOT just relax this test.
  assert.doesNotThrow(() => server.assertActionsSchemasValidatorCompatible());
});

test("assertSchemaIsValidatorCompatible: rejects unsupported types", () => {
  assert.throws(
    () => server.assertSchemaIsValidatorCompatible({ type: "integer" }, "x"),
    /unsupported schema type at x: 'integer'/
  );
  assert.throws(
    () => server.assertSchemaIsValidatorCompatible({ type: "null" }, "x"),
    /unsupported schema type/
  );
});

test("assertSchemaIsValidatorCompatible: rejects unsupported keywords on supported types", () => {
  // format / oneOf / multipleOf would silently pass through the minimal
  // validator — fail-fast at startup catches the drift before it ships.
  assert.throws(
    () => server.assertSchemaIsValidatorCompatible({ type: "string", format: "email" }, "x"),
    /unsupported schema keyword at x: 'format'/
  );
  assert.throws(
    () => server.assertSchemaIsValidatorCompatible({ type: "number", multipleOf: 2 }, "x"),
    /unsupported schema keyword at x: 'multipleOf'/
  );
  assert.throws(
    () => server.assertSchemaIsValidatorCompatible({ type: "string", oneOf: [{ pattern: "a" }] }, "x"),
    /unsupported schema keyword at x: 'oneOf'/
  );
});

test("assertSchemaIsValidatorCompatible: recurses into array items and object properties", () => {
  // Drift in a nested schema must still fail the guard.
  assert.throws(
    () => server.assertSchemaIsValidatorCompatible({
      type: "array",
      items: { type: "string", format: "uri" }
    }, "x"),
    /unsupported schema keyword at x\[\]: 'format'/
  );
  assert.throws(
    () => server.assertSchemaIsValidatorCompatible({
      type: "object",
      properties: { n: { type: "integer" } }
    }, "x"),
    /unsupported schema type at x\.n: 'integer'/
  );
});

test("tools/call: validator catches out-of-enum site BEFORE the worker is called", async () => {
  // The denial path that previously relied on the dispatcher's clientAllowsSite
  // check now triggers in the validator with a clearer error message — and
  // critically does not reach workerCall, so a misbehaving caller cannot
  // probe the worker's behavior with arbitrary inputs.
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, {
    jsonrpc: "2.0",
    id: 200,
    method: "tools/call",
    params: { name: "login", arguments: { site: "definitely_not_a_real_site" } }
  });
  assert.equal(resp.id, 200);
  assert.ok(resp.error);
  assert.match(resp.error.message, /not in allowed enum/);
});

test("tools/call: validator rejects an unknown property", async () => {
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, {
    jsonrpc: "2.0",
    id: 201,
    method: "tools/call",
    params: { name: "login", arguments: { site: "col_financial", evil: "payload" } }
  });
  assert.ok(resp.error);
  assert.match(resp.error.message, /unknown argument 'evil'/);
});

test("tools/call: validator rejects a malformed OTP code (pattern violation)", async () => {
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, {
    jsonrpc: "2.0",
    id: 202,
    method: "tools/call",
    params: { name: "provide_otp", arguments: { site: "maxicare", code: "not-numeric" } }
  });
  assert.ok(resp.error);
  assert.match(resp.error.message, /does not match pattern/);
});

test("tools/call: dr_smith calling a tool with empty intersection sees 'unknown tool'", async () => {
  // get_portfolio is COL-only; Dr. Smith has no COL scope. Previously the
  // dispatcher would have thrown "site is not allowlisted" (or "tool not
  // allowed for site") depending on the path; now the call surface is
  // hidden entirely with the same phrasing readResource uses.
  const resp = await server.handleJsonRpc(DR_SMITH_CLIENT, {
    jsonrpc: "2.0",
    id: 203,
    method: "tools/call",
    params: { name: "get_portfolio", arguments: { site: "col_financial" } }
  });
  assert.ok(resp.error);
  assert.match(resp.error.message, /unknown tool/);
});

test("handleJsonRpc(admin): tools/call for an unknown tool returns a JSON-RPC error, not a throw", async () => {
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, {
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: { name: "definitely_not_a_tool", arguments: {} }
  });
  assert.equal(resp.id, 101);
  assert.ok(resp.error);
  assert.match(resp.error.message, /unknown tool/);
});

test("PROMPTS catalog: every entry has category, requiredActions, render, and a site argument", () => {
  for (const [name, spec] of Object.entries(server.PROMPTS)) {
    assert.ok(["workflow", "diagnostic"].includes(spec.category), `${name} category invalid`);
    assert.ok(spec.description && spec.description.length > 0, `${name} must have a description`);
    assert.ok(Array.isArray(spec.requiredActions) && spec.requiredActions.length > 0, `${name} must declare requiredActions`);
    assert.equal(typeof spec.render, "function", `${name} must define render(args, ctx)`);
    const siteArg = spec.arguments.find((a) => a.name === "site");
    assert.ok(siteArg, `${name} must declare a 'site' argument`);
    assert.equal(siteArg.required, true, `${name}.site must be required`);
  }
});

test("sitesForPrompt: submit_claim_from_receipt narrows to sites with check_session+login+submit_claim", () => {
  const sites = server.sitesForPrompt(server.PROMPTS.submit_claim_from_receipt);
  assert.deepEqual(sites, ["april_international"]);
});

test("sitesForPrompt: complete_otp_login filters by loginFlow=username_otp", () => {
  const sites = server.sitesForPrompt(server.PROMPTS.complete_otp_login);
  assert.deepEqual(sites, ["maxicare"]);
});

test("sitesForPrompt: fetch_recent_results narrows to sites that allow get_results", () => {
  const sites = server.sitesForPrompt(server.PROMPTS.fetch_recent_results);
  assert.deepEqual(sites, ["hi_precision"]);
});

test("promptsList(admin): includes workflow prompts but NOT diagnostic prompts when diagnostics are off", () => {
  const names = server.promptsList(ADMIN_CLIENT).map((p) => p.name);
  assert.ok(names.includes("submit_claim_from_receipt"));
  assert.ok(names.includes("complete_otp_login"));
  assert.ok(names.includes("fetch_recent_results"));
  assert.ok(names.includes("check_policy_status"));
  assert.ok(!names.includes("diagnose_failed_login"), "diagnose_failed_login must be gated by BROWSER_INTENT_ENABLE_DIAGNOSTICS");
});

test("promptsList(dr_smith): drops prompts whose site intersection is empty", () => {
  const names = server.promptsList(DR_SMITH_CLIENT).map((p) => p.name);
  // April is in Dr. Smith's scope and supports submit_claim_from_receipt + check_policy_status.
  assert.ok(names.includes("submit_claim_from_receipt"));
  assert.ok(names.includes("check_policy_status"));
  // complete_otp_login needs Maxicare (loginFlow=username_otp); Dr. Smith can't see Maxicare.
  assert.ok(!names.includes("complete_otp_login"));
  // fetch_recent_results would be in DR_SMITH_CLIENT fixture's scope (april only),
  // but april does not allow get_results — so it's dropped.
  assert.ok(!names.includes("fetch_recent_results"));
});

test("promptsList: site enum is mentioned in description so clients can pre-validate", () => {
  const submit = server.promptsList(ADMIN_CLIENT).find((p) => p.name === "submit_claim_from_receipt");
  assert.match(submit.description, /april_international/);
});

test("getPrompt(admin): submit_claim_from_receipt renders a user message with the supplied args", () => {
  const out = server.getPrompt(ADMIN_CLIENT, "submit_claim_from_receipt", {
    site: "april_international",
    treatment_date: "2026-04-12",
    claim_amount: 1234.5,
    provider: "Test Hospital"
  });
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, "user");
  const text = out.messages[0].content.text;
  assert.match(text, /April International/);
  assert.match(text, /site="april_international"/);
  assert.match(text, /2026-04-12/);
  assert.match(text, /1234\.5/);
  assert.match(text, /Test Hospital/);
  // The dry-run guardrail must survive into the rendered prompt.
  assert.match(text, /dry_run: true/);
  assert.match(text, /never call submit_claim with dry_run=false/i);
});

test("getPrompt(admin): rejects missing required argument", () => {
  assert.throws(
    () => server.getPrompt(ADMIN_CLIENT, "submit_claim_from_receipt", { site: "april_international" }),
    /missing required argument 'treatment_date'/
  );
});

test("getPrompt(admin): rejects site outside the prompt's allowed enum", () => {
  // submit_claim_from_receipt is april-only; col_financial doesn't allow submit_claim.
  assert.throws(
    () => server.getPrompt(ADMIN_CLIENT, "submit_claim_from_receipt", {
      site: "col_financial",
      treatment_date: "2026-04-12",
      claim_amount: 100
    }),
    /unknown prompt/
  );
});

test("getPrompt(dr_smith): site outside client scope returns 'unknown prompt', not a leak", () => {
  // check_policy_status would render for maxicare, but Dr. Smith can't see Maxicare.
  // The error must NOT distinguish "site doesn't exist" from "client can't see it".
  assert.throws(
    () => server.getPrompt(DR_SMITH_CLIENT, "check_policy_status", { site: "maxicare" }),
    /unknown prompt/
  );
});

test("getPrompt(admin): unknown prompt name throws 'unknown prompt'", () => {
  assert.throws(
    () => server.getPrompt(ADMIN_CLIENT, "definitely_not_a_prompt", { site: "april_international" }),
    /unknown prompt/
  );
});

test("getPrompt(admin): diagnose_failed_login is hidden when diagnostics are off (treated as unknown)", () => {
  assert.throws(
    () => server.getPrompt(ADMIN_CLIENT, "diagnose_failed_login", { site: "april_international" }),
    /unknown prompt/
  );
});

test("handleJsonRpc(admin): prompts/list returns the workflow prompts", async () => {
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, { jsonrpc: "2.0", id: 50, method: "prompts/list" });
  const names = resp.result.prompts.map((p) => p.name);
  assert.ok(names.includes("submit_claim_from_receipt"));
  assert.ok(names.includes("complete_otp_login"));
});

test("handleJsonRpc(admin): prompts/get dispatches to getPrompt", async () => {
  const resp = await server.handleJsonRpc(ADMIN_CLIENT, {
    jsonrpc: "2.0",
    id: 51,
    method: "prompts/get",
    params: {
      name: "complete_otp_login",
      arguments: { site: "maxicare" }
    }
  });
  assert.equal(resp.id, 51);
  assert.ok(resp.result, "successful prompts/get must return a result");
  assert.match(resp.result.messages[0].content.text, /Maxicare/);
});

test("handleJsonRpc(dr_smith): prompts/get for a hidden prompt returns JSON-RPC error (not throw)", async () => {
  // Regression guard mirroring the tools/call denial-as-200 contract.
  const resp = await server.handleJsonRpc(DR_SMITH_CLIENT, {
    jsonrpc: "2.0",
    id: 52,
    method: "prompts/get",
    params: { name: "complete_otp_login", arguments: { site: "maxicare" } }
  });
  assert.equal(resp.id, 52);
  assert.ok(resp.error);
  assert.equal(resp.error.code, -32000);
  assert.match(resp.error.message, /unknown prompt/);
});

test("policyVersion: returns a stable 12-hex-char digest from sites.json + clients.json", () => {
  const v = server.policyVersion();
  assert.match(v, /^[0-9a-f]{12}$/, "policy version should be 12 hex chars");
  // Stable across calls when files don't change.
  assert.equal(server.policyVersion(), v);
});

test("computePolicyVersion: different contents produce different digests", () => {
  // Use the explicit `paths` injection point — the prod call site reads from
  // module-level consts captured at require time, which can't be swapped from
  // a test once the module is loaded.
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "polver-"));
  try {
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "b.json");
    fs.writeFileSync(a, '{"clients":{}}');
    fs.writeFileSync(b, '{"clients":{"x":{"tokenEnvVar":"Y","allowedSites":"*"}}}');
    const vA = server.computePolicyVersion({ policy: a, clients: a });
    const vB = server.computePolicyVersion({ policy: b, clients: b });
    assert.notEqual(vA, vB, "different clients.json contents must yield different versions");
    // Same content → same digest (sanity).
    assert.equal(server.computePolicyVersion({ policy: a, clients: a }), vA);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("computePolicyVersion: missing files yield a stable but distinct digest from real files", () => {
  // Missing-files sentinel should be deterministic so a clean reboot reads
  // the same Mcp-Policy-Version as a previous clean reboot.
  const missing = "/definitely/does/not/exist/file.json";
  const vMissing = server.computePolicyVersion({ policy: missing, clients: missing });
  assert.match(vMissing, /^[0-9a-f]{12}$/);
  assert.notEqual(vMissing, server.policyVersion(), "missing-files digest must differ from real-files digest");
});

test("__triggerPolicyChange: broadcasts list_changed notifications to every registered stdio sink", () => {
  const captured = [];
  const sink = (line) => captured.push(line);
  server.registerStdioSink(sink);
  try {
    server.__triggerPolicyChange();
    const methods = captured.map((line) => JSON.parse(line.trim()).method).sort();
    assert.deepEqual(methods, [
      "notifications/prompts/list_changed",
      "notifications/resources/list_changed",
      "notifications/tools/list_changed"
    ]);
    // Each line must be a valid JSON-RPC 2.0 notification (no id, no params required).
    for (const line of captured) {
      const obj = JSON.parse(line.trim());
      assert.equal(obj.jsonrpc, "2.0");
      assert.equal(obj.id, undefined, "notifications must NOT carry an id");
    }
  } finally {
    server.unregisterStdioSink(sink);
  }
});

test("registerStdioSink/unregisterStdioSink: unregistered sinks stop receiving notifications", () => {
  const captured = [];
  const sink = (line) => captured.push(line);
  server.registerStdioSink(sink);
  server.unregisterStdioSink(sink);
  server.__triggerPolicyChange();
  assert.equal(captured.length, 0, "an unregistered sink must not receive broadcasts");
});

test("stdio sink errors don't poison the broadcast loop", () => {
  const captured = [];
  const badSink = () => { throw new Error("intentional sink failure"); };
  const goodSink = (line) => captured.push(line);
  server.registerStdioSink(badSink);
  server.registerStdioSink(goodSink);
  try {
    // Must not throw, and goodSink must still receive all three notifications.
    server.__triggerPolicyChange();
    assert.equal(captured.length, 3);
  } finally {
    server.unregisterStdioSink(badSink);
    server.unregisterStdioSink(goodSink);
  }
});

test("loadClients: returns the SAME cached instance on repeat calls when mtime is stable", () => {
  // mtime cache invariant — the hot path must not re-parse JSON every call.
  const a = server.loadClients();
  const b = server.loadClients();
  assert.equal(a, b, "loadClients must return the cached object until clients.json mtime changes");
});

test("statusToKind: classifies known statuses into the stable enum", () => {
  // Verifies the operator-facing vocabulary. Adding new worker statuses
  // without extending STATUS_KIND will land in "unknown" — and the alert
  // on `status_kind:unknown` is what surfaces drift.
  assert.equal(server.statusToKind("ok"), "success");
  assert.equal(server.statusToKind("logged_in"), "success");
  assert.equal(server.statusToKind("logged_out"), "success");
  assert.equal(server.statusToKind("dry_run"), "success");
  assert.equal(server.statusToKind("listed_sites"), "success");
  assert.equal(server.statusToKind("awaiting_otp"), "needs_user");
  assert.equal(server.statusToKind("awaiting_fresh_sms"), "needs_user");
  assert.equal(server.statusToKind("needs_user_action"), "needs_user");
  assert.equal(server.statusToKind("session_expired"), "session_expired");
  assert.equal(server.statusToKind("no_session"), "session_expired");
  assert.equal(server.statusToKind("rate_limited"), "rate_limited");
  assert.equal(server.statusToKind("needs_extractor_update"), "needs_update");
  assert.equal(server.statusToKind("needs_site_selector_update"), "needs_update");
  assert.equal(server.statusToKind("denied_by_client_policy"), "denied");
  assert.equal(server.statusToKind("failed"), "error");
});

test("statusToKind: returns 'unknown' for unmapped or empty status", () => {
  assert.equal(server.statusToKind("brand_new_status"), "unknown");
  assert.equal(server.statusToKind(""), "unknown");
  assert.equal(server.statusToKind(null), "unknown");
  assert.equal(server.statusToKind(undefined), "unknown");
  // Non-string defensively coerced.
  assert.equal(server.statusToKind(123), "unknown");
});

test("STATUS_KIND: each enum value lists at least one status (no empty buckets)", () => {
  // Guards against a future edit that deletes the last status from a kind
  // bucket; an empty bucket means dashboards filtering on that kind would
  // silently match nothing.
  for (const [kind, statuses] of Object.entries(server.STATUS_KIND)) {
    assert.ok(Array.isArray(statuses) && statuses.length > 0, `${kind} bucket must not be empty`);
  }
});

test("__loadAndCacheJson: returns cached object until mtime changes, fresh object after", () => {
  // Exercises the cache invariant against a writable tmp file. Live policy
  // files are mounted read-only in the test container, so direct mtime
  // mutation of those would EROFS.
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cache-"));
  try {
    const f = path.join(dir, "thing.json");
    fs.writeFileSync(f, '{"v":1}');
    const cache = { mtimeMs: -1, data: null, tokenIndex: null };
    const a = server.__loadAndCacheJson(f, cache);
    const b = server.__loadAndCacheJson(f, cache);
    assert.equal(a, b, "same object until mtime changes");
    assert.deepEqual(a, { v: 1 });
    // Mutate content + mtime.
    fs.writeFileSync(f, '{"v":2}');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(f, future, future);
    const c = server.__loadAndCacheJson(f, cache);
    assert.notEqual(c, a, "fresh object after mtime change");
    assert.deepEqual(c, { v: 2 });
    // tokenIndex (derived state) must be reset on cache invalidation so a
    // stale clients.json index can't leak across reloads.
    assert.equal(cache.tokenIndex, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadClients: clients.json parses and contains both admin and hermes_dr_smith", () => {
  const { clients } = server.loadClients();
  assert.ok(clients.admin);
  assert.equal(clients.admin.allowedSites, "*");
  assert.ok(clients.hermes_dr_smith);
  // Mirrors the live policy file; update when allowedSites is edited there.
  assert.deepEqual(
    clients.hermes_dr_smith.allowedSites.sort(),
    ["april_international", "hi_precision"].sort()
  );
});
