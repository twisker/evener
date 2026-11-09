/**
 * `dsh --profile headless --json` adapter (spec S4–S6).
 *
 * dsh reports usage per step; the run total is the sum over `step_end`
 * (S4). `inputTokens` excludes cache reads, which arrive separately as
 * `cacheReadTokens` (S6). `cacheWriteTokens` has no normalised slot and is
 * retained in `usage_raw`.
 *
 * Timing prefers explicit `step_start` / `step_end` timestamps (or an explicit
 * step duration) and `tool_call` / `tool_result` pairs that both carry a
 * timestamp. The real dsh stream has no `ts`, so those pairs and the model/tool
 * split fall back to line arrival times. A stream with tool calls but no
 * measurable pair reports both timing fields as null.
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
} from "./timing.js";
import type { TimingTotals } from "./timing.js";

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stepKey(obj: Record<string, unknown>): string {
  return `${String(obj["turn"] ?? "")}:${String(obj["step"] ?? "")}`;
}

function toolKey(obj: Record<string, unknown>): string | null {
  for (const key of ["id", "toolCallId", "tool_call_id", "callId"]) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function toolName(obj: Record<string, unknown>): string {
  const value = obj["name"];
  return typeof value === "string" ? value : "";
}

export function createDshParser(): RunParser {
  const steps: Record<string, unknown>[] = [];
  let input = 0;
  let cachedInput = 0;
  let output = 0;
  let finalText: string | null = null;
  let sessionId: string | null = null;
  let toolCalls = 0;
  let completed = false;

  // Explicit stream timestamps, preferred whenever a pair carries both ends.
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let timingKnown = false;
  let modelMsRaw = 0;
  let modelTimeSeen = false;
  let explicitToolMs = 0;
  let explicitToolPairs = 0;
  const stepStarts = new Map<string, number>();
  const explicitToolStarts = new Map<string, number>();
  const explicitToolStartQueues = new Map<string, number[]>();

  // Arrival fallback for streams without timestamps (the real dsh output).
  let arrivalToolMs = 0;
  let arrivalToolPairs = 0;
  const arrivalToolStarts = new Map<string, number>();
  const arrivalToolStartQueues = new Map<string, number[]>();

  const noteTimestamp = (ts: number | null): void => {
    if (ts === null) return;
    timingKnown = true;
    if (firstTs === null) firstTs = ts;
    lastTs = ts;
  };

  const takeQueuedStart = (
    obj: Record<string, unknown>,
    byId: Map<string, number>,
    byName: Map<string, number[]>,
  ): number | null => {
    const id = toolKey(obj);
    if (id !== null) {
      const start = byId.get(id);
      if (start !== undefined) {
        byId.delete(id);
        return start;
      }
    }
    const name = toolName(obj);
    const queue = byName.get(name);
    if (queue === undefined || queue.length === 0) return null;
    const start = queue.shift();
    if (start === undefined) return null;
    if (queue.length === 0) byName.delete(name);
    return start;
  };

  const storeStart = (
    obj: Record<string, unknown>,
    value: number,
    byId: Map<string, number>,
    byName: Map<string, number[]>,
  ): void => {
    const id = toolKey(obj);
    if (id !== null) {
      byId.set(id, value);
      return;
    }
    const name = toolName(obj);
    const queue = byName.get(name) ?? [];
    queue.push(value);
    byName.set(name, queue);
  };

  const arrivalMs = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  return {
    onLine(obj: unknown, arrivedAtMs?: number): void {
      if (!isRecord(obj)) return;
      const arrival = arrivalMs(arrivedAtMs);

      switch (obj["type"]) {
        case "session": {
          const id = obj["sessionId"];
          if (typeof id === "string" && id.length > 0) sessionId = id;
          return;
        }
        case "status": {
          const phase = obj["phase"];
          if (phase === "step_start") {
            const ts = eventTimestampMs(obj);
            noteTimestamp(ts);
            if (ts !== null) stepStarts.set(stepKey(obj), ts);
            return;
          }
          if (phase !== "step_end") return;

          const ts = eventTimestampMs(obj);
          noteTimestamp(ts);
          const usage = obj["usage"];
          if (isRecord(usage)) {
            steps.push(usage);
            input += numberField(usage, "inputTokens");
            cachedInput += numberField(usage, "cacheReadTokens");
            output += numberField(usage, "outputTokens");
          }

          const explicit = durationMs(obj);
          const start = stepStarts.get(stepKey(obj));
          const duration = explicit ?? elapsedMs(start ?? null, ts);
          if (duration !== null) {
            modelMsRaw += duration;
            modelTimeSeen = true;
          }
          stepStarts.delete(stepKey(obj));
          return;
        }
        case "tool_call": {
          toolCalls += 1;
          const ts = eventTimestampMs(obj);
          noteTimestamp(ts);
          if (ts !== null) {
            storeStart(obj, ts, explicitToolStarts, explicitToolStartQueues);
          }
          if (arrival !== null) {
            storeStart(obj, arrival, arrivalToolStarts, arrivalToolStartQueues);
          }
          return;
        }
        case "tool_result": {
          const ts = eventTimestampMs(obj);
          noteTimestamp(ts);

          const explicitStart = takeQueuedStart(
            obj,
            explicitToolStarts,
            explicitToolStartQueues,
          );
          const explicitDuration = elapsedMs(explicitStart, ts);
          if (explicitDuration !== null) {
            explicitToolMs += explicitDuration;
            explicitToolPairs += 1;
          }

          const arrivalStart = takeQueuedStart(
            obj,
            arrivalToolStarts,
            arrivalToolStartQueues,
          );
          const arrivalDuration = elapsedMs(arrivalStart, arrival);
          if (arrivalDuration !== null) {
            arrivalToolMs += arrivalDuration;
            arrivalToolPairs += 1;
          }
          return;
        }
        case "final": {
          const id = obj["sessionId"];
          if (typeof id === "string" && id.length > 0) sessionId = id;
          const text = obj["text"];
          if (typeof text === "string") finalText = text;
          const reason = obj["reason"];
          completed = isRecord(reason) && reason["kind"] === "completed";
          return;
        }
        case "error": {
          completed = false;
          return;
        }
        default:
          return;
      }
    },

    result(wallMs?: number): ParsedRun {
      const span = firstTs !== null && lastTs !== null ? Math.max(0, lastTs - firstTs) : null;
      const wall = wallMs ?? null;

      // Prefer explicit timestamps. When the stream supplied none for a usable
      // pair, fall back to the arrival times recorded by runJsonlProcess.
      let timing: TimingTotals;
      if (timingKnown && (modelTimeSeen || explicitToolPairs > 0)) {
        timing = finaliseTiming(
          true,
          explicitToolMs,
          modelTimeSeen ? modelMsRaw : null,
          wall,
          span,
        );
      } else if (toolCalls === 0) {
        timing = arrivalTiming(0, wall);
      } else if (arrivalToolPairs > 0) {
        timing = arrivalTiming(arrivalToolMs, wall);
      } else {
        timing = { model_ms: null, tool_ms: null };
      }

      return {
        usage: {
          input,
          cached_input: cachedInput,
          output,
          // dsh has no separate reasoning-token count (S4).
          reasoning: 0,
        },
        usage_raw: { steps: [...steps] },
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

export function buildDshArgv(command: string[], ctx: { outputFile: string }): string[] {
  return command.map((arg) => arg.split("{output_file}").join(ctx.outputFile));
}

export const dshAdapter: TargetAdapter = {
  name: "dsh",
  buildArgv: buildDshArgv,
  createParser: createDshParser,
};
