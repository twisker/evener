/**
 * Lifecycle CLI commands (spec §8, §11): accept, next, close, feedback,
 * override, sweep. All event construction lives in `../lifecycle.ts`; this
 * module only parses arguments and appends the returned events atomically.
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultPolicy, loadEffectivePolicy } from "../config.js";
import {
  accept as acceptLifecycle,
  applyRedispatch,
  close as closeLifecycle,
  decideNext,
  feedback as feedbackLifecycle,
  LifecycleError,
  override as overrideLifecycle,
  parseChecks,
  sweep as sweepLifecycle,
} from "../lifecycle.js";
import { OUTCOMES, RATINGS, REJECT_REASONS, REVIEW_VERDICTS, VERDICTS } from "../types.js";
import type { Store } from "../store.js";
import type {
  EvenerEvent,
  Outcome,
  Policy,
  Rating,
  RejectReason,
  ReviewVerdict,
  TaskRow,
  Verdict,
} from "../types.js";
import { CommandError } from "./types.js";
import type { CommandContext, CommandRegistry } from "./types.js";

// ---------------------------------------------------------------------------
// parseArgs helpers
// ---------------------------------------------------------------------------

type OptionValue = string | boolean | string[] | undefined;

function stringOption(value: OptionValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOptions(value: OptionValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function requiredOption(values: Record<string, OptionValue>, key: string): string {
  const value = stringOption(values[key]);
  if (value === undefined || value.length === 0) {
    throw new CommandError("invalid_arguments", `--${key} is required`);
  }
  return value;
}

function enumOption<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new CommandError(
      "invalid_arguments",
      `--${flag} must be one of: ${allowed.join(", ")}`,
    );
  }
  return raw as T;
}

function requiredEnumOption<T extends string>(
  values: Record<string, OptionValue>,
  key: string,
  allowed: readonly T[],
): T {
  const raw = requiredOption(values, key);
  const value = enumOption(raw, allowed, key);
  if (value === undefined) {
    throw new CommandError("invalid_arguments", `--${key} is required`);
  }
  return value;
}

function numberOption(
  raw: string | undefined,
  flag: string,
  integer = false,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new CommandError(
      "invalid_arguments",
      `--${flag} must be a non-negative${integer ? " integer" : " number"}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

function loadTask(ctx: CommandContext, taskId: string): TaskRow {
  const task = ctx.store().getTask(taskId);
  if (task === null) {
    throw new CommandError("task_not_found", `task not found: ${taskId}`);
  }
  return task;
}

function policyForTask(ctx: CommandContext, task: TaskRow): Policy {
  if (!existsSync(ctx.policyPath)) return defaultPolicy();
  return loadEffectivePolicy(ctx.home, task.arm === null ? {} : { arm: task.arm }).policy;
}

function lifecycle<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof LifecycleError) {
      throw new CommandError(err.code, err.message);
    }
    throw err;
  }
}

function appendEvents(store: Store, events: readonly EvenerEvent[]): void {
  if (events.length === 0) return;
  store.withTransaction(() => {
    for (const event of events) store.appendEvent(event);
  });
}

// ---------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------

async function cmdAccept(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      verdict: { type: "string" },
      reason: { type: "string" },
      check: { type: "string", multiple: true },
      review: { type: "string" },
      "reviewer-cost-usd": { type: "string" },
      "reviewer-wall-ms": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const taskId = requiredOption(values, "task");
  const verdict = requiredEnumOption<Verdict>(values, "verdict", VERDICTS);
  const reason = enumOption<RejectReason>(
    stringOption(values["reason"]),
    REJECT_REASONS,
    "reason",
  );
  const review = enumOption<ReviewVerdict>(
    stringOption(values["review"]),
    REVIEW_VERDICTS,
    "review",
  );
  const checks = lifecycle(() => parseChecks(stringOptions(values["check"])));
  const reviewerCostUsd = numberOption(
    stringOption(values["reviewer-cost-usd"]),
    "reviewer-cost-usd",
  );
  const reviewerWallMs = numberOption(
    stringOption(values["reviewer-wall-ms"]),
    "reviewer-wall-ms",
    true,
  );

  const store = ctx.store();
  const task = loadTask(ctx, taskId);
  const policy = policyForTask(ctx, task);
  const result = lifecycle(() =>
    acceptLifecycle(store, policy, task, new Date(), {
      verdict,
      ...(reason === undefined ? {} : { reason }),
      checks,
      ...(review === undefined ? {} : { review }),
      ...(reviewerCostUsd === undefined ? {} : { reviewerCostUsd }),
      ...(reviewerWallMs === undefined ? {} : { reviewerWallMs }),
    }),
  );
  appendEvents(store, result.events);
  return result.output;
}

// ---------------------------------------------------------------------------
// next
// ---------------------------------------------------------------------------

async function cmdNext(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const taskId = requiredOption(values, "task");
  const store = ctx.store();
  const task = loadTask(ctx, taskId);
  const policy = policyForTask(ctx, task);
  const now = new Date();
  const decision = lifecycle(() => decideNext(store, policy, task, now));

  if (decision.action === "redispatch" && values["dry-run"] !== true) {
    const applied = lifecycle(() => applyRedispatch(store, policy, task, now, decision));
    appendEvents(store, applied.events);
  }

  if (decision.action === "close") {
    return {
      task_id: taskId,
      action: "close",
      outcome: decision.outcome,
      why: "last acceptance accepted",
    };
  }
  if (decision.action === "hand_to_human") {
    return { task_id: taskId, action: "hand_to_human", why: decision.why };
  }
  return {
    task_id: taskId,
    action: "redispatch",
    kind: decision.kind,
    next_target: decision.next_target,
    round: decision.round,
    why: decision.why,
  };
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

async function cmdClose(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      outcome: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const taskId = requiredOption(values, "task");
  const outcome = requiredEnumOption<Outcome>(values, "outcome", OUTCOMES);
  const store = ctx.store();
  const task = loadTask(ctx, taskId);
  const policy = policyForTask(ctx, task);
  const result = lifecycle(() =>
    closeLifecycle(store, policy, task, new Date(), outcome),
  );
  appendEvents(store, result.events);
  return result.output;
}

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

async function cmdFeedback(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      rating: { type: "string" },
      comment: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const taskId = requiredOption(values, "task");
  const rating = requiredEnumOption<Rating>(values, "rating", RATINGS);
  const comment = stringOption(values["comment"]);
  const store = ctx.store();
  const task = loadTask(ctx, taskId);
  const policy = policyForTask(ctx, task);
  const result = lifecycle(() =>
    feedbackLifecycle(store, policy, task, new Date(), {
      rating,
      ...(comment === undefined ? {} : { comment }),
    }),
  );
  appendEvents(store, result.events);
  return result.output;
}

// ---------------------------------------------------------------------------
// override
// ---------------------------------------------------------------------------

async function cmdOverride(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      to: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const taskId = requiredOption(values, "task");
  const to = requiredOption(values, "to");
  const store = ctx.store();
  const task = loadTask(ctx, taskId);
  const policy = policyForTask(ctx, task);
  const result = lifecycle(() =>
    overrideLifecycle(store, policy, task, new Date(), { to }),
  );
  appendEvents(store, result.events);
  return result.output;
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

async function cmdSweep(ctx: CommandContext, argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "host-session": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const hostSessionId = requiredOption(values, "host-session");
  const store = ctx.store();
  const policy = existsSync(ctx.policyPath)
    ? loadEffectivePolicy(ctx.home).policy
    : defaultPolicy();
  const result = lifecycle(() =>
    sweepLifecycle(store, policy, hostSessionId, new Date()),
  );
  appendEvents(store, result.events);
  return result.output;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(commands: CommandRegistry): void {
  commands["accept"] = cmdAccept;
  commands["next"] = cmdNext;
  commands["close"] = cmdClose;
  commands["feedback"] = cmdFeedback;
  commands["override"] = cmdOverride;
  commands["sweep"] = cmdSweep;
}
