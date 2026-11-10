/**
 * Notify-only update check (spec §5, §10, §11).
 *
 * The library never applies an update: it makes at most one GET to the npm
 * registry, records the answer in `$EVENER_HOME/update-check.json`, and lets the
 * CLI / SessionStart hook surface a message.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "./types.js";

/** Environment variables that turn the check off when set to a non-empty value. */
export const UPDATE_CHECK_ENV_VARS = [
  "EVENER_NO_UPDATE_CHECK",
  "NO_UPDATE_NOTIFIER",
  "CI",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

export const UPDATE_CHECK_TIMEOUT_MS = 8000;
export const UPDATE_CHECK_CACHE_FILE = "update-check.json";
const VERSION_URL_PATH = "evener/latest";

export interface UpdateCache {
  /** ISO timestamp of the last attempt (success or failure). */
  checked_at: string;
  /** The version that wrote the cache. */
  current: string | null;
  /** Last known registry version, kept across failures. */
  latest: string | null;
  /** `"<code>: <message>"` for the last failed attempt, else null. */
  error: string | null;
}

export interface UpdateView {
  current: string;
  latest: string | null;
  available: boolean;
  checked_at: string | null;
}

export type UpdateSkipReason = null | "disabled" | "env" | "fresh" | "offline";

export interface UpdateCheckResult extends UpdateView {
  skipped: UpdateSkipReason;
  error: string | null;
}

export interface CheckForUpdateOptions {
  home: string;
  policy: Policy;
  current: string;
  now: Date;
  fetch: typeof fetch;
  force?: boolean;
  offline?: boolean;
  /** Injected environment; the library never reads `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

interface ParsedVersion {
  numbers: readonly [number, number, number];
  prerelease: readonly string[] | null;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  const prerelease = match[4] === undefined ? null : match[4].split(".");
  return { numbers: [major, minor, patch], prerelease };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): -1 | 0 | 1 {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;

    const aNumeric = NUMERIC_IDENTIFIER.test(a);
    const bNumeric = NUMERIC_IDENTIFIER.test(b);
    if (aNumeric && bNumeric) {
      const delta = Number(a) - Number(b);
      if (delta < 0) return -1;
      if (delta > 0) return 1;
      continue;
    }
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

/**
 * Compare two `X.Y.Z[-prerelease]` strings. Unparsable inputs are treated as
 * `0.0.0`; callers that need to suppress notifications must additionally check
 * that the version parses (see `updateView`).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a) ?? { numbers: [0, 0, 0] as const, prerelease: null };
  const right = parseVersion(b) ?? { numbers: [0, 0, 0] as const, prerelease: null };

  for (let index = 0; index < 3; index += 1) {
    const delta = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (delta < 0) return -1;
    if (delta > 0) return 1;
  }

  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

/** Read and validate `$EVENER_HOME/update-check.json`; malformed files are null. */
export function readUpdateCache(home: string): UpdateCache | null {
  const file = join(home, UPDATE_CHECK_CACHE_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const checkedAt = parsed["checked_at"];
  const current = fieldOrNull(parsed["current"]);
  const latest = fieldOrNull(parsed["latest"]);
  const error = fieldOrNull(parsed["error"]);
  if (
    typeof checkedAt !== "string" ||
    !Number.isFinite(Date.parse(checkedAt)) ||
    current === undefined ||
    latest === undefined ||
    error === undefined
  ) {
    return null;
  }

  return { checked_at: checkedAt, current, latest, error };
}

/** The `/api/overview` update shape; never reports an unparsable `latest`. */
export function updateView(cache: UpdateCache | null, current: string): UpdateView {
  const latest = cache?.latest ?? null;
  const available =
    latest !== null && parseVersion(latest) !== null && compareVersions(latest, current) > 0;
  return {
    current,
    latest,
    available,
    checked_at: cache?.checked_at ?? null,
  };
}

function cachePath(home: string): string {
  return join(home, UPDATE_CHECK_CACHE_FILE);
}

/** Write via a same-directory temp file + rename so readers never see a partial file. */
function writeUpdateCache(home: string, cache: UpdateCache): void {
  mkdirSync(home, { recursive: true });
  const target = cachePath(home);
  const temp = join(
    home,
    `.${UPDATE_CHECK_CACHE_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temp, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may not have been created.
    }
    throw error;
  }
}

function skippedResult(
  current: string,
  cache: UpdateCache | null,
  skipped: Exclude<UpdateSkipReason, null>,
): UpdateCheckResult {
  return {
    ...updateView(cache, current),
    skipped,
    error: cache?.error ?? null,
  };
}

class UpdateCheckFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UpdateCheckFailure";
    this.code = code;
  }
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof UpdateCheckFailure) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return { code, message: error.message };
    }
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return { code: "timeout", message: error.message };
    }
    if (error.name.length > 0) {
      return { code: error.name, message: error.message };
    }
    return { code: "error", message: error.message };
  }
  return { code: "error", message: String(error) };
}

function isFresh(cache: UpdateCache, now: Date, intervalHours: number): boolean {
  const checkedAt = Date.parse(cache.checked_at);
  if (!Number.isFinite(checkedAt)) return false;
  const intervalMs = intervalHours * 3_600_000;
  return now.getTime() - checkedAt < intervalMs;
}

function isEnvEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return UPDATE_CHECK_ENV_VARS.some((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
}

function registryUrl(registry: string): string {
  return `${registry.trim().replace(/\/+$/, "")}/${VERSION_URL_PATH}`;
}

async function fetchLatest(options: CheckForUpdateOptions): Promise<string> {
  let response: Response;
  try {
    response = await options.fetch(registryUrl(options.policy.update_check.registry), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    throw error;
  }

  if (!response.ok) {
    throw new UpdateCheckFailure(
      `http_${response.status}`,
      `registry responded with HTTP ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new UpdateCheckFailure("invalid_json", message);
  }

  if (!isRecord(body) || typeof body["version"] !== "string" || body["version"].length === 0) {
    throw new UpdateCheckFailure("invalid_response", 'response has no non-empty "version" string');
  }
  return body["version"];
}

/**
 * Run one update check according to the policy. Never throws: network, parse
 * and cache-write failures are recorded in the result and in the cache.
 */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult> {
  if (!options.policy.update_check.enabled) {
    return skippedResult(options.current, null, "disabled");
  }
  if (isEnvEnabled(options.env ?? {})) {
    return skippedResult(options.current, null, "env");
  }

  const previous = readUpdateCache(options.home);
  if (options.offline === true) {
    return skippedResult(options.current, previous, "offline");
  }
  if (
    options.force !== true &&
    previous !== null &&
    isFresh(previous, options.now, options.policy.update_check.interval_hours)
  ) {
    return skippedResult(options.current, previous, "fresh");
  }

  const checkedAt = options.now.toISOString();
  let latest = previous?.latest ?? null;
  let error: string | null = null;

  try {
    latest = await fetchLatest(options);
  } catch (caught) {
    const details = describeError(caught);
    error = `${details.code}: ${details.message}`;
  }

  const cache: UpdateCache = {
    checked_at: checkedAt,
    current: options.current,
    latest,
    error,
  };

  try {
    writeUpdateCache(options.home, cache);
  } catch (caught) {
    if (error === null) {
      const details = describeError(caught);
      error = `${details.code}: ${details.message}`;
    }
  }

  return {
    ...updateView(cache, options.current),
    skipped: null,
    error,
  };
}
