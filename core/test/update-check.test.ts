import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/cli.js";
import { defaultPolicy, policyVersion, validatePolicy } from "../src/config.js";
import type { Policy } from "../src/types.js";
import {
  checkForUpdate,
  compareVersions,
  readUpdateCache,
  updateView,
} from "../src/update-check.js";
import type { UpdateCache } from "../src/update-check.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function tempHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "evener-update-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function policyWith(overrides: Partial<Policy["update_check"]> = {}): Policy {
  const policy = defaultPolicy();
  policy.update_check = {
    enabled: true,
    interval_hours: 24,
    registry: "https://registry.example.test",
    ...overrides,
  };
  return policy;
}

function cacheFile(home: string): string {
  return join(home, "update-check.json");
}

function seedCache(home: string, cache: UpdateCache): void {
  writeFileSync(cacheFile(home), `${JSON.stringify(cache)}\n`, "utf8");
}

interface FetchCall {
  url: string;
  options: RequestInit | undefined;
}

function recordingFetch(
  respond: () => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), options: init });
    return respond();
  };
  return { fetchImpl, calls };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

test("compareVersions follows numeric, prerelease and lexical ordering", () => {
  const cases: [string, string, -1 | 0 | 1][] = [
    ["0.1.0-rc.1", "0.1.0", -1],
    ["0.1.0", "0.1.0-rc.1", 1],
    ["0.10.0", "0.9.9", 1],
    ["1.2.3", "1.2.3", 0],
    ["0.1.0-alpha", "0.1.0-alpha.1", -1],
    ["0.1.0-alpha.1", "0.1.0-alpha.beta", -1],
    ["0.1.0-alpha.2", "0.1.0-alpha.10", -1],
    ["0.1.0-beta", "0.1.0-alpha", 1],
    ["0.1.0-1", "0.1.0-alpha", -1],
    ["0.1.0-alpha", "0.1.0-1", 1],
    ["garbage", "0.0.0", 0],
    ["0.0.0", "garbage", 0],
    ["garbage", "1.0.0", -1],
    ["1.0.0", "garbage", 1],
  ];

  for (const [left, right, expected] of cases) {
    assert.equal(compareVersions(left, right), expected, `${left} vs ${right}`);
    const reversed = expected === 0 ? 0 : expected === 1 ? -1 : 1;
    assert.equal(compareVersions(right, left), reversed, `${right} vs ${left}`);
  }
});

test("updateView never reports an unparsable latest as available", () => {
  const cache: UpdateCache = {
    checked_at: "2026-11-10T00:00:00.000Z",
    current: "0.1.0",
    latest: "0.2.0",
    error: null,
  };
  assert.deepEqual(updateView(cache, "0.1.0"), {
    current: "0.1.0",
    latest: "0.2.0",
    available: true,
    checked_at: "2026-11-10T00:00:00.000Z",
  });
  assert.equal(updateView({ ...cache, latest: "nightly" }, "0.1.0").available, false);
  assert.deepEqual(updateView(null, "0.1.0"), {
    current: "0.1.0",
    latest: null,
    available: false,
    checked_at: null,
  });
});

// ---------------------------------------------------------------------------
// readUpdateCache
// ---------------------------------------------------------------------------

test("readUpdateCache returns the cache or null for missing/malformed files", (t) => {
  const home = tempHome(t);
  assert.equal(readUpdateCache(home), null);

  const cache: UpdateCache = {
    checked_at: "2026-11-10T00:00:00.000Z",
    current: "0.1.0",
    latest: "0.2.0",
    error: null,
  };
  seedCache(home, cache);
  assert.deepEqual(readUpdateCache(home), cache);

  writeFileSync(cacheFile(home), "{not json", "utf8");
  assert.equal(readUpdateCache(home), null);

  writeFileSync(cacheFile(home), JSON.stringify({ latest: "1.0.0" }), "utf8");
  assert.equal(readUpdateCache(home), null);
});

// ---------------------------------------------------------------------------
// checkForUpdate
// ---------------------------------------------------------------------------

test("checkForUpdate writes the cache on network success", async (t) => {
  const home = tempHome(t);
  seedCache(home, {
    checked_at: "2026-11-09T00:00:00.000Z",
    current: "1.0.0",
    latest: "1.0.0",
    error: null,
  });
  const now = new Date("2026-11-10T12:00:00.000Z");
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ version: "1.2.3" }));

  const result = await checkForUpdate({
    home,
    policy: policyWith(),
    current: "1.0.0",
    now,
    fetch: fetchImpl,
    env: {},
  });

  assert.deepEqual(result, {
    current: "1.0.0",
    latest: "1.2.3",
    available: true,
    checked_at: now.toISOString(),
    skipped: null,
    error: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://registry.example.test/evener/latest");
  assert.equal(calls[0]?.options?.headers instanceof Object, true);
  assert.deepEqual(calls[0]?.options?.headers, { Accept: "application/json" });
  assert.ok(calls[0]?.options?.signal instanceof AbortSignal);
  assert.deepEqual(readUpdateCache(home), {
    checked_at: now.toISOString(),
    current: "1.0.0",
    latest: "1.2.3",
    error: null,
  });
});

test("a 500 keeps the previous latest and records an error", async (t) => {
  const home = tempHome(t);
  seedCache(home, {
    checked_at: "2026-11-09T00:00:00.000Z",
    current: "1.0.0",
    latest: "2.0.0",
    error: null,
  });
  const now = new Date("2026-11-10T12:00:00.000Z");
  const { fetchImpl } = recordingFetch(() => new Response("nope", { status: 500 }));

  const result = await checkForUpdate({
    home,
    policy: policyWith(),
    current: "1.0.0",
    now,
    fetch: fetchImpl,
    env: {},
  });

  assert.equal(result.skipped, null);
  assert.equal(result.latest, "2.0.0");
  assert.equal(result.available, true);
  assert.equal(result.checked_at, now.toISOString());
  assert.match(result.error ?? "", /^http_500: /);
  const cache = readUpdateCache(home);
  assert.equal(cache?.latest, "2.0.0");
  assert.equal(cache?.checked_at, now.toISOString());
  assert.match(cache?.error ?? "", /^http_500: /);
});

test("a timeout keeps the previous latest and records an error", async (t) => {
  const home = tempHome(t);
  seedCache(home, {
    checked_at: "2026-11-09T00:00:00.000Z",
    current: "1.0.0",
    latest: "3.0.0",
    error: null,
  });
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  const { fetchImpl } = recordingFetch(() => {
    throw timeout;
  });

  const result = await checkForUpdate({
    home,
    policy: policyWith(),
    current: "1.0.0",
    now: new Date("2026-11-10T12:00:00.000Z"),
    fetch: fetchImpl,
    env: {},
  });

  assert.match(result.error ?? "", /^timeout: /);
  assert.equal(result.latest, "3.0.0");
  assert.equal(readUpdateCache(home)?.latest, "3.0.0");
});

test("invalid JSON keeps the previous latest and records an error", async (t) => {
  const home = tempHome(t);
  seedCache(home, {
    checked_at: "2026-11-09T00:00:00.000Z",
    current: "1.0.0",
    latest: "4.0.0",
    error: null,
  });
  const { fetchImpl } = recordingFetch(
    () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
  );

  const result = await checkForUpdate({
    home,
    policy: policyWith(),
    current: "1.0.0",
    now: new Date("2026-11-10T12:00:00.000Z"),
    fetch: fetchImpl,
    env: {},
  });

  assert.match(result.error ?? "", /^invalid_json: /);
  assert.equal(result.latest, "4.0.0");
  assert.equal(readUpdateCache(home)?.latest, "4.0.0");
});

test("fresh, env, disabled and offline skips never touch the network", async (t) => {
  const now = new Date("2026-11-10T12:00:00.000Z");

  const freshHome = tempHome(t);
  const freshCache: UpdateCache = {
    checked_at: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    current: "1.0.0",
    latest: "5.0.0",
    error: null,
  };
  seedCache(freshHome, freshCache);
  const before = readFileSync(cacheFile(freshHome), "utf8");
  const freshFetch = recordingFetch(() => jsonResponse({ version: "9.9.9" }));
  const fresh = await checkForUpdate({
    home: freshHome,
    policy: policyWith(),
    current: "1.0.0",
    now,
    fetch: freshFetch.fetchImpl,
    env: {},
  });
  assert.equal(fresh.skipped, "fresh");
  assert.equal(fresh.latest, "5.0.0");
  assert.equal(freshFetch.calls.length, 0);
  assert.equal(readFileSync(cacheFile(freshHome), "utf8"), before);

  const envHome = tempHome(t);
  const envFetch = recordingFetch(() => jsonResponse({ version: "9.9.9" }));
  const env = await checkForUpdate({
    home: envHome,
    policy: policyWith(),
    current: "1.0.0",
    now,
    fetch: envFetch.fetchImpl,
    env: { CI: "1" },
  });
  assert.equal(env.skipped, "env");
  assert.equal(env.latest, null);
  assert.equal(envFetch.calls.length, 0);

  const disabledHome = tempHome(t);
  const disabledFetch = recordingFetch(() => jsonResponse({ version: "9.9.9" }));
  const disabled = await checkForUpdate({
    home: disabledHome,
    policy: policyWith({ enabled: false }),
    current: "1.0.0",
    now,
    fetch: disabledFetch.fetchImpl,
    env: {},
  });
  assert.equal(disabled.skipped, "disabled");
  assert.equal(disabledFetch.calls.length, 0);

  const offlineHome = tempHome(t);
  seedCache(offlineHome, {
    checked_at: "2026-11-09T00:00:00.000Z",
    current: "1.0.0",
    latest: "6.0.0",
    error: null,
  });
  const offlineFetch = recordingFetch(() => jsonResponse({ version: "9.9.9" }));
  const offline = await checkForUpdate({
    home: offlineHome,
    policy: policyWith(),
    current: "1.0.0",
    now,
    fetch: offlineFetch.fetchImpl,
    offline: true,
    env: {},
  });
  assert.equal(offline.skipped, "offline");
  assert.equal(offline.latest, "6.0.0");
  assert.equal(offlineFetch.calls.length, 0);

  const emptyOffline = await checkForUpdate({
    home: tempHome(t),
    policy: policyWith(),
    current: "1.0.0",
    now,
    fetch: offlineFetch.fetchImpl,
    offline: true,
    env: {},
  });
  assert.equal(emptyOffline.skipped, "offline");
  assert.equal(emptyOffline.latest, null);
  assert.equal(emptyOffline.available, false);
});

test("force bypasses a fresh cache", async (t) => {
  const home = tempHome(t);
  seedCache(home, {
    checked_at: "2026-11-10T11:59:00.000Z",
    current: "1.0.0",
    latest: "1.0.0",
    error: null,
  });
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ version: "7.0.0" }));

  const result = await checkForUpdate({
    home,
    policy: policyWith(),
    current: "1.0.0",
    now: new Date("2026-11-10T12:00:00.000Z"),
    fetch: fetchImpl,
    force: true,
    env: {},
  });

  assert.equal(result.skipped, null);
  assert.equal(result.latest, "7.0.0");
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

test("update-check prints JSON even with --quiet", async (t) => {
  const home = tempHome(t);
  const out: string[] = [];
  const io: CliIO & { fetchImpl?: typeof fetch } = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: () => {
      // no warnings expected
    },
    env: {},
    cwd: process.cwd(),
    fetchImpl: async () => jsonResponse({ version: "8.0.0" }),
  };

  const code = await runCli(["update-check", "--force", "--quiet", "--home", home], io);
  assert.equal(code, 0);
  const payload = JSON.parse(out.join("")) as {
    current: string;
    latest: string | null;
    available: boolean;
    skipped: string | null;
    error: string | null;
  };
  assert.equal(payload.latest, "8.0.0");
  assert.equal(payload.available, true);
  assert.equal(payload.skipped, null);
  assert.equal(payload.error, null);
  assert.equal(readUpdateCache(home)?.latest, "8.0.0");
});

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

test("update_check defaults, validates and participates in the policy hash", () => {
  const defaults = defaultPolicy();
  assert.deepEqual(defaults.update_check, {
    enabled: true,
    interval_hours: 24,
    registry: "https://registry.npmjs.org",
  });
  assert.equal(validatePolicy(defaults).ok, true);

  const legacy = JSON.parse(JSON.stringify(defaults)) as Record<string, unknown>;
  delete legacy["update_check"];
  const legacyResult = validatePolicy(legacy);
  assert.equal(legacyResult.ok, true, JSON.stringify(legacyResult.errors));
  if (legacyResult.ok) {
    assert.deepEqual(legacyResult.policy.update_check, defaults.update_check);
  }

  const zeroInterval = structuredClone(defaults);
  zeroInterval.update_check.interval_hours = 0;
  const zeroResult = validatePolicy(zeroInterval);
  assert.equal(zeroResult.ok, false);
  assert.ok(
    zeroResult.errors.some((issue) => issue.path === "/update_check/interval_hours"),
    JSON.stringify(zeroResult.errors),
  );

  const stringInterval = structuredClone(defaults) as unknown as {
    update_check: { interval_hours: unknown };
  };
  stringInterval.update_check.interval_hours = "24";
  const stringResult = validatePolicy(stringInterval);
  assert.equal(stringResult.ok, false);
  assert.ok(
    stringResult.errors.some((issue) => issue.path === "/update_check/interval_hours"),
    JSON.stringify(stringResult.errors),
  );

  for (const registry of ["ftp://registry.example.test", "not a url"]) {
    const badRegistry = structuredClone(defaults);
    badRegistry.update_check.registry = registry;
    const registryResult = validatePolicy(badRegistry);
    assert.equal(registryResult.ok, false, registry);
    assert.ok(
      registryResult.errors.some((issue) => issue.path === "/update_check/registry"),
      JSON.stringify(registryResult.errors),
    );
  }

  const changed = structuredClone(defaults);
  changed.update_check.enabled = false;
  assert.notEqual(policyVersion(defaults), policyVersion(changed));
});
