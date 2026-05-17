const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

// Playwright is loaded lazily so tests can require this module in a stock
// node image without pulling in the ~1GB browser bundle. Wrapped in
// playwright-extra with the puppeteer-extra-plugin-stealth bundle so the
// launched Chromium presents a closer-to-real fingerprint: WebGL vendor /
// renderer, canvas/audio noise, screen properties, navigator.deviceMemory /
// hardwareConcurrency / chrome runtime object, permissions.query for
// notifications, MediaDevices, plugin/mimetype arrays, etc. — the standard
// 17-evasion bundle that covers the cheap-to-mid-tier headless-detection
// layer. Does NOT fix TLS JA3 fingerprinting (that requires a real Chrome
// via CDP). Disable per-site by checking site flags if a portal trips on
// the stealth shims, but Maxicare appears to fingerprint past the basic
// stealth-init this module previously did inline, so default-on is right.
let _chromium;
function chromium() {
  if (!_chromium) {
    const { chromium: extraChromium } = require("playwright-extra");
    const stealth = require("puppeteer-extra-plugin-stealth")();
    // The stealth plugin ships with a few evasions that print noisy
    // deprecation warnings (e.g. iframe.contentWindow) against modern
    // Playwright; remove the ones that the worker's existing
    // setExtraHTTPHeaders + addInitScript already cover to avoid double-
    // patching and to silence the warnings. Keep the rest.
    stealth.enabledEvasions.delete("user-agent-override");
    extraChromium.use(stealth);
    _chromium = extraChromium;
  }
  return _chromium;
}

const policyPath = process.env.BROWSER_INTENT_POLICY_PATH || "/app/policies/sites.json";
// Headless toggle. Defaults to true (current behavior). Set
// BROWSER_INTENT_HEADLESS=false in compose to launch Chromium with a real
// display under the Dockerfile-provided xvfb-run wrapper — used as the
// next escalation when stealth-plugin fingerprint evasion isn't enough
// (e.g. portals that detect headless-specific WebGL/canvas/compositor
// signals). Cost: ~50MB more RAM, ~150ms slower launches.
const headlessMode = process.env.BROWSER_INTENT_HEADLESS !== "false";
const extractorsDir = process.env.BROWSER_INTENT_EXTRACTORS_DIR || path.join(__dirname, "extractors");
// Path to the Infisical-sidecar-rendered .env file. Read at call time (with an
// mtime-keyed cache) so rotated credentials are picked up without restarting
// the worker container. See secret()/optionalSecret() and README §Secret Layout.
const secretsFilePath = process.env.BROWSER_INTENT_SECRETS_FILE || "/secrets/.env";
const port = 18902;
const sessions = new Map();
// Pending OTP sessions for sites with `loginFlow: "username_otp"`. Holds the
// open Playwright session between the username step and the OTP intake call
// (provide_otp with site=<id>). Expires after otpTtlMs; reaper sweeps. NEVER
// promoted to `sessions` until provide_otp confirms a logged-in landing.
const pendingOtpSessions = new Map();
// Observed upstream "Resend in M:SS" countdown from the OTP page. When set
// and active, calling login_<site> again will NOT trigger a fresh SMS — the
// upstream form just re-displays the existing OTP form. _login uses this to
// short-circuit a re-login (saving a browser launch AND a rate-limit slot)
// and to push the caller toward provide_otp or a wait. Only consulted when
// the LAST awaiting_otp observed smsLikelyFresh=false; we intentionally let
// a re-login through when the last SMS was fresh, in case the caller has a
// legitimate reason to start over (e.g. lost the SMS).
//
// Lifetime: set in _login's awaiting_otp success path, cleared on successful
// provide_otp / logout / __testReset. Naturally decays when `until` passes.
// Map<siteId, { until: <ms-epoch>, smsLikelyFresh: boolean | null }>
const smsCooldown = new Map();

function getSmsCooldownState(siteId) {
  const entry = smsCooldown.get(siteId);
  if (!entry) return { active: false, waitSeconds: 0, smsLikelyFresh: null, until: null };
  const waitSeconds = Math.max(0, Math.ceil((entry.until - Date.now()) / 1000));
  return {
    active: waitSeconds > 0,
    waitSeconds,
    smsLikelyFresh: entry.smsLikelyFresh,
    until: entry.until
  };
}

// Tunables — set in docker-compose env if defaults aren't right.
const sessionIdleMs = Number(process.env.BROWSER_INTENT_SESSION_IDLE_MINUTES || 15) * 60 * 1000;
const sessionSweepMs = Number(process.env.BROWSER_INTENT_SESSION_SWEEP_SECONDS || 60) * 1000;
const loginMaxPerWindow = Number(process.env.BROWSER_INTENT_LOGIN_MAX_PER_WINDOW || 5);
const loginWindowMs = Number(process.env.BROWSER_INTENT_LOGIN_WINDOW_MINUTES || 15) * 60 * 1000;
// SMS OTP codes typically expire in 3-5 min upstream; match that here so we
// don't tie up Chromium beyond the code's usable lifetime.
const otpTtlMs = Number(process.env.BROWSER_INTENT_OTP_TTL_SECONDS || 300) * 1000;
// Bound the time spent inside a single extractor invocation. workerCall on
// the MCP side has a 60s outer abort, but that only kills the HTTP request —
// the worker's Chromium can still be stuck waiting for a DOM event that
// never fires. With a per-action timeout, a hung extractor surfaces as
// needs_extractor_update (via the error code remap) instead of consuming
// the worker's only Chromium for the full MCP timeout window. 45s default
// leaves enough headroom for real extraction work; tune per deployment.
const extractorTimeoutMs = Number(process.env.BROWSER_INTENT_EXTRACTOR_TIMEOUT_SECONDS || 45) * 1000;

// Race a promise against a per-action timeout. On timeout the returned
// promise rejects with an Error carrying code="extractor_timeout"; the
// caller maps that to a structured status payload so the LLM sees a clean
// rejection rather than a generic upstream error.
function withActionTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`extractor '${label}' exceeded ${ms}ms`);
      e.code = "extractor_timeout";
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

// Per-site sliding-window rate limit on real login attempts. Counts only
// fresh chromium launches — session-reuse short-circuits in _login do not
// burn budget. Goal: prevent a runaway caller from triggering account
// lockouts on the upstream site.
const loginAttempts = new Map();
function loginRateCheck(siteId) {
  const cutoff = Date.now() - loginWindowMs;
  const arr = (loginAttempts.get(siteId) || []).filter((t) => t >= cutoff);
  if (arr.length >= loginMaxPerWindow) {
    const retryAfter = Math.max(1, Math.ceil((arr[0] + loginWindowMs - Date.now()) / 1000));
    loginAttempts.set(siteId, arr);
    return { allowed: false, retryAfter };
  }
  arr.push(Date.now());
  loginAttempts.set(siteId, arr);
  return { allowed: true };
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

// Parse a minimal subset of dotenv: KEY=VALUE per line, # comments, blank
// lines, and optional matched surrounding quotes. The Infisical template
// (agent-config/secrets.tmpl) only emits bare KEY=VALUE lines today, but be
// defensive — a future template edit shouldn't silently break rotation.
function parseDotEnv(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    map.set(key, value);
  }
  return map;
}

// mtime-keyed cache of parsed .env contents. The login path calls this once
// per credential lookup; rate-limited login (5/window) plus chromium launch
// dominates, so a stat + parse per call is negligible. The cache lets repeat
// reads within the same login skip the re-parse, and the mtime check is the
// invariant that makes rotation zero-restart.
const _secretsCache = new Map();
function readRenderedSecrets(filePath = secretsFilePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = _secretsCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.map;
  const map = parseDotEnv(fs.readFileSync(filePath, "utf8"));
  _secretsCache.set(filePath, { mtimeMs: stat.mtimeMs, map });
  return map;
}

// File first, process.env as fallback. process.env still wins when the file is
// missing (unit tests, dev runs outside docker) or when a key was only set in
// the container environment.
function lookupSecret(fullKey) {
  const map = readRenderedSecrets();
  if (map && map.has(fullKey)) return map.get(fullKey);
  return process.env[fullKey];
}

function secret(site, key) {
  const fullKey = `${site.secretPrefix}_${key}`;
  const value = lookupSecret(fullKey);
  if (!value) throw new Error(`missing Infisical-rendered secret: ${fullKey}`);
  return value;
}

function optionalSecret(site, key) {
  return lookupSecret(`${site.secretPrefix}_${key}`) || "";
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  // Strip only whitespace and base32 padding. A typo'd secret containing any
  // other character must throw — silently dropping characters would let a
  // mistyped secret produce a wrong-but-valid TOTP code.
  const cleaned = value.toUpperCase().replace(/[\s=]/g, "");
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

// Normalized status vocabulary — MUST stay in sync with mcp-server/server.js
// `STATUS_KIND`. Keep both copies updated when a new worker status string is
// introduced; dashboards group on status_kind, not on the raw status. An
// unmapped status falls through to "unknown" so an alert on
// `status_kind:unknown` surfaces drift.
const STATUS_KIND = {
  success: ["ok", "logged_in", "logged_out", "dry_run", "listed_sites", "session_exists"],
  needs_user: [
    "awaiting_otp", "awaiting_fresh_sms", "needs_user_action",
    "no_pending_otp", "otp_expired"
  ],
  session_expired: ["session_expired", "no_session"],
  rate_limited: ["rate_limited"],
  needs_update: ["needs_extractor_update", "needs_site_selector_update"],
  denied: ["denied_by_client_policy", "denied_invalid_args", "worker_auth_rejected"],
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

function audit(event) {
  // event_type=audit lets the Wazuh dashboard filter audit events out of the
  // generic stderr stream that Fluent Bit ships under ironnest-containers-*.
  // status_kind classifies the free-text `result` into a stable enum.
  const status_kind = "status_kind" in event ? event.status_kind : statusToKind(event.result);
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "browser-intent-worker",
    event_type: "audit",
    status_kind,
    ...event
  })}\n`);
}

// Sanitize an error message before it leaves the worker. Playwright errors
// frequently embed the URL being navigated and the failing selector; URLs
// often carry session tokens in query strings, and full URLs in stderr land
// in Wazuh via Fluent Bit. Replace any URL with origin+pathname only, then
// truncate so a stray page-HTML dump can't blow up an audit log line.
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
  // Only count VISIBLE OTP-shaped inputs. Sites like Hi-Precision render
  // optional 2FA-setup inputs on the post-login dashboard (e.g. otpPassword,
  // receiveOTP) hidden by default — treating their mere presence as a
  // required MFA gate produced a false positive that masked a successful
  // login. `body.innerText` already excludes display:none content, so the
  // text-signal half doesn't need a parallel guard.
  const hasVisibleOtpInput = await page
    .locator("input[name*='otp' i]:visible, input[name*='code' i]:visible, input[autocomplete='one-time-code']:visible")
    .count()
    .catch(() => 0);
  return hasTextSignal || hasVisibleOtpInput > 0;
}

// Patch outbound headers to match what real Chrome sends. Headless Chromium
// commonly omits `accept-encoding`, all four `sec-fetch-*` headers, and sends
// a single-locale `accept-language` instead of the q-value chain. WAFs key
// on these absences much more cheaply than they key on TLS JA3, so closing
// this gap is the highest-value-per-line fingerprint fix we can make. Sec-
// Fetch values are context-dependent (Site is same-origin / cross-site / none
// based on whether the request is to the document origin and whether a
// referer is set; Mode/Dest/User vary by resourceType + navigation), so we
// compute per-request rather than via static setExtraHTTPHeaders.
function chromeHeaders(req, originHost) {
  const existing = req.headers();
  let isSameOrigin = false;
  try {
    isSameOrigin = new URL(req.url()).host === originHost;
  } catch {
    /* best-effort */
  }
  const hasReferer = !!(existing["referer"] || existing["Referer"]);
  const isNav = typeof req.isNavigationRequest === "function" ? req.isNavigationRequest() : false;
  const rt = req.resourceType();
  const destByType = {
    document: "document",
    image: "image",
    stylesheet: "style",
    script: "script",
    font: "font",
    media: "video",
    websocket: "websocket"
  };
  const dest = destByType[rt] || "empty";
  const fetchSite = isSameOrigin ? "same-origin" : hasReferer ? "cross-site" : "none";
  const fetchMode = isNav ? "navigate" : rt === "websocket" ? "websocket" : "cors";
  const patched = {
    ...existing,
    "accept-encoding": existing["accept-encoding"] || "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-site": fetchSite,
    "sec-fetch-mode": fetchMode,
    "sec-fetch-dest": dest
  };
  if (isNav) {
    patched["sec-fetch-user"] = "?1";
    // Real Chrome sends max-age=0 on user-initiated navigations (Reload-style).
    // Helps blend into "human just clicked submit" pattern.
    if (req.method() === "POST" || rt === "document") {
      patched["cache-control"] = "max-age=0";
    }
  }
  return patched;
}

// Smooth cursor path to an element. Bot detectors score pages on whether the
// cursor ever moved before the first keystroke; click-without-prior-move is a
// strong automation signal. Aim slightly off-center to avoid pixel-perfect
// targeting (real humans miss the centroid). Best-effort: a failed move just
// means we skipped one nice-to-have signal, never break the flow.
async function humanMoveTo(page, locator) {
  try {
    const box = await locator.boundingBox();
    if (!box) return;
    const jitterX = (Math.random() - 0.5) * Math.min(box.width / 3, 16);
    const jitterY = (Math.random() - 0.5) * Math.min(box.height / 3, 6);
    const targetX = box.x + box.width / 2 + jitterX;
    const targetY = box.y + box.height / 2 + jitterY;
    const steps = 10 + Math.floor(Math.random() * 10);
    await page.mouse.move(targetX, targetY, { steps });
  } catch {
    /* best-effort */
  }
}

// Best-effort detection of common anti-bot / challenge scripts on the page.
// Surfaced in snapshotPage so a failed login response tells the maintainer
// what kind of detector is in play (reCAPTCHA-v3 vs Turnstile vs nothing
// visible). Returns only vendor names + script hosts — no tokens, no URLs.
async function detectAntiBot(page) {
  try {
    return await page.evaluate(() => {
      const signals = [];
      if (typeof window.grecaptcha !== "undefined") signals.push("grecaptcha");
      if (typeof window.turnstile !== "undefined") signals.push("turnstile");
      if (typeof window.hcaptcha !== "undefined") signals.push("hcaptcha");
      const RE = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|akamai|perimeterx|datadome|imperva|incapsula/i;
      const matchedScripts = Array.from(document.querySelectorAll("script[src]"))
        .map((s) => s.src)
        .filter((src) => RE.test(src));
      const matchedIframes = Array.from(document.querySelectorAll("iframe[src]"))
        .map((f) => f.src)
        .filter((src) => RE.test(src));
      if (matchedScripts.length) signals.push(`scripts:${matchedScripts.length}`);
      if (matchedIframes.length) signals.push(`iframes:${matchedIframes.length}`);
      const hostsOf = (urls) =>
        Array.from(
          new Set(
            urls
              .map((u) => {
                try {
                  return new URL(u).host;
                } catch {
                  return "";
                }
              })
              .filter(Boolean)
          )
        );
      return {
        signals,
        script_hosts: hostsOf(matchedScripts).slice(0, 5),
        iframe_hosts: hostsOf(matchedIframes).slice(0, 5)
      };
    });
  } catch {
    return { signals: [], script_hosts: [], iframe_hosts: [] };
  }
}

async function tryTotp(page, site) {
  const totpSecret = optionalSecret(site, "TOTP_SECRET");
  if (!totpSecret) return false;
  const totpInput = await firstVisible(page, site.loginSelectors.totp);
  if (!totpInput) return false;

  async function submitCode(input, code) {
    await input.fill(code);
    const submitBtn = await firstVisible(page, site.loginSelectors.submit);
    if (submitBtn) {
      await Promise.allSettled([
        page.waitForLoadState("networkidle", { timeout: 15000 }),
        submitBtn.click()
      ]);
    } else {
      await input.press("Enter").catch(() => {});
    }
    await page.waitForTimeout(1500);
  }

  // Current window first; if the TOTP input is still visible afterward, the
  // code likely landed near a 30s boundary — try both neighbor windows.
  await submitCode(totpInput, totp(totpSecret));
  for (const offset of [-1, 1]) {
    const retryInput = await firstVisible(page, site.loginSelectors.totp);
    if (!retryInput) break;
    await submitCode(retryInput, totp(totpSecret, 30, 6, offset));
  }
  return true;
}

async function confirmLoggedIn(page, site) {
  const currentUrl = page.url();
  // Strip query/hash before comparing to loginUrl so a bounce-back to
  // /login?redirected=true (or /login#err) is recognized as the login page,
  // not "some other URL we should fall through to textSignals on" — which
  // would let "welcome"-style copy on the login page itself produce a
  // false-positive logged_in.
  const stripQH = (u) => u.split(/[?#]/)[0];
  if (stripQH(currentUrl) === stripQH(site.loginUrl)) return false;
  // URL pattern match (preferred — reliable for sites like COL Financial that redirect to a known path)
  if (site.loggedInUrlPatterns && site.loggedInUrlPatterns.some((p) => currentUrl.includes(p))) return true;
  // Text signal fallback
  return textSignals(page, site.loggedInSignals);
}

// Drive the login form for both single-step and multi-step flows.
// Returns null on selector-driven failure (caller emits needs_site_selector_update),
// or undefined when the fill+submit sequence completed (no opinion on whether the
// session is now established — caller verifies via confirmLoggedIn).
async function _fillLoginForm(page, site, username, password) {
  // username_otp: username step → continue → SMS OTP code (delivered to the
  // user's phone, not derivable from the stored secrets). The worker hands
  // back `awaiting_otp` after the continue click; the caller completes the
  // login via the MCP `provide_otp` tool (site=<id>, code=<digits>) once the
  // user reads the SMS.
  if (site.loginFlow === "username_otp") {
    const usernameInput = await firstVisible(page, site.loginSelectors.username);
    if (!usernameInput) return { ok: false, missing: "username" };
    const continueBtn = await firstVisible(page, site.loginSelectors.continue);
    if (!continueBtn) return { ok: false, missing: "continue" };
    await usernameInput.fill(username);
    await Promise.allSettled([
      page.waitForLoadState("networkidle", { timeout: 15000 }),
      continueBtn.click()
    ]);
    // Wait for the OTP page to hydrate; the otpSelectors.inputs entry tells
    // us what to wait for. Best-effort: if hydration never finishes within
    // timeout we still return ok+awaiting; provide_otp will report the
    // failure with a snapshot.
    if (site.otpSelectors && site.otpSelectors.inputs && site.otpSelectors.inputs[0]) {
      await page
        .waitForSelector(site.otpSelectors.inputs[0], { state: "visible", timeout: 15000 })
        .catch(() => {});
    }
    // Read the resend-timer text so the caller can tell whether a fresh SMS
    // was just issued or Maxicare's server is rate-limiting and showing the
    // OTP form against a previous request. A high remaining count (~4:30+)
    // means a fresh SMS just went out; a low count means the SMS already
    // expired or a previous request is still in flight and no new SMS was
    // sent. Without this, the user can't tell which code to enter.
    const resend = await page
      .evaluate(() => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ");
        const m = text.match(/Resend\s*\(\s*in\s*(\d+):(\d+)\s*\)/i);
        if (m) return { seconds: Number(m[1]) * 60 + Number(m[2]), label: m[0] };
        if (/Resend\s+code/i.test(text)) return { seconds: 0, label: "Resend code (clickable)" };
        if (/Resend/i.test(text)) return { seconds: 0, label: "Resend (clickable)" };
        return null;
      })
      .catch(() => null);
    return { ok: true, awaitingOtp: true, resend };
  }

  // Multi-step: username step → continue → password step → submit. Used by
  // SPAs where the password field doesn't render until after the username
  // step. Driven by `loginFlow: "multi_step"` + a `loginSelectors.continue`
  // array in sites.json.
  if (site.loginFlow === "multi_step") {
    const usernameInput = await firstVisible(page, site.loginSelectors.username);
    if (!usernameInput) return { ok: false, missing: "username" };
    const continueBtn = await firstVisible(page, site.loginSelectors.continue);
    if (!continueBtn) return { ok: false, missing: "continue" };
    await usernameInput.fill(username);
    await Promise.allSettled([
      page.waitForLoadState("networkidle", { timeout: 15000 }),
      continueBtn.click()
    ]);
    await page
      .waitForSelector("input[type='password']", { timeout: 15000, state: "visible" })
      .catch(() => {});
    const passwordInput = await firstVisible(page, site.loginSelectors.password);
    if (!passwordInput) return { ok: false, missing: "password_after_continue" };
    const submit = await firstVisible(page, site.loginSelectors.submit);
    if (!submit) return { ok: false, missing: "submit_after_continue" };
    await passwordInput.fill(password);
    await Promise.allSettled([
      page.waitForLoadState("networkidle", { timeout: 15000 }),
      submit.click()
    ]);
    return { ok: true };
  }

  const usernameInput = await firstVisible(page, site.loginSelectors.username);
  if (!usernameInput) return { ok: false, missing: "username" };
  const usernameInput2 = site.loginSelectors.username2
    ? await firstVisible(page, site.loginSelectors.username2)
    : null;
  if (site.loginSelectors.username2 && !usernameInput2) return { ok: false, missing: "username2" };
  const passwordInput = await firstVisible(page, site.loginSelectors.password);
  if (!passwordInput) return { ok: false, missing: "password" };
  const submit = await firstVisible(page, site.loginSelectors.submit);
  if (!submit) return { ok: false, missing: "submit" };

  if (usernameInput2) {
    const dashIdx = username.indexOf("-");
    await usernameInput.fill(dashIdx >= 0 ? username.slice(0, dashIdx) : username);
    await usernameInput2.fill(dashIdx >= 0 ? username.slice(dashIdx + 1) : "");
  } else {
    // Focus + type-with-delay simulates human keystrokes. Some bot detectors
    // (Cloudflare, recaptcha-enterprise) fire per-keystroke validators that
    // never trigger for .fill() (which sets .value directly). Cost: an extra
    // ~300-500ms per login.
    // Pre-interaction dwell + smooth cursor path. Anti-bot scoring penalises
    // pages where the cursor never moves before the first keystroke and
    // where interactions land suspiciously fast after DOMContentLoaded.
    await page.waitForTimeout(800 + Math.floor(Math.random() * 1000));
    await humanMoveTo(page, usernameInput);
    await usernameInput.click().catch(() => {});
    await usernameInput.type(username, { delay: 25 });
  }
  // Tab from username to password — fires a natural blur on username and a
  // focus on password, which some forms key onChange/onSubmit validators
  // off of. Then type the password. Press Enter at the end to submit via
  // the form's native onsubmit handler rather than a click on the button,
  // which is what most real users do and which avoids the "synthetic click"
  // event signature that some bot detectors flag.
  await page.keyboard.press("Tab").catch(() => {});
  await humanMoveTo(page, passwordInput);
  await passwordInput.click().catch(() => {});
  await passwordInput.type(password, { delay: 25 });
  await page.waitForTimeout(400);
  // Park the cursor near the submit button before pressing Enter. Real users
  // tend to hover or move toward the button as they finish typing; some bot
  // scorers reward that cursor-trail.
  await humanMoveTo(page, submit);
  // Per-site hidden-input prefill. Some forms (Hi-Precision's `urlHipre`)
  // expect a JS-set value that bot-style submits leave empty, which the
  // server then silently rejects. Values support the literal token
  // {{location.href}} to mean "the current page URL" — the most common
  // pattern observed (Hi-Precision sets urlHipre = window.location.href).
  if (site.prefillHidden && typeof site.prefillHidden === "object") {
    for (const [name, value] of Object.entries(site.prefillHidden)) {
      const resolved = value === "{{location.href}}" ? page.url() : value;
      await page
        .evaluate(
          ({ name, value }) => {
            const el = document.querySelector(`input[name="${name}"]`);
            if (el) el.value = value;
          },
          { name, value: resolved }
        )
        .catch(() => {});
    }
  }
  await Promise.allSettled([
    page.waitForLoadState("networkidle", { timeout: 15000 }),
    passwordInput.press("Enter")
  ]);
  return { ok: true };
}

// Best-effort snapshot of the current page used when a login attempt
// returns needs_site_selector_update or needs_user_action. Returns
// title, URL (origin+pathname only), body-text first 240 chars, and
// counts of input/button/form — enough for a maintainer to tell whether
// the page is the login form, a server error, an account-lockout screen,
// or a successful-but-unrecognized landing. NEVER returns input values
// or cookies; bodyText is redacted via redactCellText for digit runs.
async function snapshotPage(page) {
  const url = (() => {
    try {
      const u = new URL(page.url());
      return `${u.origin}${u.pathname}`;
    } catch {
      return "";
    }
  })();
  let title = "";
  try {
    title = await page.title();
  } catch {
    /* ignore */
  }
  let body = "";
  try {
    body = await page.locator("body").innerText({ timeout: 3000 });
  } catch {
    /* ignore */
  }
  const evaluated = await page
    .evaluate(() => {
      const truncate = (s, n = 60) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      return {
        counts: {
          input: document.querySelectorAll("input").length,
          button: document.querySelectorAll("button").length,
          form: document.querySelectorAll("form").length
        },
        // Compact metadata for the first ~10 inputs/buttons so a maintainer
        // can author selectors for the *next* step (e.g. an OTP input that
        // appeared after a Continue click) without re-running a diagnostic.
        inputs: Array.from(document.querySelectorAll("input"))
          .slice(0, 12)
          .map((n) => ({
            type: (n.getAttribute("type") || "").toLowerCase(),
            name: n.getAttribute("name") || "",
            id: n.getAttribute("id") || "",
            placeholder: truncate(n.getAttribute("placeholder")),
            maxlength: n.getAttribute("maxlength") || "",
            visible: !!n.offsetParent
          }))
          .filter((i) => i.name || i.id || i.placeholder || i.visible),
        buttons: Array.from(document.querySelectorAll("button, input[type=submit], input[type=button]"))
          .slice(0, 8)
          .map((b) => ({
            tag: b.tagName.toLowerCase(),
            id: b.getAttribute("id") || "",
            text: truncate(b.textContent || b.value),
            visible: !!b.offsetParent
          }))
          .filter((b) => b.text || b.id)
      };
    })
    .catch(() => ({ counts: { input: 0, button: 0, form: 0 }, inputs: [], buttons: [] }));
  const { counts, inputs, buttons } = evaluated;
  // Anti-bot / challenge detection. Surfaces whether the page is running
  // reCAPTCHA, Turnstile, hCaptcha, etc. — failing logins that bounce back
  // silently are usually upstream-scored, and the maintainer needs to know
  // which scorer to engineer around.
  const anti_bot = await detectAntiBot(page);
  // Hidden-input enumeration. When a form POST returns 200-with-form-back
  // (silent reject), one possible cause is a CSRF/session token in a hidden
  // input that we're not preserving from GET to POST. Dump name/id and
  // value-LENGTH (never the value itself) so a maintainer can compare the
  // observed hidden fields to site.prefillHidden and add any missing names.
  // Also pulls common CSRF meta tags. Best-effort.
  const hidden = await page
    .evaluate(() => {
      const hiddenInputs = Array.from(document.querySelectorAll("input[type=hidden]"))
        .map((n) => ({
          name: n.getAttribute("name") || "",
          id: n.getAttribute("id") || "",
          value_len: (n.value || "").length
        }))
        .filter((h) => h.name || h.id);
      const csrfMetas = Array.from(
        document.querySelectorAll(
          "meta[name*='csrf' i], meta[name*='token' i], meta[name='_csrf']"
        )
      ).map((m) => ({
        name: m.getAttribute("name") || "",
        content_len: (m.getAttribute("content") || "").length
      }));
      return { hiddenInputs, csrfMetas };
    })
    .catch(() => ({ hiddenInputs: [], csrfMetas: [] }));
  // Redact digit runs / emails the same way diagnose helpers do —
  // body text on a logged-in landing can include member numbers, etc.
  const redacted = (body || "")
    .replace(/\b[\w._%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[EMAIL]")
    .replace(/\d+(?:[,.]\d+)+/g, "[NUM]")
    .replace(/\d{4,}/g, "[NUM]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return {
    url,
    title,
    body_snippet: redacted,
    counts,
    inputs,
    buttons,
    anti_bot,
    hidden_inputs: hidden.hiddenInputs,
    csrf_metas: hidden.csrfMetas
  };
}

// Registry of {{placeholder}} substituters for site.loginUrl. A single
// regex sweep replaces every recognized token; an unrecognized token throws
// rather than passing through to the upstream URL. That fail-fast property
// matters: if a future sites.json edit typos `{{cod_challenge}}`, the
// literal string would otherwise hit the remote portal as part of a real
// HTTP GET and surface in its logs. Now it crashes the login call with a
// clear error before any network egress happens.
//
// Each substituter is called fresh per replacement and returns the value to
// splice in. Add new tokens by extending this object.
//
// Current tokens:
//   {{code_challenge}} — PKCE S256 challenge for OAuth 2.0 + PKCE entry
//   points (April International). The associated code_verifier is generated
//   here and discarded; we don't follow the redirect back to the
//   redirect_uri ourselves, so the verifier is never needed for a token
//   exchange. If a site adds token-exchange in the future, store the
//   verifier alongside the pending session.
const URL_PLACEHOLDERS = {
  code_challenge() {
    const verifier = crypto.randomBytes(32).toString("base64url");
    return crypto.createHash("sha256").update(verifier).digest("base64url");
  }
};
const URL_PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

function resolveLoginUrl(rawUrl) {
  return rawUrl.replace(URL_PLACEHOLDER_RE, (_, key) => {
    const fn = URL_PLACEHOLDERS[key];
    if (!fn) {
      // Throwing here surfaces a misconfigured sites.json at the first
      // login attempt rather than leaking the literal token into an
      // upstream URL. Listed keys give the operator a copy-paste-ready
      // hint at the cause.
      const known = Object.keys(URL_PLACEHOLDERS).map((k) => `{{${k}}}`).join(", ") || "(none)";
      throw new Error(`unknown loginUrl placeholder '{{${key}}}' — supported: ${known}`);
    }
    return fn();
  });
}

async function _login(siteId) {
  const site = getSite(siteId);
  if (!site.allowedTools.includes("login")) throw new Error("login is not allowed for this site");
  // assertAllowedUrl checks the host; template tokens don't affect the host,
  // so it's safe to assert against the raw template URL.
  assertAllowedUrl(site.loginUrl, site);
  const resolvedLoginUrl = resolveLoginUrl(site.loginUrl);

  if (sessions.has(siteId)) {
    const active = await _checkSession(siteId);
    if (active.status === "logged_in" || active.status === "session_exists") return active;
    await _logout(siteId);
  }

  // Short-circuit when the last awaiting_otp observed sms_likely_fresh=false
  // and the upstream resend cooldown is still ticking. A re-login here would
  // burn a rate-limit slot and a Chromium launch only to re-display the same
  // stale OTP form — no fresh SMS comes out of upstream until the cooldown
  // elapses. Push the caller toward provide_otp (if a pending session is
  // still alive) or an explicit wait. Ordered BEFORE loginRateCheck so a
  // short-circuit doesn't consume budget either.
  if (site.loginFlow === "username_otp") {
    const cooldown = getSmsCooldownState(siteId);
    if (cooldown.active && cooldown.smsLikelyFresh === false) {
      const pending = pendingOtpSessions.get(siteId);
      const result = {
        site: siteId,
        status: "awaiting_fresh_sms",
        reason: "upstream_sms_resend_cooldown",
        wait_seconds_for_fresh_sms: cooldown.waitSeconds,
        pending_session_active: Boolean(pending),
        next_action: pending
          ? {
              type: "submit_otp_code",
              tool: "provide_otp",
              site: siteId,
              note: "OTP session is still open; submit the code from the LAST SMS you received."
            }
          : {
              type: "wait_then_relogin",
              wait_seconds: cooldown.waitSeconds,
              tool: "login",
              site: siteId,
              note: "Wait the full cooldown before retrying so upstream issues a fresh SMS."
            },
        hint: pending
          ? `An OTP session is already pending and upstream's resend cooldown has ${cooldown.waitSeconds}s remaining. Calling login (site=${siteId}) again will NOT trigger a fresh SMS — it will just re-display the existing OTP form. Submit the code from your LAST SMS via provide_otp (site=${siteId}). If that code is wrong, wait ${cooldown.waitSeconds}s before calling login (site=${siteId}) again.`
          : `Upstream's resend cooldown has ${cooldown.waitSeconds}s remaining and no pending OTP session exists. Wait ${cooldown.waitSeconds}s before calling login (site=${siteId}) again so a fresh SMS will be issued.`,
        returned_sensitive_data: false
      };
      audit({
        action: "login",
        site: siteId,
        secretPath: site.secretPath,
        result: result.status,
        wait_seconds: cooldown.waitSeconds,
        pending_session_active: Boolean(pending),
        returned_sensitive_data: false
      });
      return result;
    }
  }

  const rate = loginRateCheck(siteId);
  if (!rate.allowed) {
    const result = {
      site: siteId,
      status: "rate_limited",
      retry_after_seconds: rate.retryAfter,
      returned_sensitive_data: false
    };
    audit({
      action: "login",
      site: siteId,
      secretPath: site.secretPath,
      result: result.status,
      retry_after_seconds: rate.retryAfter,
      returned_sensitive_data: false
    });
    return result;
  }

  const username = secret(site, "USERNAME");
  const password = secret(site, "PASSWORD");
  const browser = await chromium().launch({ headless: headlessMode, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  // Realistic UA + viewport to defeat the cheapest WAF rules (Cloudflare's
  // default rule drops "HeadlessChrome" on sight — hi-precision returns 403
  // without this). Locale/timezone match the worker's host region. Applied to
  // every site; the only downside is a less truthful fingerprint, which the
  // alternative (being silently blocked) doesn't actually improve.
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "Asia/Manila"
  });
  // Override the User-Agent Client Hint headers (Sec-Ch-Ua*) so they match
  // the Chrome 131 we claim in User-Agent. Playwright's default Sec-Ch-Ua
  // reflects the bundled Chromium version (~Playwright-tagged release),
  // which mismatches a custom UA and is one of the cheapest signals
  // Cloudflare bot-fight uses to flag automation. The browser sends these
  // headers on every navigation and on form POSTs.
  await context.setExtraHTTPHeaders({
    "Sec-Ch-Ua":
      '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"'
  });
  // Stealth fingerprint mocks are provided by puppeteer-extra-plugin-stealth
  // wired into the chromium() loader at module scope. Stealth covers:
  // navigator.webdriver/plugins/languages/hardwareConcurrency/permissions,
  // chrome.{app,csi,loadTimes,runtime}, webgl.vendor, media.codecs,
  // iframe.contentWindow, window.outerdimensions, sourceurl, defaultArgs,
  // user-agent-override (disabled because we set a custom UA below). An
  // earlier version of this file added inline addInitScript patches for
  // webdriver/plugins/languages/permissions; those have been removed because
  // they run AFTER stealth's context-level evasions and would overwrite
  // stealth's higher-quality mocks (e.g. a real PluginArray shape) with
  // crude shims (e.g. a plain Array of integers), worsening the fingerprint.
  const page = await context.newPage();

  // Network capture. When a login bounces silently back to the form, the
  // request/response chain is the only place to see what actually happened
  // — e.g. did the form POST return 200-with-same-form (WAF silent reject),
  // 302-to-/login (server-side session lost), or 403 (IP blocked). Filtered
  // to document + xhr + fetch so we skip static-asset noise; capped at 50.
  // Digit runs in paths are redacted to avoid leaking IDs.
  const networkLog = [];
  // Capture the headers of the FIRST top-level POST request — for login flows
  // that's the form submit. Captured INSIDE the route handler (below) so the
  // values reflect what we actually send on the wire after chromeHeaders()
  // patches them. Earlier we captured via page.on("request") which fires
  // BEFORE the route handler — that gave misleading pre-patch values and
  // hid whether the header normalization actually took effect. Cookie /
  // Authorization / X-CSRF-Token are length-redacted via sanitizeHeaders.
  let submitHeaders = null;
  const sanitizeHeaders = (h) => {
    const out = {};
    for (const [k, v] of Object.entries(h)) {
      const key = k.toLowerCase();
      out[k] = key === "cookie" || key === "authorization" || key === "x-csrf-token"
        ? `[len:${(v || "").length}]`
        : v;
    }
    return out;
  };
  page.on("response", (response) => {
    try {
      const req = response.request();
      const type = req.resourceType();
      if (!["document", "fetch", "xhr"].includes(type)) return;
      const u = new URL(response.url());
      networkLog.push({
        method: req.method(),
        host: u.host,
        path: u.pathname.replace(/\d{4,}/g, "[NUM]"),
        status: response.status(),
        type
      });
      if (networkLog.length > 50) networkLog.splice(0, networkLog.length - 50);
    } catch {
      /* best-effort */
    }
  });
  page.on("requestfailed", (req) => {
    try {
      const type = req.resourceType();
      if (!["document", "fetch", "xhr"].includes(type)) return;
      const u = new URL(req.url());
      networkLog.push({
        method: req.method(),
        host: u.host,
        path: u.pathname.replace(/\d{4,}/g, "[NUM]"),
        status: 0,
        type,
        failure: (req.failure() && req.failure().errorText) || "failed"
      });
      if (networkLog.length > 50) networkLog.splice(0, networkLog.length - 50);
    } catch {
      /* best-effort */
    }
  });

  // Subresource gate: by default, block off-allowlist requests so a page's JS
  // can't fetch from arbitrary origins while credentials are in memory. SPAs
  // (Maxicare) commonly ship vendor bundles from off-allowlist CDNs and need
  // this relaxed to hydrate at all. Opt out per-site via
  // `enforceSubresourceAllowlist: false`. Top-level navigation stays pinned
  // to site.loginUrl by assertAllowedUrl above; the network-layer egress
  // proxy (squid) remains the primary control on outbound traffic.
  // The route handler ALSO injects Chrome-shaped headers (accept-encoding,
  // sec-fetch-*, accept-language q-chain) on every request — see chromeHeaders
  // for the rationale. This runs unconditionally because the headers help
  // every site, not just allowlist-enforcing ones.
  const ORIGIN_HOST = new URL(resolvedLoginUrl).host;
  await page.route("**/*", (route) => {
    const req = route.request();
    if (site.enforceSubresourceAllowlist !== false) {
      const host = new URL(req.url()).hostname;
      if (!hostnameAllowed(host, site.allowedDomains)) return route.abort();
    }
    const patched = chromeHeaders(req, ORIGIN_HOST);
    // Stash the first top-level POST's patched headers so the failure
    // response shows what we actually send (post-chromeHeaders), not the
    // pre-route browser-intended headers.
    if (
      !submitHeaders &&
      req.method() === "POST" &&
      ["document", "fetch", "xhr"].includes(req.resourceType())
    ) {
      submitHeaders = sanitizeHeaders(patched);
    }
    return route.continue({ headers: patched });
  });

  await page.goto(resolvedLoginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Hydration waits — firstVisible() doesn't retry on its own, so SPAs that
  // render the form a few seconds after DOMContentLoaded would otherwise
  // return needs_site_selector_update spuriously. Both waits are best-effort:
  // sites with already-rendered server HTML proceed immediately.
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForSelector("input", { state: "visible", timeout: 10000 }).catch(() => {});

  const filled = await _fillLoginForm(page, site, username, password);
  if (filled.ok && filled.awaitingOtp) {
    // Stash the open Playwright session so the caller can complete login
    // via `_provideOtp` once the user reads the SMS. We do NOT add to the
    // `sessions` map until the OTP is verified — the worker's "session
    // exists" semantics mean "logged in," which we aren't yet.
    const now = Date.now();
    pendingOtpSessions.set(siteId, {
      browser,
      context,
      page,
      createdAt: now,
      expiresAt: now + otpTtlMs
    });
    const expires_in_seconds = Math.floor(otpTtlMs / 1000);
    // Interpret the resend timer. Maxicare's resend countdown maxes at 3:00
    // (180s), not 5:00 — observed empirically 2026-05-16. >= 175s means the
    // SMS was just issued (within the last ~5s) — code in hand is fresh.
    // < 175s means we're inside an older OTP request's window — no new SMS
    // was sent, and any code the user submits must be the previous one (or
    // wait `resend.seconds` for the window to clear so the next login_<site>
    // can request a fresh SMS). Threshold previously 270s, which was above
    // the observed 180s ceiling and made smsLikelyFresh effectively never
    // true — now lowered so the signal is actually meaningful.
    const resend = filled.resend || null;
    const FRESH_SMS_THRESHOLD_SECONDS = 175;
    const smsLikelyFresh = resend ? resend.seconds >= FRESH_SMS_THRESHOLD_SECONDS : null;
    // Persist the observed cooldown so a subsequent login_<site> can
    // short-circuit before launching a browser. We record smsLikelyFresh
    // so the short-circuit only fires when the previous SMS was stale —
    // a re-login on a freshly-issued SMS is wasteful but maybe legitimate.
    if (resend && resend.seconds > 0) {
      smsCooldown.set(siteId, {
        until: Date.now() + resend.seconds * 1000,
        smsLikelyFresh
      });
    } else {
      smsCooldown.delete(siteId);
    }
    audit({
      action: "login",
      site: siteId,
      secretPath: site.secretPath,
      result: "awaiting_otp",
      expires_in_seconds,
      sms_resend_in_seconds: resend ? resend.seconds : null,
      sms_resend_label: resend ? resend.label : null,
      sms_likely_fresh: smsLikelyFresh,
      returned_sensitive_data: false
    });
    return {
      site: siteId,
      status: "awaiting_otp",
      reason: "sms_otp_required",
      expires_in_seconds,
      sms_resend_in_seconds: resend ? resend.seconds : null,
      sms_likely_fresh: smsLikelyFresh,
      next_action: {
        type: "submit_otp_code",
        tool: "provide_otp",
        site: siteId
      },
      hint: smsLikelyFresh === false
        ? `Upstream did NOT issue a fresh SMS — the Resend countdown shows ${resend.seconds}s remaining. Submit the code from your LAST SMS via provide_otp (site=${siteId}). Do NOT call login (site=${siteId}) again before the cooldown elapses — it will just re-display the same stale OTP form and burn a rate-limit slot.`
        : smsLikelyFresh === true
          ? `A fresh SMS was just issued — submit that code via provide_otp (site=${siteId}). If it's wrong, wait ${resend ? resend.seconds : 270}s for the cooldown before calling login (site=${siteId}) again.`
          : null,
      returned_sensitive_data: false
    };
  }
  if (!filled.ok) {
    // Snapshot before close so a maintainer can tell *why* the selector
    // failed (e.g. wrong mobile format → toast error → password step never
    // rendered). Returns redacted structural data only.
    const snapshot = await snapshotPage(page).catch(() => null);
    await browser.close();
    const result = {
      site: siteId,
      status: "needs_site_selector_update",
      missing_selector: filled.missing,
      snapshot,
      network_log: networkLog.slice(-30),
      submit_headers: submitHeaders,
      returned_sensitive_data: false
    };
    audit({
      action: "login",
      site: siteId,
      secretPath: site.secretPath,
      result: result.status,
      missing_selector: filled.missing,
      returned_sensitive_data: false
    });
    return result;
  }

  await page.waitForTimeout(1500);
  // OAuth-callback wait. Sites that use OAuth (April: am-gateway.april.fr
  // form → /auth/callback on the member-portal host) land on a transient
  // callback URL while the SPA exchanges the code for tokens. Without
  // explicit patience here we'd snapshot the empty callback page and
  // _checkSession would auto-logout. Bail if we never leave the callback
  // (treated as needs_user_action below).
  if (page.url().includes("callback")) {
    await page
      .waitForFunction(() => !window.location.href.includes("callback"), null, { timeout: 20000 })
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  // Post-submit settle. If we're still on the login URL after the initial
  // 1500ms, the site may be running a slower JS-driven redirect chain
  // (Hi-Precision: XHR validate → form POST → 302 → cross-domain dashboard).
  // Wait for the URL to leave loginUrl OR for any loggedInUrlPattern to
  // appear, then let the network settle. Best-effort: if neither happens
  // confirmLoggedIn will still run and we'll fall through to needs_user_action.
  if (page.url().split(/[?#]/)[0] === site.loginUrl.split(/[?#]/)[0]) {
    const loginUrlPath = (() => {
      try { return new URL(site.loginUrl).pathname; } catch { return ""; }
    })();
    const patterns = site.loggedInUrlPatterns || [];
    await page
      .waitForFunction(
        ({ loginPath, patterns }) => {
          const href = window.location.href;
          if (loginPath && !href.includes(loginPath)) return true;
          return patterns.some((p) => href.includes(p));
        },
        { loginPath: loginUrlPath, patterns },
        { timeout: 15000 }
      )
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  }
  let usedTotp = false;
  let loggedIn = await confirmLoggedIn(page, site);
  if (!loggedIn && await mfaLikely(page)) {
    usedTotp = await tryTotp(page, site);
    if (usedTotp) loggedIn = await confirmLoggedIn(page, site);
  }
  sessions.set(siteId, { browser, context, page, startedAt: new Date().toISOString(), lastActivity: Date.now() });

  if (!loggedIn) {
    const needsMfa = await mfaLikely(page);
    const snapshot = await snapshotPage(page).catch(() => null);
    const result = {
      site: siteId,
      status: "needs_user_action",
      reason: needsMfa ? "mfa_required" : "login_not_confirmed_or_mfa_possible",
      snapshot,
      network_log: networkLog.slice(-30),
      submit_headers: submitHeaders,
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
  //
  // SPAs (Maxicare especially) can be mid-route-transition when this runs from
  // a back-to-back MCP call right after login. confirmLoggedIn samples the
  // URL synchronously and would briefly observe a stale loginUrl or an empty
  // intermediate state, return false, and trigger _logout — destroying a
  // perfectly good authenticated session and forcing a fresh SMS round-trip.
  // Wait briefly for the URL to stabilize on a known logged-in pattern (or
  // simply leave the loginUrl) before sampling. The waitForFunction returns
  // immediately if already settled, so the steady-state cost is ~0.
  await session.page
    .waitForFunction(
      ({ loginUrl, patterns }) => {
        if (location.href === loginUrl) return false;
        if (!patterns || patterns.length === 0) return true;
        return patterns.some((p) => location.href.includes(p));
      },
      { loginUrl: site.loginUrl, patterns: site.loggedInUrlPatterns || [] },
      { timeout: 1500 }
    )
    .catch(() => {});
  let stillActive = await confirmLoggedIn(session.page, site).catch(() => false);
  if (!stillActive) {
    // Single retry after a short settle — covers the case where the SPA was
    // briefly between routes (e.g. pushState in flight) when we first
    // sampled. Don't loop further; if it's really logged out, we want to
    // tear the session down and surface that to the caller.
    await session.page.waitForTimeout(400);
    stillActive = await confirmLoggedIn(session.page, site).catch(() => false);
  }
  if (!stillActive) {
    await _logout(siteId);
    return { site: siteId, status: "logged_out", returned_sensitive_data: false };
  }
  session.lastActivity = Date.now();
  return { site: siteId, status: "logged_in", returned_sensitive_data: false };
}

async function _logout(siteId) {
  getSite(siteId);
  // If a pending-OTP session exists for this site, tear it down too —
  // logout while awaiting OTP means the user gave up on that attempt.
  const pending = pendingOtpSessions.get(siteId);
  if (pending) {
    await pending.browser.close().catch(() => {});
    pendingOtpSessions.delete(siteId);
  }
  smsCooldown.delete(siteId);
  const session = sessions.get(siteId);
  if (!session) return { site: siteId, status: "logged_out", returned_sensitive_data: false };
  await session.browser.close().catch(() => {});
  sessions.delete(siteId);
  return { site: siteId, status: "logged_out", returned_sensitive_data: false };
}

// Complete a `loginFlow: "username_otp"` login by submitting the code the
// user received via SMS. Looks up the pending Playwright session, fills the
// 6-box (or N-box) OTP input, clicks the OTP submit, and promotes the
// session to the `sessions` map on success. Audit log carries no code
// value (the digit string is sensitive in transit; we record only length).
async function _provideOtp(siteId, code) {
  const site = getSite(siteId);
  if (site.loginFlow !== "username_otp") {
    throw new Error(`provide_otp is not allowed for site ${siteId}: loginFlow is ${site.loginFlow || "single_step"}`);
  }
  if (!site.allowedTools.includes("provide_otp")) {
    throw new Error(`provide_otp is not allowed for site ${siteId}`);
  }
  // Liberal but bounded validation — most SMS OTPs are 4-8 digits. We accept
  // a string of digits only; anything else is almost certainly a typo.
  if (typeof code !== "string" || !/^\d{4,8}$/.test(code)) {
    throw new Error("code must be a 4-8 digit numeric string");
  }
  const pending = pendingOtpSessions.get(siteId);
  if (!pending) {
    const cooldown = getSmsCooldownState(siteId);
    audit({ action: "provide_otp", site: siteId, result: "no_pending_otp", returned_sensitive_data: false });
    return {
      site: siteId,
      status: "no_pending_otp",
      next_action: cooldown.active
        ? { type: "wait_then_relogin", wait_seconds: cooldown.waitSeconds, tool: "login", site: siteId }
        : { type: "relogin", tool: "login", site: siteId },
      hint: cooldown.active
        ? `No pending OTP session and upstream resend cooldown has ${cooldown.waitSeconds}s remaining. Wait ${cooldown.waitSeconds}s then call login (site=${siteId}).`
        : `No pending OTP session. Call login (site=${siteId}) to start a new login flow.`,
      returned_sensitive_data: false
    };
  }
  if (Date.now() > pending.expiresAt) {
    await pending.browser.close().catch(() => {});
    pendingOtpSessions.delete(siteId);
    const cooldown = getSmsCooldownState(siteId);
    audit({ action: "provide_otp", site: siteId, result: "otp_expired", returned_sensitive_data: false });
    return {
      site: siteId,
      status: "otp_expired",
      next_action: cooldown.active
        ? { type: "wait_then_relogin", wait_seconds: cooldown.waitSeconds, tool: "login", site: siteId }
        : { type: "relogin", tool: "login", site: siteId },
      hint: cooldown.active
        ? `OTP session expired and upstream resend cooldown has ${cooldown.waitSeconds}s remaining. Wait then call login (site=${siteId}).`
        : `OTP session expired. Call login (site=${siteId}) to start a new login flow.`,
      returned_sensitive_data: false
    };
  }

  const page = pending.page;
  const inputSel = site.otpSelectors && site.otpSelectors.inputs && site.otpSelectors.inputs[0];
  if (!inputSel) {
    throw new Error(`site ${siteId} has loginFlow=username_otp but no otpSelectors.inputs configured`);
  }
  // Locate every input matching the OTP selector in document order. Most
  // SMS OTP forms render N separate single-digit inputs (Maxicare: 6 ×
  // input[type=tel]); fall back to a single multi-digit input if there's
  // only one match.
  const inputLocator = page.locator(inputSel);
  // On a retry after `otp_not_accepted`, the OTP form often re-renders
  // (clears values, swaps the error toast in/out) and the inputs briefly
  // detach from the DOM. waitForSelector lets us absorb that flicker
  // before declaring the selector dead — without this, the worker would
  // nuke a live pending session because of a transient React re-render,
  // costing the user a fresh SMS to recover.
  await page
    .waitForSelector(inputSel, { state: "visible", timeout: 5000 })
    .catch(() => {});
  const inputCount = await inputLocator.count().catch(() => 0);
  if (inputCount === 0) {
    // Before declaring the OTP selector dead, check whether the SPA has
    // already navigated to a logged-in URL — Maxicare in particular has
    // been observed to accept an in-flight OTP submit and redirect the
    // page to /home before this provide_otp call sampled the form. In
    // that case, the right answer is "you're already logged in", not
    // "your selectors are broken" (which kills the session and forces a
    // fresh SMS round-trip the user can't easily complete).
    const alreadyLoggedIn = await confirmLoggedIn(page, site).catch(() => false);
    if (alreadyLoggedIn) {
      sessions.set(siteId, {
        browser: pending.browser,
        context: pending.context,
        page: pending.page,
        startedAt: new Date().toISOString(),
        lastActivity: Date.now()
      });
      pendingOtpSessions.delete(siteId);
      smsCooldown.delete(siteId);
      audit({ action: "provide_otp", site: siteId, result: "logged_in", code_length: code.length, already_logged_in: true, returned_sensitive_data: false });
      return { site: siteId, status: "logged_in", already_logged_in: true, returned_sensitive_data: false };
    }
    const snapshot = await snapshotPage(page).catch(() => null);
    await pending.browser.close().catch(() => {});
    pendingOtpSessions.delete(siteId);
    audit({ action: "provide_otp", site: siteId, result: "needs_site_selector_update", returned_sensitive_data: false });
    return {
      site: siteId,
      status: "needs_site_selector_update",
      missing_selector: "otp_input",
      snapshot,
      returned_sensitive_data: false
    };
  }
  // Keystroke events, not .fill(). React OTP components (react-otp-input,
  // input-otp, and Maxicare's own implementation) bind onKeyDown handlers
  // for digit entry and auto-advance, and DON'T update internal state when
  // .value is set programmatically. With .fill() the boxes look populated
  // but the component's state stays empty, the submit fires with no code,
  // and the server rejects it while the form stays mounted (observed on
  // Maxicare 2026-05-15 — manifested as `otp_not_accepted` while snapshot
  // still showed the OTP page with resend timer running).
  if (inputCount === 1) {
    await inputLocator.first().click().catch(() => {});
    await page.keyboard.type(code, { delay: 25 });
  } else {
    for (let i = 0; i < Math.min(inputCount, code.length); i++) {
      await inputLocator.nth(i).click().catch(() => {});
      await page.keyboard.type(code[i], { delay: 25 });
    }
  }

  // Submit strategy: try the configured submit button first, then ALWAYS
  // also press Enter on the last input. Some React OTP forms only react
  // to one or the other depending on whether the button is wired to an
  // onClick handler vs. a form-level onSubmit handler.
  const submit = await firstVisible(page, site.otpSelectors.submit || []);
  let submitButtonFound = false;
  let submitButtonEnabled = null;
  let submitButtonText = null;
  if (submit) {
    submitButtonFound = true;
    submitButtonEnabled = await submit.isEnabled().catch(() => null);
    submitButtonText = await submit.innerText().catch(() => null);
    await Promise.allSettled([
      page.waitForLoadState("networkidle", { timeout: 15000 }),
      submit.click()
    ]);
  }
  await inputLocator.last().press("Enter").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  // SPA hydration wait: networkidle fires before React routes finish rendering
  // on portals like Maxicare. Wait for *either* the URL to leave loginUrl OR
  // body text to reach a meaningful length, so confirmLoggedIn's signals have
  // something to read. Bail after timeout — a genuine OTP failure also leaves
  // the URL on loginUrl with little body text, and that case is handled below.
  await page
    .waitForFunction(
      (loginUrl) => {
        if (location.href !== loginUrl) return true;
        const main = document.querySelector("main, [role=main]") || document.body;
        return main && (main.innerText || "").trim().length > 80;
      },
      site.loginUrl,
      { timeout: 8000 }
    )
    .catch(() => {});
  await page.waitForTimeout(500);

  const loggedIn = await confirmLoggedIn(page, site);
  if (loggedIn) {
    // Promote the pending session to a real session and clear the pending slot.
    sessions.set(siteId, {
      browser: pending.browser,
      context: pending.context,
      page: pending.page,
      startedAt: new Date().toISOString(),
      lastActivity: Date.now()
    });
    pendingOtpSessions.delete(siteId);
    smsCooldown.delete(siteId);
    audit({ action: "provide_otp", site: siteId, result: "logged_in", code_length: code.length, returned_sensitive_data: false });
    return { site: siteId, status: "logged_in", returned_sensitive_data: false };
  }

  // OTP failed (wrong code, expired upstream, or a further step we don't
  // recognize). Leave the pending session open — the user may want to
  // retry with a corrected code before TTL — but expose a snapshot so the
  // caller can decide whether to retry, resend, or log out.
  const snapshot = await snapshotPage(page).catch(() => null);
  // Diagnostic readback. We log NO digits — only how many boxes had any
  // value at all (proves keystroke events reached the React component vs.
  // landed in the DOM only). main_text_excerpt is the first ~200 chars of
  // visible main-region text post-submit; on Maxicare this is where the
  // server's "Invalid code" / "Please request a new code" toast appears.
  // url tells us whether the SPA route changed at all (e.g. moved off the
  // OTP step to a "max attempts" wall). Together these tell us whether
  // failure is: digits-not-registered, code-wrong/expired, or upstream-
  // wall — without leaking the code or the page HTML to audit logs.
  const diag = await page
    .evaluate((sel) => {
      const inputs = Array.from(document.querySelectorAll(sel));
      const filled = inputs.filter((el) => (el.value || "").length > 0).length;
      const main = document.querySelector("main, [role=main]") || document.body;
      const mainText = ((main && main.innerText) || "").replace(/\s+/g, " ").trim().slice(0, 200);
      // Body text minus the main region — catches toasts rendered via React
      // portal to end-of-body that wouldn't appear in main.innerText.
      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const mainInner = ((main && main.innerText) || "").replace(/\s+/g, " ").trim();
      const outsideMain = bodyText.replace(mainInner, "").trim().slice(0, 200);
      return {
        url: location.href,
        input_count_post_submit: inputs.length,
        boxes_filled_post_submit: filled,
        main_text_excerpt: mainText,
        outside_main_text_excerpt: outsideMain
      };
    }, inputSel)
    .catch(() => ({}));
  const pageRevertedToStart_for_audit = (diag.input_count_post_submit || 0) === 0;
  // Differentiate upstream error toasts. "Incorrect OTP" means the request
  // reached validation and the code was wrong — user can correct it. A
  // generic "Something went wrong" toast means the request did NOT reach
  // validation: likely a bot-detection block, account-level rate-limit, or
  // upstream API outage. Telling these apart lets the caller stop blaming
  // the user's typing when the real problem is upstream-systemic.
  const combinedText = `${diag.main_text_excerpt || ""} ${diag.outside_main_text_excerpt || ""}`.toLowerCase();
  let failure_kind = "unknown";
  if (/incorrect otp|wrong code|invalid (?:code|otp)/i.test(combinedText)) {
    failure_kind = "otp_rejected";
  } else if (/something went wrong|please try again later|unable to/i.test(combinedText)) {
    failure_kind = "upstream_error";
  } else if (/too many|rate.?limit|locked|max(?:imum)? attempts/i.test(combinedText)) {
    failure_kind = "upstream_lockout";
  }
  audit({
    action: "provide_otp",
    site: siteId,
    result: "otp_not_accepted",
    failure_kind,
    code_length: code.length,
    page_reverted_to_start: pageRevertedToStart_for_audit,
    submit_button_found: submitButtonFound,
    submit_button_enabled: submitButtonEnabled,
    submit_button_text: submitButtonText,
    post_submit_url: diag.url,
    post_submit_input_count: diag.input_count_post_submit,
    post_submit_boxes_filled: diag.boxes_filled_post_submit,
    post_submit_outside_main_excerpt: diag.outside_main_text_excerpt,
    post_submit_main_text_excerpt: diag.main_text_excerpt,
    returned_sensitive_data: false
  });
  // Decide the next_action based on (a) whether the OTP page reverted to
  // the start page (Maxicare does this after a wrong code), and (b) whether
  // upstream's resend cooldown is still ticking. When the form is still
  // mounted, leave the pending session open for retry-with-corrected-code.
  // When the page reverted, the pending session is unusable — its page has
  // no OTP inputs to fill, and the next provide_otp would land in the
  // needs_site_selector_update branch above. Tear it down here so the next
  // login_<site> sees pending_session_active=false and the next provide_otp
  // sees no_pending_otp, both of which correctly steer the caller toward
  // wait_then_relogin.
  const cooldownAfter = getSmsCooldownState(siteId);
  const pageRevertedToStart = (diag.input_count_post_submit || 0) === 0;
  let next_action;
  if (pageRevertedToStart && cooldownAfter.active) {
    next_action = {
      type: "wait_then_relogin",
      wait_seconds: cooldownAfter.waitSeconds,
      tool: "login",
      site: siteId,
      note: `Upstream resend cooldown has ${cooldownAfter.waitSeconds}s remaining. Calling login (site=${siteId}) now will NOT trigger a fresh SMS.`
    };
  } else if (pageRevertedToStart) {
    next_action = {
      type: "relogin",
      tool: "login",
      site: siteId,
      note: "OTP page reverted to start; cooldown has elapsed so login should issue a fresh SMS."
    };
  } else {
    next_action = {
      type: "retry_provide_otp",
      tool: "provide_otp",
      site: siteId,
      note: "OTP form is still mounted; submit a corrected code."
    };
  }
  // When the upstream toast is the generic "Something went wrong" (not
  // "Incorrect OTP"), the request didn't reach code validation — re-trying
  // with another SMS code is unlikely to help. Override next_action with a
  // diagnostic hint pointing the caller at the underlying cause rather than
  // a fruitless retry loop.
  if (failure_kind === "upstream_error" || failure_kind === "upstream_lockout") {
    next_action = {
      type: "investigate_upstream",
      note: `Upstream returned a generic error toast (failure_kind=${failure_kind}), not a wrong-code rejection. Repeatedly resubmitting OTPs will not help. Likely causes: (a) too many failed attempts triggered an IP/account-level block — wait significantly longer (30+ minutes) before retrying; (b) the mobile number in the worker's secret store does not match the one Maxicare expects; (c) Maxicare's OTP API is degraded. Suggest the user verify by logging in manually via the Maxicare app/site with the same mobile number before retrying automation.`
    };
  }
  if (pageRevertedToStart) {
    await pending.browser.close().catch(() => {});
    pendingOtpSessions.delete(siteId);
  }
  return {
    site: siteId,
    status: "needs_user_action",
    reason: "otp_not_accepted",
    failure_kind,
    page_reverted_to_start: pageRevertedToStart,
    pending_session_active: !pageRevertedToStart,
    snapshot,
    next_action,
    returned_sensitive_data: false
  };
}

function actionToMethod(action) {
  return action.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// Pre-login diagnostic. Navigates to the public site.loginUrl with a fresh
// browser, dumps form/input/button metadata, and closes. Does NOT use
// credentials, does NOT establish a session, and does NOT count against the
// login rate limit — the whole point is to author site.loginSelectors when
// the existing ones are wrong (i.e. when login returns needs_site_selector_update).
// Returns structural metadata only; returned_sensitive_data: false.
async function _diagnoseLoginForm(siteId) {
  const site = getSite(siteId);
  assertAllowedUrl(site.loginUrl, site);

  const browser = await chromium().launch({ headless: headlessMode, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    // Playwright's default UA contains "HeadlessChrome" — the cheapest WAF rule
    // (e.g. Cloudflare's default bot-fight) drops it on sight. Override with
    // a current stable Chrome string + realistic viewport so the diagnostic
    // actually sees the form. We do this only for diagnose_login_form; the
    // real _login path stays as-is for now — if a site needs the same
    // treatment to log in, that's a per-site fix.
    const context = await browser.newContext({
      ignoreHTTPSErrors: false,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "Asia/Manila"
    });
    const page = await context.newPage();

    // NOTE: unlike _login (which gates subresources to site.allowedDomains),
    // the pre-login diagnostic does NOT route-gate. SPAs commonly ship vendor
    // bundles from off-allowlist CDNs (cloudfront, akamai, etc.) and blocking
    // them prevents the form from hydrating, so the diagnostic returns empty
    // — defeating its purpose. Top-level navigation is still pinned to
    // site.loginUrl via assertAllowedUrl above; the relaxation only applies
    // to subresources fetched by that page. We send no credentials and return
    // only redacted structural metadata, so allowing third-party JS to render
    // is safe.

    await page.goto(site.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // SPAs hydrate after DOMContentLoaded; wait for network idle so the form
    // is in the DOM before we query. networkidle is a best-effort heuristic —
    // swallow timeouts so a chatty page doesn't block the diagnostic.
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    // Belt-and-suspenders: some SPAs lazy-load the auth bundle after
    // networkidle. Wait for any password input as a hydration signal; swallow
    // timeouts so sites without a visible password (e.g. multi-step username-
    // first flows) still get the form snapshot we have.
    await page.waitForSelector("input[type=password]", { timeout: 10000, state: "attached" }).catch(() => {});

    const diagnose = require(path.join(extractorsDir, "_diagnose.js"));
    const frames = await diagnose.summarizeLoginForms(page);

    const result = {
      site: siteId,
      status: "ok",
      login_url: diagnose.sanitizeUrl(site.loginUrl),
      frames,
      returned_sensitive_data: false
    };
    audit({ action: "diagnose_login_form", site: siteId, result: "ok", returned_sensitive_data: false });
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function _extract(siteId, action, args) {
  const site = getSite(siteId);
  if (!action || typeof action !== "string") throw new Error("missing action");
  if (!site.allowedTools.includes(action)) {
    throw new Error(`action is not allowed for site ${siteId}: ${action}`);
  }

  // diagnose_login_form is the one pre-login action — it runs against the
  // public login page with no credentials and no session. Dispatch it before
  // the session/extractor-module checks below, which assume an active login.
  if (action === "diagnose_login_form") return _diagnoseLoginForm(siteId);

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
  // Hot-reload: drop the cached module so an extractor edit takes effect on
  // the next call without restarting the worker (which would kill every
  // live login session, including ones gated by SMS OTP that cost a user
  // a fresh code to recreate). Production parity isn't affected — the
  // module still resolves through the standard require path and its
  // dependencies (`_diagnose.js`, etc.) load normally per call. The
  // worker rebuilds the extractor object each invocation; this matches
  // the per-call overhead of reading sites.json from disk that already
  // exists today.
  delete require.cache[require.resolve(extractorPath)];
  // Also drop the shared diagnose helper so edits to it hot-reload too.
  const diagnoseHelperPath = path.join(extractorsDir, "_diagnose.js");
  delete require.cache[require.resolve(diagnoseHelperPath)];
  const extractor = require(extractorPath);
  const method = actionToMethod(action);
  if (typeof extractor[method] !== "function") {
    throw new Error(`extractor does not implement ${method}`);
  }

  const session = sessions.get(siteId);
  try {
    // Pass args as a second positional arg. Extractors that don't take args
    // (every existing one) simply ignore it — they're declared as
    // `function fn(page) {}` and the extra arg is dropped by the engine.
    // New write-class tools (submit_claim) destructure it explicitly.
    // Wrap in a per-action timeout: if the extractor wedges on a DOM
    // wait (network black-hole, infinite redirect, missing element), the
    // worker would otherwise consume its only Chromium for the full MCP
    // outer timeout (~60s). withActionTimeout rejects fast with
    // code="extractor_timeout", remapped below to a clean status payload.
    const result = await withActionTimeout(
      extractor[method](session.page, args || {}),
      extractorTimeoutMs,
      `${siteId}.${action}`
    );
    session.lastActivity = Date.now();
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
    if (error.code === "extractor_timeout") {
      audit({
        action,
        site: siteId,
        result: "extractor_timeout",
        timeout_ms: extractorTimeoutMs,
        returned_sensitive_data: false
      });
      return { site: siteId, status: "extractor_timeout", timeout_ms: extractorTimeoutMs, returned_sensitive_data: false };
    }
    throw error;
  }
}

// Public entry points serialize per-site so the sessions map is never read and
// then written across an await boundary by two callers at once.
const login = (siteId) => withSiteLock(siteId, () => _login(siteId));
const checkSession = (siteId) => withSiteLock(siteId, () => _checkSession(siteId));
const logout = (siteId) => withSiteLock(siteId, () => _logout(siteId));
const extract = (siteId, action, args) => withSiteLock(siteId, () => _extract(siteId, action, args));
const provideOtp = (siteId, code) => withSiteLock(siteId, () => _provideOtp(siteId, code));

function startIdleReaper() {
  // Idle-session reaper. Sessions left open after `sessionIdleMs` of inactivity
  // are closed so a long-lived cookie + live Chromium aren't sitting around
  // indefinitely. Goes through the lock so we never tear down mid-extract.
  // Also sweeps pendingOtpSessions whose TTL has elapsed (user never sent the
  // code) — those are bypass-the-lock because they hold no real session yet.
  return setInterval(() => {
    const now = Date.now();
    for (const [siteId, session] of sessions.entries()) {
      if (now - (session.lastActivity || 0) < sessionIdleMs) continue;
      logout(siteId)
        .then(() => audit({ action: "idle_reap", site: siteId, result: "logged_out", returned_sensitive_data: false }))
        .catch((err) => audit({ action: "idle_reap", site: siteId, result: "failed", error: redactErrorMessage(err), returned_sensitive_data: false }));
    }
    for (const [siteId, pending] of pendingOtpSessions.entries()) {
      if (now < pending.expiresAt) continue;
      pending.browser.close().catch(() => {});
      pendingOtpSessions.delete(siteId);
      audit({ action: "otp_reap", site: siteId, result: "otp_expired", returned_sensitive_data: false });
    }
  }, sessionSweepMs).unref();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Shared-secret auth between MCP and worker. Must match the MCP side's
// `BROWSER_INTENT_WORKER_SECRET` env. When unset, the worker logs a warning
// at boot and accepts requests (bootstrap fallback for fresh deployments
// where the operator hasn't yet generated the secret) — production stacks
// should always set it. /healthz is exempt: the compose healthcheck runs
// inside this container and we don't want it reading .env.
// Read the env fresh on each call so tests can flip the secret without
// reloading the module. Production hot path is one env lookup per request,
// which is cheaper than the JSON parse that follows.
function workerAuthOk(req, expectedSecret = process.env.BROWSER_INTENT_WORKER_SECRET || "") {
  if (!expectedSecret) return true; // bootstrap fallback; warned at boot
  const provided = req.headers && req.headers["x-worker-auth"];
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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

    if (!workerAuthOk(req)) {
      // Route through audit() so the event picks up status_kind:denied like
      // every other denial event in the system. A misconfigured MCP or a
      // hostile sibling container surfaces uniformly in Wazuh.
      audit({
        result: "worker_auth_rejected",
        path: req.url,
        remote: req.socket && req.socket.remoteAddress
      });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "worker_auth_required" }));
      return;
    }

    const body = await readJson(req);
    let payload;
    if (req.url === "/login") payload = await login(body.site);
    else if (req.url === "/session") payload = await checkSession(body.site);
    else if (req.url === "/logout") payload = await logout(body.site);
    else if (req.url === "/extract") payload = await extract(body.site, body.action, body.args);
    else if (req.url === "/provide-otp") payload = await provideOtp(body.site, body.code);
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
      error: redactErrorMessage(error),
      returned_sensitive_data: false
    }));
  }
});

// Test-only exports. Tests require this module without auto-starting the HTTP
// server, idle reaper, or SIGTERM handler — those live behind the
// `require.main === module` gate below.
module.exports = {
  hostnameAllowed,
  assertAllowedUrl,
  base32Decode,
  totp,
  withSiteLock,
  loginRateCheck,
  redactErrorMessage,
  parseDotEnv,
  readRenderedSecrets,
  getSmsCooldownState,
  workerAuthOk,
  statusToKind,
  STATUS_KIND,
  resolveLoginUrl,
  URL_PLACEHOLDERS,
  withActionTimeout,
  __setSmsCooldownForTest(siteId, untilMs, smsLikelyFresh) {
    smsCooldown.set(siteId, { until: untilMs, smsLikelyFresh });
  },
  __testReset() {
    sessions.clear();
    siteLocks.clear();
    loginAttempts.clear();
    pendingOtpSessions.clear();
    smsCooldown.clear();
    _secretsCache.clear();
  }
};

if (require.main === module) {
  // 0.0.0.0 is required: worker is on an isolated Docker internal network (browser-internal);
  // access is limited to the MCP container — never published to the host.
  if (!process.env.BROWSER_INTENT_WORKER_SECRET) {
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "browser-intent-worker",
      level: "warn",
      msg: "BROWSER_INTENT_WORKER_SECRET is unset; worker is accepting unauthenticated requests. Generate with `openssl rand -hex 32`, add to .env, and set on both worker and mcp services."
    })}\n`);
  }
  server.listen(port, "0.0.0.0");
  startIdleReaper();

  process.on("SIGTERM", async () => {
    // Bypass the lock at shutdown — we are tearing down regardless of in-flight calls.
    for (const siteId of sessions.keys()) await _logout(siteId).catch(() => {});
    for (const [, pending] of pendingOtpSessions.entries()) await pending.browser.close().catch(() => {});
    process.exit(0);
  });
}
