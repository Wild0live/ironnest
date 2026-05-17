const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Worker spawns Playwright at runtime, but the pure helpers don't touch it.
// Requiring the module is safe because auto-start is gated on `require.main`.
process.env.BROWSER_INTENT_LOGIN_MAX_PER_WINDOW = "3";
process.env.BROWSER_INTENT_LOGIN_WINDOW_MINUTES = "15";
const worker = require("../worker");

test.beforeEach(() => worker.__testReset());

test("hostnameAllowed: exact match", () => {
  assert.equal(worker.hostnameAllowed("example.com", ["example.com"]), true);
});

test("hostnameAllowed: wildcard matches subdomain", () => {
  assert.equal(worker.hostnameAllowed("foo.example.com", ["*.example.com"]), true);
});

test("hostnameAllowed: wildcard matches root domain", () => {
  assert.equal(worker.hostnameAllowed("example.com", ["*.example.com"]), true);
});

test("hostnameAllowed: rejects unrelated host", () => {
  assert.equal(worker.hostnameAllowed("evil.com", ["example.com", "*.example.com"]), false);
});

test("hostnameAllowed: rejects suffix-confusion attack", () => {
  // notexample.com must NOT match a *.example.com allowlist.
  assert.equal(worker.hostnameAllowed("notexample.com", ["*.example.com"]), false);
  assert.equal(worker.hostnameAllowed("evilexample.com", ["example.com"]), false);
});

test("assertAllowedUrl: rejects http", () => {
  assert.throws(
    () => worker.assertAllowedUrl("http://example.com/login", { allowedDomains: ["example.com"] }),
    /only https/
  );
});

test("assertAllowedUrl: accepts https on allowlisted host", () => {
  assert.doesNotThrow(
    () => worker.assertAllowedUrl("https://example.com/login", { allowedDomains: ["example.com"] })
  );
});

test("assertAllowedUrl: rejects allowlisted-looking but distinct host", () => {
  assert.throws(
    () => worker.assertAllowedUrl("https://evil.com/login", { allowedDomains: ["example.com"] }),
    /not allowlisted/
  );
});

test("base32Decode: decodes RFC 4648 vector", () => {
  // Base32("foobar") = "MZXW6YTBOI======"; we strip padding.
  const out = worker.base32Decode("MZXW6YTBOI");
  assert.equal(out.toString("utf8"), "foobar");
});

test("base32Decode: rejects invalid character", () => {
  assert.throws(() => worker.base32Decode("MZXW!YTB"), /invalid TOTP secret/);
});

test("totp: matches RFC 6238 reference vector at t=59", () => {
  // Sha1 key "12345678901234567890" → base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  // RFC 6238 Appendix B: at t=59s SHA-1 code is 287082.
  const realNow = Date.now;
  Date.now = () => 59000;
  try {
    assert.equal(worker.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), "287082");
  } finally {
    Date.now = realNow;
  }
});

test("totp: counter offset shifts the window", () => {
  const realNow = Date.now;
  Date.now = () => 59000;
  try {
    const current = worker.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const previous = worker.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 30, 6, -1);
    const next = worker.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 30, 6, 1);
    assert.notEqual(current, previous);
    assert.notEqual(current, next);
    assert.notEqual(previous, next);
  } finally {
    Date.now = realNow;
  }
});

test("loginRateCheck: allows up to the configured limit", () => {
  // Configured to 3 per window via env at top of file.
  for (let i = 0; i < 3; i++) {
    assert.equal(worker.loginRateCheck("acme").allowed, true, `attempt ${i + 1} should pass`);
  }
});

test("loginRateCheck: blocks past the limit and reports retry-after", () => {
  for (let i = 0; i < 3; i++) worker.loginRateCheck("acme");
  const blocked = worker.loginRateCheck("acme");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0, "retry-after should be a positive number of seconds");
});

test("loginRateCheck: per-site, not global", () => {
  for (let i = 0; i < 3; i++) worker.loginRateCheck("acme");
  // Different site should still be allowed even though acme is exhausted.
  assert.equal(worker.loginRateCheck("other").allowed, true);
});

test("getSmsCooldownState: unset returns inactive", () => {
  const s = worker.getSmsCooldownState("acme");
  assert.equal(s.active, false);
  assert.equal(s.waitSeconds, 0);
  assert.equal(s.smsLikelyFresh, null);
});

test("getSmsCooldownState: future `until` is active with correct waitSeconds", () => {
  // 90s in the future.
  const future = Date.now() + 90_000;
  worker.__setSmsCooldownForTest("acme", future, false);
  const s = worker.getSmsCooldownState("acme");
  assert.equal(s.active, true);
  // Allow ±1s of clock drift between set and read.
  assert.ok(s.waitSeconds >= 89 && s.waitSeconds <= 91, `unexpected waitSeconds ${s.waitSeconds}`);
  assert.equal(s.smsLikelyFresh, false);
});

test("getSmsCooldownState: past `until` is inactive even though entry exists", () => {
  // 5s in the past.
  worker.__setSmsCooldownForTest("acme", Date.now() - 5_000, false);
  const s = worker.getSmsCooldownState("acme");
  assert.equal(s.active, false);
  assert.equal(s.waitSeconds, 0);
  // smsLikelyFresh is still surfaced so the caller can distinguish
  // "never seen a cooldown" from "saw one but it elapsed".
  assert.equal(s.smsLikelyFresh, false);
});

test("withSiteLock: serializes same-site calls", async () => {
  const order = [];
  const a = worker.withSiteLock("s", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 50));
    order.push("a-end");
    return "a";
  });
  const b = worker.withSiteLock("s", async () => {
    order.push("b-start");
    return "b";
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
});

test("withSiteLock: parallelizes across different sites", async () => {
  const order = [];
  const a = worker.withSiteLock("s1", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 50));
    order.push("a-end");
  });
  const b = worker.withSiteLock("s2", async () => {
    order.push("b-start");
    await new Promise((r) => setTimeout(r, 10));
    order.push("b-end");
  });
  await Promise.all([a, b]);
  // s2 finishes first because it's faster and not blocked by s1.
  assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"]);
});

test("withSiteLock: rejection in one call doesn't poison the next", async () => {
  await assert.rejects(worker.withSiteLock("s", async () => { throw new Error("boom"); }));
  const value = await worker.withSiteLock("s", async () => "ok");
  assert.equal(value, "ok");
});

test("parseDotEnv: parses bare KEY=VALUE lines", () => {
  const map = worker.parseDotEnv("FOO=one\nBAR=two\n");
  assert.equal(map.get("FOO"), "one");
  assert.equal(map.get("BAR"), "two");
});

test("parseDotEnv: strips surrounding double and single quotes", () => {
  const map = worker.parseDotEnv('A="quoted"\nB=\'single\'\nC=bare\n');
  assert.equal(map.get("A"), "quoted");
  assert.equal(map.get("B"), "single");
  assert.equal(map.get("C"), "bare");
});

test("parseDotEnv: skips blank lines and # comments", () => {
  const map = worker.parseDotEnv("\n# this is a comment\nFOO=ok\n\n");
  assert.equal(map.size, 1);
  assert.equal(map.get("FOO"), "ok");
});

test("parseDotEnv: preserves '=' inside the value", () => {
  const map = worker.parseDotEnv("URL=https://example.com/?a=b&c=d\n");
  assert.equal(map.get("URL"), "https://example.com/?a=b&c=d");
});

test("readRenderedSecrets: returns null when file is missing", () => {
  const missing = path.join(os.tmpdir(), `browser-intent-missing-${Date.now()}.env`);
  assert.equal(worker.readRenderedSecrets(missing), null);
});

test("readRenderedSecrets: caches by mtime and refreshes when the file changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-intent-secrets-"));
  const file = path.join(dir, ".env");
  try {
    // First write — pin mtime explicitly so the second write is reliably newer
    // even on filesystems with second-resolution mtimes.
    fs.writeFileSync(file, 'COL_FINANCIAL_USERNAME=old-id\nCOL_FINANCIAL_PASSWORD="old pw"\n');
    const t1 = new Date(Date.now() - 5000);
    fs.utimesSync(file, t1, t1);

    const first = worker.readRenderedSecrets(file);
    assert.equal(first.get("COL_FINANCIAL_USERNAME"), "old-id");
    assert.equal(first.get("COL_FINANCIAL_PASSWORD"), "old pw");

    // Repeat call with no mtime change must return the *same* Map instance —
    // proves the cache short-circuit fired.
    const cached = worker.readRenderedSecrets(file);
    assert.equal(cached, first, "cached map should be returned when mtime unchanged");

    // Rotate the file and bump mtime forward.
    fs.writeFileSync(file, "COL_FINANCIAL_USERNAME=0500-0839\nCOL_FINANCIAL_PASSWORD=new-pw\n");
    const t2 = new Date();
    fs.utimesSync(file, t2, t2);

    const refreshed = worker.readRenderedSecrets(file);
    assert.notEqual(refreshed, first, "fresh map should be returned when mtime changed");
    assert.equal(refreshed.get("COL_FINANCIAL_USERNAME"), "0500-0839");
    assert.equal(refreshed.get("COL_FINANCIAL_PASSWORD"), "new-pw");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workerAuthOk: empty expected-secret means bootstrap mode (accept anything)", () => {
  // Defines the documented fallback: before the operator generates the
  // shared secret, the worker accepts unauthenticated calls so the stack
  // boots. The boot log writes a warning; that lives in require.main code
  // and isn't asserted here.
  assert.equal(worker.workerAuthOk({ headers: {} }, ""), true);
  assert.equal(worker.workerAuthOk({ headers: { "x-worker-auth": "anything" } }, ""), true);
});

test("workerAuthOk: rejects missing or empty x-worker-auth when secret is configured", () => {
  assert.equal(worker.workerAuthOk({ headers: {} }, "expected-secret"), false);
  assert.equal(worker.workerAuthOk({ headers: { "x-worker-auth": "" } }, "expected-secret"), false);
  // Non-string headers must not crash.
  assert.equal(worker.workerAuthOk({ headers: { "x-worker-auth": 12345 } }, "expected-secret"), false);
});

test("workerAuthOk: rejects wrong header value (constant-time comparison)", () => {
  assert.equal(worker.workerAuthOk({ headers: { "x-worker-auth": "wrong-secret" } }, "expected-secret"), false);
  // Same length, different bytes — exercises timingSafeEqual rather than the
  // length-mismatch short-circuit.
  assert.equal(worker.workerAuthOk({ headers: { "x-worker-auth": "abcdef-secret-X" } }, "abcdef-secret-Y"), false);
});

test("workerAuthOk: accepts an exact-matching x-worker-auth header", () => {
  const secret = "1234567890abcdef1234567890abcdef";
  assert.equal(worker.workerAuthOk({ headers: { "x-worker-auth": secret } }, secret), true);
});

test("workerAuthOk: missing-headers request object is rejected, not crashed", () => {
  // The HTTP handler reads req.headers up front, but a malformed request
  // (or a test fixture) might not provide it — must return false, not throw.
  assert.equal(worker.workerAuthOk({}, "expected-secret"), false);
});

test("worker statusToKind: classifies worker-emitted statuses to the shared enum", () => {
  // Mirrors the mcp-server STATUS_KIND so dashboards group worker + mcp
  // audit events on the same field. Anything unmapped lands in 'unknown'
  // and trips a drift alert.
  assert.equal(worker.statusToKind("logged_in"), "success");
  assert.equal(worker.statusToKind("logged_out"), "success");
  assert.equal(worker.statusToKind("session_exists"), "success");
  assert.equal(worker.statusToKind("awaiting_otp"), "needs_user");
  assert.equal(worker.statusToKind("otp_expired"), "needs_user");
  assert.equal(worker.statusToKind("no_pending_otp"), "needs_user");
  assert.equal(worker.statusToKind("session_expired"), "session_expired");
  assert.equal(worker.statusToKind("rate_limited"), "rate_limited");
  assert.equal(worker.statusToKind("needs_extractor_update"), "needs_update");
  assert.equal(worker.statusToKind("worker_auth_rejected"), "denied");
  assert.equal(worker.statusToKind("failed"), "error");
  assert.equal(worker.statusToKind("some_new_status"), "unknown");
  assert.equal(worker.statusToKind(""), "unknown");
  assert.equal(worker.statusToKind(null), "unknown");
});

test("worker STATUS_KIND: no empty buckets (same invariant as the mcp-server mirror)", () => {
  for (const [kind, statuses] of Object.entries(worker.STATUS_KIND)) {
    assert.ok(Array.isArray(statuses) && statuses.length > 0, `${kind} bucket must not be empty`);
  }
});

test("resolveLoginUrl: URL without placeholders is returned unchanged", () => {
  const url = "https://members.april-international.com/auth/callback?foo=bar";
  assert.equal(worker.resolveLoginUrl(url), url);
});

test("resolveLoginUrl: substitutes {{code_challenge}} with a base64url-encoded SHA-256 digest", () => {
  const url = "https://am-gateway.april.fr/ipmi/login?code_challenge={{code_challenge}}&code_challenge_method=S256";
  const out = worker.resolveLoginUrl(url);
  assert.ok(!out.includes("{{code_challenge}}"), "placeholder must be substituted");
  // Extract the substituted value and verify the base64url shape (no padding,
  // 43 chars for a 32-byte SHA-256 digest).
  const match = out.match(/code_challenge=([^&]+)/);
  assert.ok(match);
  assert.match(match[1], /^[A-Za-z0-9_-]{43}$/, "code_challenge must be base64url-encoded SHA-256 (43 chars, no padding)");
});

test("resolveLoginUrl: each call returns a fresh value (verifier is not memoized)", () => {
  // Critical for PKCE correctness — a fresh verifier per login prevents
  // an attacker who observed an old challenge from replaying it.
  const url = "https://x.example/login?code_challenge={{code_challenge}}";
  const a = worker.resolveLoginUrl(url);
  const b = worker.resolveLoginUrl(url);
  assert.notEqual(a, b, "two resolveLoginUrl calls must produce different code_challenge values");
});

test("resolveLoginUrl: unknown placeholder throws with the list of known tokens (fail-fast on typos)", () => {
  // Defends against a sites.json typo silently leaking the literal token
  // into an upstream URL's logs.
  assert.throws(
    () => worker.resolveLoginUrl("https://x.example/login?x={{cod_challenge}}"),
    /unknown loginUrl placeholder '\{\{cod_challenge\}\}'.*code_challenge/
  );
  // Trailing junk that *looks* like a placeholder but isn't a strict
  // \w+ token (e.g. dashes) is not matched and passes through unchanged —
  // that's fine because such strings can't smuggle a real substitution.
  assert.equal(
    worker.resolveLoginUrl("https://x.example/login?x={{not-a-real-token}}"),
    "https://x.example/login?x={{not-a-real-token}}"
  );
});

test("URL_PLACEHOLDERS: code_challenge entry exists (regression — must not be silently dropped)", () => {
  // If a refactor accidentally removes code_challenge, April login would
  // start throwing 'unknown placeholder' at runtime; this test catches it
  // at unit-test time instead.
  assert.equal(typeof worker.URL_PLACEHOLDERS.code_challenge, "function");
});

test("withActionTimeout: resolves when the wrapped promise wins the race", async () => {
  const result = await worker.withActionTimeout(Promise.resolve({ ok: true }), 1000, "fast-action");
  assert.deepEqual(result, { ok: true });
});

test("withActionTimeout: rejects with code='extractor_timeout' when the wrapped promise stalls", async () => {
  // Item E: a per-action timeout bounds the worker's exposure to a
  // wedged Playwright DOM wait. Reject must carry the structured code so
  // _extract's catch block can map it to a clean status payload.
  const slow = new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 100));
  await assert.rejects(
    worker.withActionTimeout(slow, 20, "slow-action"),
    (err) => {
      assert.equal(err.code, "extractor_timeout");
      assert.match(err.message, /slow-action.*exceeded 20ms/);
      return true;
    }
  );
});

test("withActionTimeout: clears its own timer so the event loop doesn't keep idle handles open", async () => {
  // Regression: an earlier draft used setTimeout without clearing it on
  // the happy path, which kept node alive past test completion. The
  // .finally(clearTimeout) on the Promise.race result is what fixes that.
  const handlesBefore = process._getActiveHandles ? process._getActiveHandles().length : null;
  await worker.withActionTimeout(Promise.resolve(1), 5000, "fast");
  if (handlesBefore !== null) {
    // After resolution the timer handle must be gone — otherwise we'd
    // keep node alive for 5s post-resolve.
    const handlesAfter = process._getActiveHandles().length;
    assert.ok(handlesAfter <= handlesBefore + 0, "withActionTimeout must not leak timer handles past resolution");
  }
});

test("worker statusToKind: extractor_timeout classifies as 'error'", () => {
  // Mirrors the mcp-server side. Adding the worker-emitted timeout to the
  // worker's STATUS_KIND table prevents it landing in 'unknown' on Wazuh.
  assert.equal(worker.statusToKind("extractor_timeout"), "error");
});
