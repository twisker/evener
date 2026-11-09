/**
 * `codex exec --json` adapter (spec S1–S3).
 *
 * Success is `exit 0 && turn.completed seen`. `turn.completed.usage` is
 * cumulative for the thread (S1); a fresh `codex exec` per round therefore
 * needs no adjustment here, the last reported value is the round's usage.
 *
 * `item.started` / `item.completed` timestamps give the timing split: command
 * or tool item durations are `tool_ms`, and the remaining wall time is
 * `model_ms`. The real codex stream carries no timestamps, so the same split
 * falls back to line arrival times. A stream with tool items but no measurable
 * pair reports both as null.
 */

import type { NormalisedUsage } from "../types.js";
import type { ParsedRun, RunParser, TargetAdapter } from "./index.js";
import {
  arrivalTiming,
  durationMs,
  elapsedMs,
  eventTimestampMs,
  finaliseTiming,
  isRecord,
  timestampMs,
} from "./timing.js";
import type { TimingTotals } from "./timing.js";

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const COMPLETION_TS_KEYS = [
  "ts",
  "timestamp",
  "time",
  "end_ts",
  "completed_at",
  "completedAt",
] as const;

function itemType(item: Record<string, unknown>): string {
  const value = item["type"];
  return typeof value === "string" ? value : "";
}

/** Item types whose start/end interval counts as tool (not model) time. */
function isToolItem(type: string): boolean {
  const lower = type.toLowerCase();
  return (
    lower.includes("tool") ||
    lower.includes("command") ||
    lower.includes("mcp") ||
    lower.includes("patch")
  );
}

function itemId(item: Record<string, unknown>): string | null {
  for (const key of ["id", "item_id", "itemId"]) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function createCodexParser(): RunParser {
  let usage: NormalisedUsage = { input: 0, cached_input: 0, output: 0, reasoning: 0 };
  let usageRaw: Record<string, unknown> = {};
  let finalText: string | null = null;
  let sessionId: string | null = null;
  let toolCalls = 0;
  let completed = false;

  // Explicit stream timestamps are preferred when an item pair has both ends.
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let timingKnown = false;
  let explicitToolMs = 0;
  let explicitToolPairs = 0;
  const explicitStarts = new Map<string, number>();
  const explicitStartsByType = new Map<string, number[]>();

  // Arrival fallback for the real `codex exec --json` stream (no timestamps).
  let arrivalToolMs = 0;
  let arrivalToolPairs = 0;
  let toolItems = 0;
  const arrivalStarts = new Map<string, number>();
  const arrivalStartsByType = new Map<string, number[]>();

  const noteTimestamp = (ts: number | null): void => {
    if (ts === null) return;
    timingKnown = true;
    if (firstTs === null) firstTs = ts;
    lastTs = ts;
  };

  const takeStart = (
    value: Record<string, unknown>,
    byId: Map<string, number>,
    byType: Map<string, number[]>,
  ): number | null => {
    const id = itemId(value);
    if (id !== null) {
      const start = byId.get(id);
      if (start !== undefined) {
        byId.delete(id);
        return start;
      }
    }
    const type = itemType(value);
    const queue = byType.get(type);
    if (queue === undefined || queue.length === 0) return null;
    const start = queue.shift();
    if (start === undefined) return null;
    if (queue.length === 0) byType.delete(type);
    return start;
  };

  const storeStart = (
    value: Record<string, unknown>,
    at: number,
    byId: Map<string, number>,
    byType: Map<string, number[]>,
  ): void => {
    const id = itemId(value);
    if (id !== null) {
      byId.set(id, at);
      return;
    }
    const type = itemType(value);
    const queue = byType.get(type) ?? [];
    queue.push(at);
    byType.set(type, queue);
  };

  const arrivalMs = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  return {
    onLine(obj: unknown, arrivedAtMs?: number): void {
      if (!isRecord(obj)) return;
      const arrival = arrivalMs(arrivedAtMs);

      switch (obj["type"]) {
        case "thread.started": {
          const id = obj["thread_id"];
          if (typeof id === "string" && id.length > 0) sessionId = id;
          return;
        }
        case "item.started": {
          const item = obj["item"];
          if (!isRecord(item)) return;
          const ts = eventTimestampMs(obj);
          noteTimestamp(ts);
          if (!isToolItem(itemType(item))) return;
          if (ts !== null) {
            storeStart(item, ts, explicitStarts, explicitStartsByType);
          }
          if (arrival !== null) {
            storeStart(item, arrival, arrivalStarts, arrivalStartsByType);
          }
          return;
        }
        case "item.completed": {
          const item = obj["item"];
          if (!isRecord(item)) return;
          const ts = eventTimestampMs(obj, COMPLETION_TS_KEYS);
          noteTimestamp(ts);
          const type = itemType(item);
          const toolItem = type !== "agent_message";

          if (toolItem) {
            toolCalls += 1;
          } else {
            const text = item["text"];
            if (typeof text === "string") finalText = text;
            return;
          }

          if (!isToolItem(type)) return;
          toolItems += 1;

          const explicit =
            durationMs(item) ?? (obj["item"] === item ? durationMs(obj) : null);
          const explicitStart = takeStart(item, explicitStarts, explicitStartsByType);
          const ownStart = timestampMs(item["started_at"] ?? item["startedAt"]);
          const explicitDuration = explicit ?? elapsedMs(explicitStart ?? ownStart, ts);
          if (explicitDuration !== null) {
            explicitToolMs += explicitDuration;
            explicitToolPairs += 1;
          }

          const arrivalStart = takeStart(item, arrivalStarts, arrivalStartsByType);
          const arrivalDuration = elapsedMs(arrivalStart, arrival);
          if (arrivalDuration !== null) {
            arrivalToolMs += arrivalDuration;
            arrivalToolPairs += 1;
          }
          return;
        }
        case "turn.completed": {
          const raw = obj["usage"];
          if (isRecord(raw)) {
            usageRaw = raw;
            const input = numberField(raw, "input_tokens");
            const cached = numberField(raw, "cached_input_tokens");
            usage = {
              // `cached_input_tokens` is a subset of `input_tokens` (S2).
              input: Math.max(0, input - cached),
              cached_input: cached,
              output: numberField(raw, "output_tokens"),
              reasoning: numberField(raw, "reasoning_output_tokens"),
            };
          }
          completed = true;
          return;
        }
        default:
          return;
      }
    },

    result(wallMs?: number): ParsedRun {
      const span = firstTs !== null && lastTs !== null ? Math.max(0, lastTs - firstTs) : null;
      const wall = wallMs ?? null;

      let timing: TimingTotals;
      if (timingKnown && explicitToolPairs > 0) {
        timing = finaliseTiming(true, explicitToolMs, null, wall, span);
      } else if (toolItems === 0) {
        timing = arrivalTiming(0, wall);
      } else if (arrivalToolPairs > 0) {
        timing = arrivalTiming(arrivalToolMs, wall);
      } else {
        timing = { model_ms: null, tool_ms: null };
      }

      return {
        usage,
        usage_raw: usageRaw,
        final_text: finalText,
        target_session_id: sessionId,
        tool_calls: toolCalls,
        completed,
        model: null,
        model_ms: timing.model_ms,
        tool_ms: timing.tool_ms,
      };
    },
  };
}

export function buildCodexArgv(command: string[], ctx: { outputFile: string }): string[] {
  return command.map((arg) => arg.split("{output_file}").join(ctx.outputFile));
}

export const codexAdapter: TargetAdapter = {
  name: "codex",
  buildArgv: buildCodexArgv,
  createParser: createCodexParser,
};
