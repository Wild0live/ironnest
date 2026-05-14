const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { chromium } = require("playwright");

const policyPath = process.env.BROWSER_INTENT_POLICY_PATH || "/app/policies/sites.json";
const extractorsDir = process.env.BROWSER_INTENT_EXTRACTORS_DIR || path.join(__dirname, "extractors");
const port = 18902;
const sessions = new Map();

// Per-site mutex. Login/logout/extract on the same site must serialize, or two
// concurrent calls race the sessions Map and leak Chromium instances; on real
// sites the parallel auth attempts also risk account lockouts.
const siteLocks = new Map();
function withSiteLock(siteId, fn) {
  const prev = siteLocks.get(siteId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  siteLocks.set(siteId, next);
  next.catch(() => {}).then(() => {
    if (siteLocks.get(siteId) === next) siteLocks.delete(siteId);
  });
  return next;
}

function loadPolicy() {
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

function getSite(siteId) {
  const site = loadPolicy().sites[siteId];
  if (!site) throw new Error(`site is not allowlisted: ${siteId}`);
  return site;
}

function hostnameAllowed(hostname, allowedDomains) {
  return allowedDomains.some((domain) => {
    if (domain.startsWith("*.")) {
      const root = domain.slice(2);
      return hostname === root || hostname.endsWith(`.${root}`);
    }
    return hostname === domain;
  });
}

function assertAllowedUrl(url, site) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("only https login URLs are allowed");
  if (!hostnameAllowed(parsed.hostname, site.allowedDomains)) {
    throw new Error(`login URL host is not allowlisted: ${parsed.hostname}`);
  }
}

function secret(site, key) {
  const value = process.env[`${site.secretPrefix}_${key}`];
  if (!value) throw new Error(`missing Infisical-rendered secret: ${site.secretPrefix}_${key}`);
  return value;
}

function optionalSecret(site, key) {
  return process.env[`${site.secretPrefix}_${key}`] || "";
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = value.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of cleaned) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) throw new Error("invalid TOTP secret encoding");
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp(secretValue, timeStep = 30, digits = 6, counterOffset = 0) {
  const key = base32Decode(secretValue);
  const counter = Math.floor(Date.now() / 1000 / timeStep) + counterOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, "0");
}

function audit(event) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "browser-intent-worker",
    ...event
  })}\n`);
}

async function firstVisible(page, selectors) {
  for (const sel of selectors || []) {
    // sel can be a plain CSS string or {selector, nth} for indexed fields (e.g. split User ID)
    const css = typeof sel === "string" ? sel : sel.selector;
    const nth = typeof sel === "string" ? 0 : (sel.nth ?? 0);
    const locator = page.locator(css).nth(nth);
    if (await locator.count().catch(() => 0)) {
      if (await locator.isVisible().catch(() => false)) return locator;
    }
  }
  return null;
}

async function textSignals(page, signals) {
  const bodyText = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase();
  return (signals || []).some((signal) => bodyText.includes(signal.toLowerCase()));
}

async function mfaLikely(page) {
  const bodyText = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase();
  const terms = ["otp", "one-time", "one time", "verification code", "authenticator", "2fa", "mfa", "captcha"];
  const hasTextSignal = terms.some((term) => bodyText.includes(term));
  const hasOtpInput = await page.locator("input[name*='otp' i], input[name*='code' i], input[autocomplete='one-time-code']").count().catch(() => 0);
  return hasTextSignal || hasOtpInput > 0;
}

async function tryTotp(page, site) {
  const totpSecret = optionalSecret(site, "TOTP_SECRET");
  if (!totpSecret) return false;
  const totpInput = await firstVisible(page, site.loginSelectors.totp);
  if (!totpInput) return false;
  await totpInput.fill(totp(totpSecret));
  const submit = await firstVisible(page, site.loginSelectors.submit);
  if (submit) {
    await Promise.allSettled([
      page.waitForLoadState("networkidle", { timeout: 15000 }),
      submit.click()
    ]);
  } else {
    await totpInput.press("Enter").catch(() => {});
  }
  await page.waitForTimeout(1500);
  // If TOTP input is still visible, the code may have expired near a 30s window boundary — retry with the previous window
  const retryInput = await firstVisible(page, site.loginSelectors.totp);
  if (retryInput) {
    await retryInput.fill(totp(totpSecret, 30, 6, -1));
    const retrySubmit = await firstVisible(page, site.loginSelectors.submit);
    if (retrySubmit) {
      await Promise.allSettled([
        page.waitForLoadState("networkidle", { timeout: 15000 }),
        retrySubmit.click()
      ]);
    } else {
      await retryInput.press("Enter").catch(() => {});
    }
    await page.waitForTimeout(1500);
  }
  return true;
}

async function confirmLoggedIn(page, site) {
  const currentUrl = page.url();
  if (currentUrl === site.loginUrl) return false;
  // URL pattern match (preferred — reliable for sites like COL Financial that redirect to a known path)
  if (site.loggedInUrlPatterns && site.loggedInUrlPatterns.some((p) => currentUrl.includes(p))) return true;
  // Text signal fallback
  return textSignals(page, site.loggedInSignals);
}

async function _login(siteId) {
  const site = getSite(siteId);
  if (!site.allowedTools.includes("login")) throw new Error("login is not allowed for this site");
  assertAllowedUrl(site.loginUrl, site);

  if (sessions.has(siteId)) {
    const active = await _checkSession(siteId);
    if (active.status === "logged_in" || active.status === "session_exists") return active;
    await _logout(siteId);
  }

  const username = secret(site, "USERNAME");
  const password = secret(site, "PASSWORD");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();

  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (hostnameAllowed(host, site.allowedDomains)) return route.continue();
    return route.abort();
  });

  await page.goto(site.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  const usernameInput = await firstVisible(page, site.loginSelectors.username);
  const usernameInput2 = site.loginSelectors.username2
    ? await firstVisible(page, site.loginSelectors.username2)
    : null;
  const passwordInput = await firstVisible(page, site.loginSelectors.password);
  const submit = await firstVisible(page, site.loginSelectors.submit);

  const missingField = !usernameInput || !passwordInput || !submit
    || (site.loginSelectors.username2 && !usernameInput2);
  if (missingField) {
    await browser.close();
    const result = { site: siteId, status: "needs_site_selector_update", returned_sensitive_data: false };
    audit({ action: "login", site: siteId, secretPath: site.secretPath, result: result.status, returned_sensitive_data: false });
    return result;
  }

  if (usernameInput2) {
    // Split username on first dash for two-part User ID fields (e.g. COL Financial "XXXXX-XX")
    const dashIdx = username.indexOf("-");
    await usernameInput.fill(dashIdx >= 0 ? username.slice(0, dashIdx) : username);
    await usernameInput2.fill(dashIdx >= 0 ? username.slice(dashIdx + 1) : "");
  } else {
    await usernameInput.fill(username);
  }
  await passwordInput.fill(password);
  await Promise.allSettled([
    page.waitForLoadState("networkidle", { timeout: 15000 }),
    submit.click()
  ]);

  await page.waitForTimeout(1500);
  let usedTotp = false;
  let loggedIn = await confirmLoggedIn(page, site);
  if (!loggedIn && await mfaLikely(page)) {
    usedTotp = await tryTotp(page, site);
    if (usedTotp) loggedIn = await confirmLoggedIn(page, site);
  }
  sessions.set(siteId, { browser, context, page, startedAt: new Date().toISOString() });

  if (!loggedIn) {
    const needsMfa = await mfaLikely(page);
    const result = {
      site: siteId,
      status: "needs_user_action",
      reason: needsMfa ? "mfa_required" : "login_not_confirmed_or_mfa_possible",
      returned_sensitive_data: false
    };
    audit({ action: "login", site: siteId, secretPath: site.secretPath, result: result.status, used_totp: usedTotp, returned_sensitive_data: false });
    return result;
  }

  const result = { site: siteId, status: "logged_in", returned_sensitive_data: false };
  audit({ action: "login", site: siteId, secretPath: site.secretPath, result: result.status, used_totp: usedTotp, returned_sensitive_data: false });
  return result;
}

async function _checkSession(siteId) {
  const site = getSite(siteId);
  const session = sessions.get(siteId);
  if (!session) return { site: siteId, status: "logged_out", returned_sensitive_data: false };
  if (session.page.isClosed()) {
    sessions.delete(siteId);
    return { site: siteId, status: "logged_out", returned_sensitive_data: false };
  }
  // Verify the web session is still active — catches server-side timeouts where the page
  // redirects back to the login form without closing the Playwright session.
  const stillActive = await confirmLoggedIn(session.page, site);
  if (!stillActive) {
    await _logout(siteId);
    return { site: siteId, status: "logged_out", returned_sensitive_data: false };
  }
  return { site: siteId, status: "logged_in", returned_sensitive_data: false };
}

async function _logout(siteId) {
  getSite(siteId);
  const session = sessions.get(siteId);
  if (!session) return { site: siteId, status: "logged_out", returned_sensitive_data: false };
  await session.browser.close().catch(() => {});
  sessions.delete(siteId);
  return { site: siteId, status: "logged_out", returned_sensitive_data: false };
}

function actionToMethod(action) {
  return action.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

async function _extract(siteId, action) {
  const site = getSite(siteId);
  if (!action || typeof action !== "string") throw new Error("missing action");
  if (!site.allowedTools.includes(action)) {
    throw new Error(`action is not allowed for site ${siteId}: ${action}`);
  }

  // Diagnostic actions are allowed to run on any page state (including a failed
  // login landing) so a human can inspect what COL actually returned. They MUST
  // return returned_sensitive_data: false.
  const isDiagnostic = action.startsWith("diagnose_");
  if (!isDiagnostic) {
    const sessionStatus = await _checkSession(siteId);
    if (sessionStatus.status !== "logged_in") {
      audit({ action, site: siteId, result: "session_expired", returned_sensitive_data: false });
      return { site: siteId, status: "session_expired", returned_sensitive_data: false };
    }
  } else if (!sessions.has(siteId)) {
    audit({ action, site: siteId, result: "no_session", returned_sensitive_data: false });
    return { site: siteId, status: "no_session", returned_sensitive_data: false };
  }

  const extractorPath = path.join(extractorsDir, `${siteId}.js`);
  if (!fs.existsSync(extractorPath)) {
    throw new Error(`no extractor module for site: ${siteId}`);
  }
  const extractor = require(extractorPath);
  const method = actionToMethod(action);
  if (typeof extractor[method] !== "function") {
    throw new Error(`extractor does not implement ${method}`);
  }

  const session = sessions.get(siteId);
  try {
    const result = await extractor[method](session.page);
    audit({
      action,
      site: siteId,
      result: result.status || "ok",
      returned_sensitive_data: Boolean(result.returned_sensitive_data)
    });
    return result;
  } catch (error) {
    if (error.code === "needs_extractor_update") {
      audit({ action, site: siteId, result: "needs_extractor_update", returned_sensitive_data: false });
      return { site: siteId, status: "needs_extractor_update", returned_sensitive_data: false };
    }
    throw error;
  }
}

// Public entry points serialize per-site so the sessions map is never read and
// then written across an await boundary by two callers at once.
const login = (siteId) => withSiteLock(siteId, () => _login(siteId));
const checkSession = (siteId) => withSiteLock(siteId, () => _checkSession(siteId));
const logout = (siteId) => withSiteLock(siteId, () => _logout(siteId));
const extract = (siteId, action) => withSiteLock(siteId, () => _extract(siteId, action));

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    const body = await readJson(req);
    let payload;
    if (req.url === "/login") payload = await login(body.site);
    else if (req.url === "/session") payload = await checkSession(body.site);
    else if (req.url === "/logout") payload = await logout(body.site);
    else if (req.url === "/extract") payload = await extract(body.site, body.action);
    else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "failed",
      error: error.message || String(error),
      returned_sensitive_data: false
    }));
  }
});

// 0.0.0.0 is required: worker is on an isolated Docker internal network (browser-internal);
// access is limited to the MCP container — never published to the host.
server.listen(port, "0.0.0.0");

process.on("SIGTERM", async () => {
  // Bypass the lock at shutdown — we are tearing down regardless of in-flight calls.
  for (const siteId of sessions.keys()) await _logout(siteId).catch(() => {});
  process.exit(0);
});
