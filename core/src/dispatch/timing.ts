/**
 * Timestamp helpers shared by the dispatch adapters.
 *
 * Both streams currently emit a mix of ISO strings and epoch numbers. Only
 * timestamps that are actually present are used: the adapters never synthesise
 * a clock reading, so a stream without timestamps reports null timing.
 */

const TIMESTAMP_KEYS = [
  "ts",
  "timestamp",
  "time",
  "start_ts",
  "end_ts",
  "started_at",
  "startedAt",
  "completed_at",
  "completedAt",
] as const;

const DURATION_KEYS = [
  "duration_ms",
  "durationMs",
  "elapsed_ms",
  "elapsedMs",
  "latency_ms",
  "latencyMs",
  "model_ms",
  "modelMs",
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an ISO string or epoch number into epoch milliseconds. */
export function timestampMs(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Epoch seconds are ~1.7e9, epoch milliseconds ~1.7e12. Smaller numbers are
    // treated as relative milliseconds (some test fixtures use them).
    if (value >= 1e12) return value;
    if (value >= 1e9) return value * 1000;
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return timestampMs(numeric);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** First timestamp-valued field among `keys` on `obj`. */
export function timestampField(
  obj: Record<string, unknown>,
  keys: readonly string[] = TIMESTAMP_KEYS,
): number | null {
  for (const key of keys) {
    const parsed = timestampMs(obj[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Timestamp on an event, falling back to a timestamp nested under `item`.
 * Adapters differ in whether the timestamp sits beside the item or inside it.
 * `keys` lets an end event prefer completion fields over a nested `started_at`.
 */
export function eventTimestampMs(
  obj: Record<string, unknown>,
  keys: readonly string[] = TIMESTAMP_KEYS,
): number | null {
  const top = timestampField(obj, keys);
  if (top !== null) return top;
  const item = obj["item"];
  if (isRecord(item)) {
    const nested = timestampField(item, keys);
    if (nested !== null) return nested;
  }
  const timing = obj["timing"];
  return isRecord(timing) ? timestampField(timing, keys) : null;
}

/** Explicit non-negative duration in milliseconds, if the stream supplied one. */
export function durationMs(obj: Record<string, unknown>): number | null {
  for (const key of DURATION_KEYS) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  const nested = obj["timing"];
  return isRecord(nested) ? durationMs(nested) : null;
}

/** Non-negative rounded difference between two timestamps. */
export function elapsedMs(start: number | null, end: number | null): number | null {
  if (start === null || end === null) return null;
  const difference = end - start;
  return Number.isFinite(difference) ? Math.max(0, Math.round(difference)) : null;
}

export interface TimingTotals {
  model_ms: number | null;
  tool_ms: number | null;
}

/**
 * Turn a raw tool duration and model duration into the payload pair.
 *
 * `wallMs` (when known) caps the total so `model_ms + tool_ms <= wall_ms`.
 * Without a wall reading the stream's own first→last timestamp span is used.
 */
export function finaliseTiming(
  timingKnown: boolean,
  rawToolMs: number,
  rawModelMs: number | null,
  wallMs: number | null,
  streamSpanMs: number | null,
): TimingTotals {
  if (!timingKnown) return { model_ms: null, tool_ms: null };

  const wall = wallMs ?? streamSpanMs;
  if (wall === null) {
    const tool = Math.max(0, Math.round(rawToolMs));
    const model = rawModelMs === null ? 0 : Math.max(0, Math.round(rawModelMs));
    return { model_ms: model, tool_ms: tool };
  }

  const cappedWall = Math.max(0, Math.round(wall));
  const tool = Math.min(Math.max(0, Math.round(rawToolMs)), cappedWall);
  const remaining = Math.max(0, cappedWall - tool);
  const model = rawModelMs === null ? remaining : Math.min(Math.max(0, Math.round(rawModelMs)), remaining);
  return { model_ms: model, tool_ms: tool };
}
