/**
 * `codex exec --json` adapter (spec S1–S3).
 *
 * Success is `exit 0 && turn.completed seen`. `turn.completed.usage` is
 * cumulative for the thread (S1); a fresh `codex exec` per round therefore
 * needs no adjustment here, the last reported value is the round's usage.
 *
 * `item.started` / `item.completed` timestamps give the timing split: command
 * or tool item durations are `tool_ms`, and the remaining wall time is
 * `model_ms`. Streams without item timestamps report both as null.
 */

import type { NormalisedUsage } from "../types.js";
import type { ParsedRun, RunParser, TargetAdapter } from "./index.js";
import {
  durationMs,
  elapsedMs,
  eventTimestampMs,
  finaliseTiming,
  isRecord,
  timestampMs,
} from "./timing.js";

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

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let timingKnown = false;
  let toolMsRaw = 0;
  const starts = new Map<string, number>();
  const startsByType = new Map<string, number[]>();

  const noteTimestamp = (ts: number | null): void => {
    if (ts === null) return;
    timingKnown = true;
    if (firstTs === null) firstTs = ts;
    lastTs = ts;
  };

  const takeStart = (item: Record<string, unknown>): number | null => {
    const id = itemId(item);
    if (id !== null) {
      const start = starts.get(id);
      if (start !== undefined) {
        starts.delete(id);
        return start;
      }
    }
    const type = itemType(item);
    const queue = startsByType.get(type);
    if (queue === undefined || queue.length === 0) return null;
    const start = queue.shift();
    if (start === undefined) return null;
    if (queue.length === 0) startsByType.delete(type);
    return start;
  };

  return {
    onLine(obj: unknown): void {
      if (!isRecord(obj)) return;

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
          if (ts === null) return;
          if (itemType(item) === "agent_message") return;
          const id = itemId(item);
          if (id !== null) {
            starts.set(id, ts);
          } else {
            const type = itemType(item);
            const queue = startsByType.get(type) ?? [];
            queue.push(ts);
            startsByType.set(type, queue);
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
            const explicit =
              durationMs(item) ?? (obj["item"] === item ? durationMs(obj) : null);
            const start = takeStart(item);
            const ownStart = timestampMs(item["started_at"] ?? item["startedAt"]);
            const duration =
              explicit ?? elapsedMs(start ?? ownStart, ts);
            if (duration !== null) toolMsRaw += duration;
          } else {
            const text = item["text"];
            if (typeof text === "string") finalText = text;
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
      const timing = finaliseTiming(timingKnown, toolMsRaw, null, wallMs ?? null, span);
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
