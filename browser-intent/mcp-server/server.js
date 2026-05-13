const fs = require("node:fs");
const http = require("node:http");
const readline = require("node:readline");

const policyPath = process.env.BROWSER_INTENT_POLICY_PATH || "/app/policies/sites.json";
const workerUrl = process.env.BROWSER_WORKER_URL || "http://worker:18902";
const httpPort = Number(process.env.BROWSER_INTENT_HTTP_PORT || 18901);

function loadPolicy() {
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

function siteIds() {
  return Object.keys(loadPolicy().sites);
}

function publicSite(siteId) {
  const site = loadPolicy().sites[siteId];
  if (!site) return null;
  return {
    site: siteId,
    displayName: site.displayName,
    riskLevel: site.riskLevel,
    allowedTools: site.allowedTools
  };
}

function toolSchema(siteId) {
  const site = loadPolicy().sites[siteId];
  return {
    name: `login_${siteId}`,
    description: `Log in to ${site.displayName}. Returns only login status; never returns secrets, cookies, DOM, screenshots, or post-login data.`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  };
}

const EXTRACTION_TOOLS = {
  get_portfolio: {
    description: (site) =>
      `Read holdings from ${site.displayName}: per-symbol quantity, average cost, last price, market value, unrealized P&L, and totals. Returns sanitized JSON; never returns credentials, cookies, or raw HTML. Caller must call login_${site.id} first.`
  },
  diagnose_portfolio: {
    description: (site) =>
      `Diagnostic tool for ${site.displayName}. Dumps frame URLs and table header rows to help locate the portfolio page. Returns no holdings data, no cell values — only structural metadata for tuning the real extractor. Caller must call login_${site.id} first.`
  }
};

function extractionToolSchemas() {
  const policy = loadPolicy();
  const tools = [];
  for (const [siteId, site] of Object.entries(policy.sites)) {
    for (const [action, spec] of Object.entries(EXTRACTION_TOOLS)) {
      if (!site.allowedTools.includes(action)) continue;
      tools.push({
        name: `${siteId}_${action}`,
        description: spec.description({ ...site, id: siteId }),
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      });
    }
  }
  return tools;
}

function parseExtractionToolName(name) {
  for (const siteId of siteIds()) {
    const prefix = `${siteId}_`;
    if (!name.startsWith(prefix)) continue;
    const action = name.slice(prefix.length);
    if (EXTRACTION_TOOLS[action]) return { siteId, action };
  }
  return null;
}

function toolsList() {
  const loginTools = siteIds().map(toolSchema);
  return [
    ...loginTools,
    ...extractionToolSchemas(),
    {
      name: "check_site_session",
      description: "Check whether a site has an active worker-side browser session. Returns only status.",
      inputSchema: {
        type: "object",
        required: ["site"],
        properties: { site: { type: "string", enum: siteIds() } },
        additionalProperties: false
      }
    },
    {
      name: "logout_site",
      description: "Log out of an allowed site and close its worker-side browser session.",
      inputSchema: {
        type: "object",
        required: ["site"],
        properties: { site: { type: "string", enum: siteIds() } },
        additionalProperties: false
      }
    },
    {
      name: "list_browser_intent_sites",
      description: "List configured sites and their risk levels without exposing URLs, secrets, or page data.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  ];
}

async function workerCall(path, body) {
  const res = await fetch(`${workerUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = payload.error || `worker returned HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload;
}

function assertSite(siteId) {
  if (!loadPolicy().sites[siteId]) {
    throw new Error(`site is not allowlisted: ${siteId}`);
  }
}

function audit(event) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "browser-intent-mcp",
    ...event
  })}\n`);
}

async function callTool(name, args = {}) {
  let siteForAudit = args.site;
  if (name.startsWith("login_")) siteForAudit = name.slice("login_".length);
  const extraction = parseExtractionToolName(name);
  if (extraction) siteForAudit = extraction.siteId;

  if (name === "list_browser_intent_sites") {
    const result = { sites: siteIds().map(publicSite) };
    audit({ tool: name, result: "listed_sites", returned_sensitive_data: false });
    return result;
  }

  try {
    let result;
    if (name === "check_site_session") {
      assertSite(args.site);
      result = await workerCall("/session", { site: args.site });
    } else if (name === "logout_site") {
      assertSite(args.site);
      result = await workerCall("/logout", { site: args.site });
    } else if (name.startsWith("login_")) {
      const site = name.slice("login_".length);
      assertSite(site);
      result = await workerCall("/login", { site });
    } else if (extraction) {
      assertSite(extraction.siteId);
      const site = loadPolicy().sites[extraction.siteId];
      if (!site.allowedTools.includes(extraction.action)) {
        throw new Error(`tool not allowed for site ${extraction.siteId}: ${extraction.action}`);
      }
      result = await workerCall("/extract", { site: extraction.siteId, action: extraction.action });
    } else {
      throw new Error(`unknown tool: ${name}`);
    }
    audit({
      tool: name,
      site: siteForAudit,
      result: result.status || "ok",
      returned_sensitive_data: Boolean(result.returned_sensitive_data)
    });
    return result;
  } catch (error) {
    audit({
      tool: name,
      site: siteForAudit,
      result: "failed",
      error: error.message || String(error),
      returned_sensitive_data: false
    });
    throw error;
  }
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, error) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message: error.message || String(error) } };
}

async function handleJsonRpc(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return mcpResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "ironnest-browser-intent", version: "0.1.0" }
    });
  }
  if (method === "notifications/initialized") return null;
  if (method === "tools/list") return mcpResult(id, { tools: toolsList() });
  if (method === "tools/call") {
    const result = await callTool(params.name, params.arguments || {});
    return mcpResult(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: false
    });
  }
  return mcpError(id, new Error(`unsupported method: ${method}`));
}

const httpServer = http.createServer(async (req, res) => {
  try {
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "browser-intent-mcp",
      http: req.method,
      path: req.url
    })}\n`);

    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live" }));
      return;
    }
    if (req.method === "GET" && req.url === "/sites") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sites: siteIds().map(publicSite) }));
      return;
    }
    if (req.method === "POST" && req.url === "/mcp") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const response = await handleJsonRpc(msg);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message || String(error) }));
  }
});

// 0.0.0.0 is required for Docker port mapping to work; external access is
// restricted by the compose publish binding (127.0.0.1:18901 only).
httpServer.listen(httpPort, "0.0.0.0");

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const response = await handleJsonRpc(JSON.parse(line));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(mcpError(null, error))}\n`);
  }
});
