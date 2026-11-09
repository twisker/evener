/**
 * `evener decide --task T [--dry-run]`
 *
 * Loads a created task, resolves its effective policy/arm, runs the router and
 * (unless dry-run) appends the `route.decided` event.
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  defaultPolicy,
  loadEffectivePolicy,
  loadPolicy,
  loadPricing,
  policyVersion,
} from "../config.js";
import type { EffectivePolicy } from "../config.js";
import { assignArm } from "../experiment.js";
import { decide, RouterError } from "../router.js";
import type { RouteDecision } from "../router.js";
import type {
  EvenerEvent,
  Policy,
  Pricing,
  RouteDecidedPayload,
  TaskCreatedPayload,
  TaskRow,
} from "../types.js";
import { nowIso, uuid } from "../util.js";
import { CommandError } from "./types.js";
import type { CommandContext, CommandRegistry } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tests embedders may put a `fetchImpl` on the CLI IO object, mirroring the
 * optional parameter `decide`/`classifyTarget` accept. The real CLI leaves it
 * unset and the transport uses the global `fetch`.
 */
function injectedFetch(ctx: CommandContext): typeof fetch | undefined {
  const value = (ctx.io as { fetchImpl?: unknown }).fetchImpl;
  return typeof value === "function" ? (value as typeof fetch) : undefined;
}

function requiredOption(values: Record<string, string | boolean | undefined>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandError("invalid_arguments", `--${key} is required`);
  }
  return value;
}

/** Load the policy that applies to this task, including its experiment arm. */
function effectivePolicyForTask(ctx: CommandContext, task: TaskRow): EffectivePolicy {
  const top: Policy = existsSync(ctx.policyPath) ? loadPolicy(ctx.policyPath) : defaultPolicy();

  let arm = task.arm;
  if (
    arm === null &&
    task.current_round === 1 &&
    top.experiment.mode !== "off" &&
    Object.keys(top.experiment.arms).length > 0
  ) {
    arm = assignArm(top, task.task_id, task.analysis_label);
  }

  if (arm === null) {
    return { policy: top, policy_version: policyVersion(top), arm: null };
  }
  return loadEffectivePolicy(ctx.home, { arm });
}

/**
 * Pricing is optional for classifier costs: a missing or invalid file degrades
 * to flat list prices instead of failing the command (spec §5).
 */
function optionalPricing(ctx: CommandContext): Pricing | undefined {
  if (!existsSync(ctx.pricingPath)) return undefined;
  try {
    return loadPricing(ctx.pricingPath);
  } catch {
    return undefined;
  }
}

function createdPayload(ctx: CommandContext, task: TaskRow): TaskCreatedPayload {
  const events = ctx.store().getEvents(task.task_id);
  const created = events.find((event) => event.type === "task.created");
  if (created === undefined || created.type !== "task.created") {
    throw new CommandError(
      "invalid_state",
      `task ${task.task_id} has no task.created event`,
    );
  }
  return created.data;
}

function routeEnvelope(
  task: TaskRow,
  policyVersionValue: string,
  round: number,
  ts: string,
  decision: RouteDecision,
): EvenerEvent {
  const data: RouteDecidedPayload = {
    target: decision.target,
    candidates: decision.candidates,
    rationale: decision.rationale,
    decided_by: decision.decided_by,
    rule_id: decision.rule_id,
    classifier_model: decision.classifier_model,
    classifier_latency_ms: decision.classifier_latency_ms,
    classifier_cost_usd: decision.classifier_cost_usd,
    arm: decision.arm,
    escalated_from: decision.escalated_from,
  };

  return {
    event_id: uuid(),
    task_id: task.task_id,
    round,
    ts,
    type: "route.decided",
    host: task.host,
    host_session_id: task.host_session_id,
    policy_version: policyVersionValue,
    schema_version: 1,
    data,
  };
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

async function cmdDecide(ctx: CommandContext, argv: string[]): Promise<unknown> {
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
  const task = store.getTask(taskId);
  if (task === null) {
    throw new CommandError("task_not_found", `task not found: ${taskId}`);
  }

  // Mirror the router's state rule early so the CLI reports `invalid_state`.
  const stateOk =
    task.current_round === 1
      ? task.state === "created"
      : task.state === "awaiting_acceptance";
  if (!stateOk) {
    throw new CommandError(
      "invalid_state",
      `task ${task.task_id} is ${task.state}; decide is only valid from created (round 1) or awaiting_acceptance`,
    );
  }

  const effective = effectivePolicyForTask(ctx, task);
  const created = createdPayload(ctx, task);
  const now = nowIso();

  const fetchImpl = injectedFetch(ctx);
  let decision: RouteDecision;
  try {
    decision = await decide({
      store,
      policy: effective.policy,
      arm: effective.arm,
      task,
      created,
      env: ctx.io.env,
      now,
      pricing: optionalPricing(ctx),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  } catch (err) {
    if (err instanceof RouterError) {
      throw new CommandError(err.code, err.message);
    }
    throw err;
  }

  if (values["dry-run"] !== true) {
    store.appendEvent(
      routeEnvelope(task, effective.policy_version, task.current_round, now, decision),
    );
  }

  return {
    task_id: task.task_id,
    round: task.current_round,
    target: decision.target,
    decided_by: decision.decided_by,
    rule_id: decision.rule_id,
    rationale: decision.rationale,
    candidates: decision.candidates,
    arm: decision.arm,
    locked: decision.locked,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(commands: CommandRegistry): void {
  commands["decide"] = cmdDecide;
}
