/**
 * `codex exec --json` adapter (spec S1–S3).
 *
 * Success is `exit 0 && turn.completed seen`. `turn.completed.usage` is
 * cumulative for the thread (S1); a fresh `codex exec` per round therefore
 * needs no adjustment here, the last reported value is the round's usage.
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

export function createCodexParser(): RunParser {
  let usage: NormalisedUsage = { input: 0, cached_input: 0, output: 0, reasoning: 0 };
  let usageRaw: Record<string, unknown> = {};
  let finalText: string | null = null;
  let sessionId: string | null = null;
  let toolCalls = 0;
  let completed = false;

  return {
    onLine(obj: unknown): void {
      if (!isRecord(obj)) return;

      switch (obj["type"]) {
        case "thread.started": {
          const id = obj["thread_id"];
          if (typeof id === "string" && id.length > 0) sessionId = id;
          return;
        }
        case "item.completed": {
          const item = obj["item"];
          if (isRecord(item) && item["type"] === "agent_message") {
            const text = item["text"];
            if (typeof text === "string") finalText = text;
          } else {
            toolCalls += 1;
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

    result(): ParsedRun {
      return {
        usage,
        usage_raw: usageRaw,
        final_text: finalText,
        target_session_id: sessionId,
        tool_calls: toolCalls,
        completed,
        model: null,
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
