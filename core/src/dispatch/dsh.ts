/**
 * `dsh --profile headless --json` adapter (spec S4–S6).
 *
 * dsh reports usage per step; the run total is the sum over `step_end`
 * (S4). `inputTokens` excludes cache reads, which arrive separately as
 * `cacheReadTokens` (S6). `cacheWriteTokens` has no normalised slot and is
 * retained in `usage_raw`.
 */

import type { NormalisedUsage } from "../types.js";
import type { ParsedRun, RunParser, TargetAdapter } from "./index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

  return {
    onLine(obj: unknown): void {
      if (!isRecord(obj)) return;

      switch (obj["type"]) {
        case "session": {
          const id = obj["sessionId"];
          if (typeof id === "string" && id.length > 0) sessionId = id;
          return;
        }
        case "status": {
          if (obj["phase"] !== "step_end") return;
          const usage = obj["usage"];
          if (!isRecord(usage)) return;
          steps.push(usage);
          input += numberField(usage, "inputTokens");
          cachedInput += numberField(usage, "cacheReadTokens");
          output += numberField(usage, "outputTokens");
          return;
        }
        case "tool_call": {
          toolCalls += 1;
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

    result(): ParsedRun {
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
