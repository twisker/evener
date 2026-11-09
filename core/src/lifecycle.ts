/**
 * Task lifecycle logic (spec §8).
 *
 * Every function here is pure with respect to the store: it reads events and
 * returns the events that the command layer should append plus the JSON object
 * the CLI should print. Keeping the events explicit makes the decision rules
 * testable without opening a second writer.
 */

import {
  CHECK_NAMES,
  CHECK_RESULTS,
  OUTCOMES,
  RATINGS,
  REJECT_REASONS,
  REVIEW_VERDICTS,
  VERDICTS,
} from "./types.js";
import type {
  AcceptanceCheck,
  AcceptanceFinishedPayload,
  CheckName,
  CheckResult,
  ContextDelta,
  EventType,
  EvenerEvent,
  Outcome,
  PayloadByType,
  Policy,
  Rating,
  RejectReason,
  ReviewVerdict,
  RouteDecidedPayload,
  TargetCircuitPayload,
  TaskClosedPayload,
  TaskRedispatchPayload,
  TaskRow,
  UserFeedbackPayload,
  UserOverridePayload,
  Verdict,
} from "./types.js";
import type { Store } from "./store.js";
import { uuid } from "./util.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Error raised by lifecycle rules; the command layer maps it to a CLI error. */
export class LifecycleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
  }
}

/** Timestamps may be supplied by callers/tests as a Date or an ISO string. */
export type LifecycleNow = Date | string;

export interface LifecycleOutcome<T> {
  /** Events to append, in order. */
  events: EvenerEvent[];
  /** Object the CLI prints. */
  output: T;
}

export interface AcceptArgs {
  verdict: Verdict;
  reason?: RejectReason | null;
  checks?: AcceptanceCheck[];
  review?: ReviewVerdict;
  reviewerCostUsd?: number;
  reviewerWallMs?: number;
}

export interface AcceptOutput {
  task_id: string;
  round: number;
  verdict: Verdict;
}

export type NextDecision =
  | { action: "close"; outcome: "accepted" }
  | { action: "hand_to_human"; why: string }
  | {
      action: "redispatch";
      kind: "retry" | "escalate";
      next_target: string;
      round: number;
      why: string;
    };

export interface RedispatchOptions {
  contextDelta?: ContextDelta;
}

export interface RedispatchOutput {
  task_id: string;
  round: number;
  next_target: string;
  kind: "retry" | "escalate";
}

export interface CloseOutput {
  task_id: string;
  outcome: Outcome;
  total_rounds: number;
  total_cost_usd: number;
  total_wall_ms: number;
}

export interface FeedbackArgs {
  rating: Rating;
  comment?: string | null;
}

export interface FeedbackOutput {
  task_id: string;
}

export interface OverrideArgs {
  to: string;
}

export interface OverrideOutput {
  task_id: string;
  from: string;
  to: string;
}

export interface SweepOutput {
  closed: string[];
}

export interface TaskTotals {
  total_rounds: number;
  total_cost_usd: number;
  total_wall_ms: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function iso(now: LifecycleNow): string {
  return typeof now === "string" ? now : now.toISOString();
}

function makeEvent<K extends EventType>(
  task: TaskRow,
  now: LifecycleNow,
  type: K,
  round: number,
  data: PayloadByType[K],
): EvenerEvent {
  const event = {
    event_id: uuid(),
    task_id: task.task_id,
    round,
    ts: iso(now),
    type,
    host: task.host,
    host_session_id: task.host_session_id,
    policy_version: task.policy_version,
    schema_version: 1,
    data,
  };
  return event as EvenerEvent;
}

function lastAcceptance(
  events: readonly EvenerEvent[],
): (EvenerEvent & { type: "acceptance.finished" }) | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.type === "acceptance.finished") {
      return event as EvenerEvent & { type: "acceptance.finished" };
    }
  }
  return null;
}

function maxRound(events: readonly EvenerEvent[], fallback: number): number {
  let round = fallback;
  for (const event of events) {
    if (event.round > round) round = event.round;
  }
  return round;
}

/**
 * Target that handled each round.
 *
 * `route.decided` and `task.redispatch` are both emitted with the round they
 * start, so either one identifies the dispatched target. The last event wins
 * when both are present (they agree in normal logs).
 */
function dispatchedTargets(events: readonly EvenerEvent[]): Map<number, string> {
  const targets = new Map<number, string>();
  for (const event of events) {
    if (event.type === "route.decided") {
      targets.set(event.round, event.data.target);
    } else if (event.type === "task.redispatch") {
      targets.set(event.round, event.data.next_target);
    }
  }
  return targets;
}

function checkedNumber(value: number, name: string, integer = false): number {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new LifecycleError(
      "invalid_arguments",
      `${name} must be a non-negative${integer ? " integer" : " number"}`,
    );
  }
  return value;
}

/** Parse one `--check name=result` argument. */
export function parseCheck(spec: string): AcceptanceCheck {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new LifecycleError("invalid_arguments", `invalid --check "${spec}" (expected name=result)`);
  }
  const name = spec.slice(0, separator);
  const result = spec.slice(separator + 1);
  if (!(CHECK_NAMES as readonly string[]).includes(name)) {
    throw new LifecycleError(
      "invalid_arguments",
      `invalid check name "${name}"; expected one of: ${CHECK_NAMES.join(", ")}`,
    );
  }
  if (!(CHECK_RESULTS as readonly string[]).includes(result)) {
    throw new LifecycleError(
      "invalid_arguments",
      `invalid check result "${result}"; expected one of: ${CHECK_RESULTS.join(", ")}`,
    );
  }
  return { name: name as CheckName, result: result as CheckResult };
}

export function parseChecks(specs: readonly string[]): AcceptanceCheck[] {
  return specs.map(parseCheck);
}

/** Sum costs and wall time over the event log (spec §8, `close`). */
export function computeTotals(
  events: readonly EvenerEvent[],
  fallbackRound = 1,
): TaskTotals {
  let totalCost = 0;
  let totalWall = 0;
  let totalRounds = fallbackRound;

  for (const event of events) {
    if (event.round > totalRounds) totalRounds = event.round;
    switch (event.type) {
      case "dispatch.finished":
        totalCost += event.data.cost_usd;
        totalWall += event.data.wall_ms;
        break;
      case "acceptance.finished":
        totalCost += event.data.reviewer_cost_usd;
        totalWall += event.data.reviewer_wall_ms;
        break;
      case "route.decided":
        totalCost += event.data.classifier_cost_usd ?? 0;
        break;
      case "task.created":
        totalCost += event.data.labeler_cost_usd ?? 0;
        break;
      default:
        break;
    }
  }

  return {
    total_rounds: totalRounds,
    total_cost_usd: totalCost,
    total_wall_ms: totalWall,
  };
}

function enabledTargets(store: Store, policy: Policy, now: LifecycleNow): Set<string> {
  const open = openCircuits(store, now);
  const enabled = new Set<string>();
  for (const [name, target] of Object.entries(policy.targets)) {
    if (target.enabled && !open.has(name)) enabled.add(name);
  }
  return enabled;
}

/**
 * Targets with an open circuit at `now`.
 *
 * The router (T3) exports the same helper; this local copy keeps lifecycle
 * usable on the T2 baseline where `router.ts` does not exist yet.
 */
export function openCircuits(store: Store, now: LifecycleNow): Set<string> {
  const latest = new Map<string, TargetCircuitPayload>();
  for (const event of store.listEvents({ types: ["target.circuit"] })) {
    if (event.type !== "target.circuit") continue;
    latest.set(event.data.target, event.data);
  }

  const nowMs = Date.parse(typeof now === "string" ? now : now.toISOString());
  const open = new Set<string>();
  for (const [target, payload] of latest) {
    if (payload.state !== "open" || payload.until === null) continue;
    const untilMs = Date.parse(payload.until);
    if (Number.isFinite(untilMs) && untilMs > nowMs) open.add(target);
  }
  return open;
}

/**
 * First enabled target after `current` in the escalation chain.
 *
 * Targets not present in the chain escalate to the first enabled chain entry;
 * at the end of the chain the result is null (chain exhausted).
 */
export function nextInChain(
  chain: readonly string[],
  current: string | null,
  enabled: Set<string>,
): string | null {
  const start = current === null ? 0 : chain.indexOf(current) + 1;
  for (let index = Math.max(start, 0); index < chain.length; index += 1) {
    const target = chain[index];
    if (target !== undefined && enabled.has(target)) return target;
  }
  return null;
}

// ---------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------

export function accept(
  store: Store,
  _policy: Policy,
  task: TaskRow,
  now: LifecycleNow,
  args: AcceptArgs,
): LifecycleOutcome<AcceptOutput> {
  const current = store.getTask(task.task_id) ?? task;
  if (current.state !== "awaiting_acceptance") {
    throw new LifecycleError(
      "invalid_state",
      `cannot accept task in state "${current.state}" (expected awaiting_acceptance)`,
    );
  }
  if (!(VERDICTS as readonly string[]).includes(args.verdict)) {
    throw new LifecycleError("invalid_arguments", `invalid verdict "${String(args.verdict)}"`);
  }

  const reason = args.reason ?? null;
  if (reason !== null && !(REJECT_REASONS as readonly string[]).includes(reason)) {
    throw new LifecycleError("invalid_arguments", `invalid reject reason "${reason}"`);
  }
  if (args.verdict === "rejected" && reason === null) {
    throw new LifecycleError("reason_required", "--reason is required when the verdict is rejected");
  }

  const review = args.review ?? "skipped";
  if (!(REVIEW_VERDICTS as readonly string[]).includes(review)) {
    throw new LifecycleError("invalid_arguments", `invalid review verdict "${review}"`);
  }

  const checks = args.checks ?? [];
  for (const check of checks) {
    if (!(CHECK_NAMES as readonly string[]).includes(check.name)) {
      throw new LifecycleError("invalid_arguments", `invalid check name "${check.name}"`);
    }
    if (!(CHECK_RESULTS as readonly string[]).includes(check.result)) {
      throw new LifecycleError("invalid_arguments", `invalid check result "${check.result}"`);
    }
  }

  const reviewerCost = checkedNumber(args.reviewerCostUsd ?? 0, "reviewer cost");
  const reviewerWall = checkedNumber(args.reviewerWallMs ?? 0, "reviewer wall", true);

  const data: AcceptanceFinishedPayload = {
    verdict: args.verdict,
    checks,
    review_verdict: review,
    reject_reason: args.verdict === "rejected" ? reason : null,
    reviewer_cost_usd: reviewerCost,
    reviewer_wall_ms: reviewerWall,
  };

  const round = current.current_round;
  return {
    events: [makeEvent(current, now, "acceptance.finished", round, data)],
    output: { task_id: current.task_id, round, verdict: args.verdict },
  };
}

// ---------------------------------------------------------------------------
// next
// ---------------------------------------------------------------------------

export function decideNext(
  store: Store,
  policy: Policy,
  task: TaskRow,
  now: LifecycleNow,
): NextDecision {
  const events = store.getEvents(task.task_id);
  const currentTask = store.getTask(task.task_id) ?? task;
  const acceptance = lastAcceptance(events);
  if (acceptance === null) {
    throw new LifecycleError("no_acceptance", "task has no acceptance.finished event");
  }

  if (acceptance.data.verdict === "accepted") {
    return { action: "close", outcome: "accepted" };
  }

  const rounds = maxRound(events, currentTask.current_round);
  if (rounds >= policy.limits.max_rounds_per_task) {
    return {
      action: "hand_to_human",
      why: `max_rounds_per_task reached (${rounds} >= ${policy.limits.max_rounds_per_task})`,
    };
  }

  const totals = computeTotals(events, currentTask.current_round);
  if (totals.total_cost_usd >= policy.limits.max_cost_per_task_usd) {
    return {
      action: "hand_to_human",
      why: `max_cost_per_task_usd exceeded (${totals.total_cost_usd} >= ${policy.limits.max_cost_per_task_usd})`,
    };
  }

  const current = currentTask.current_target;
  if (current === null) {
    return { action: "hand_to_human", why: "task has no current target" };
  }
  if (current === "host") {
    return { action: "hand_to_human", why: "current target is host" };
  }

  const reason: RejectReason = acceptance.data.reject_reason ?? "other";
  const enabled = enabledTargets(store, policy, now);
  const retryUsed = events.some(
    (event) =>
      event.type === "task.redispatch" &&
      event.data.kind === "retry" &&
      event.data.next_target === current,
  );
  const dispatchedTargetsByRound = dispatchedTargets(events);
  const sameReasonCount = events.filter(
    (event) =>
      event.type === "acceptance.finished" &&
      event.data.verdict === "rejected" &&
      (event.data.reject_reason ?? "other") === reason &&
      dispatchedTargetsByRound.get(event.round) === current,
  ).length;

  const forceEscalate =
    sameReasonCount >= policy.escalation.force_escalate_after_same_reason;
  const escalateOnReason = policy.escalation.escalate_on_reasons.includes(reason);
  const neverEscalate = policy.escalation.never_escalate_on.includes(reason);
  const canRetry =
    policy.escalation.retry_same_target_once && !retryUsed && enabled.has(current);

  const retry = (why: string): NextDecision => ({
    action: "redispatch",
    kind: "retry",
    next_target: current,
    round: rounds + 1,
    why,
  });

  if (!forceEscalate && (neverEscalate || !escalateOnReason) && canRetry) {
    return retry(`retry ${current} (${reason})`);
  }

  const next = nextInChain(policy.escalation.chain, current, enabled);
  if (next === null) {
    return { action: "hand_to_human", why: "escalation chain exhausted" };
  }

  let why: string;
  if (forceEscalate) {
    why = `force escalate after ${sameReasonCount} x ${reason}`;
  } else if (escalateOnReason) {
    why = `escalate on ${reason}`;
  } else if (!policy.escalation.retry_same_target_once) {
    why = "retry_same_target_once is disabled";
  } else if (retryUsed) {
    why = `retry already used for ${current}`;
  } else {
    why = `cannot retry ${current} (disabled or circuit open)`;
  }

  return {
    action: "redispatch",
    kind: "escalate",
    next_target: next,
    round: rounds + 1,
    why,
  };
}

// ---------------------------------------------------------------------------
// applyRedispatch
// ---------------------------------------------------------------------------

export function applyRedispatch(
  store: Store,
  _policy: Policy,
  task: TaskRow,
  now: LifecycleNow,
  decision: Extract<NextDecision, { action: "redispatch" }>,
  options: RedispatchOptions = {},
): LifecycleOutcome<RedispatchOutput> {
  if (decision.action !== "redispatch") {
    throw new LifecycleError("invalid_decision", "applyRedispatch requires a redispatch decision");
  }

  const currentTask = store.getTask(task.task_id) ?? task;
  const events = store.getEvents(task.task_id);
  const acceptance = lastAcceptance(events);
  if (acceptance === null || acceptance.data.verdict !== "rejected") {
    throw new LifecycleError("invalid_state", "redispatch requires a rejected acceptance");
  }

  const reason = acceptance.data.reject_reason ?? "other";
  const round = decision.round;
  const from = currentTask.current_target;

  const redispatch: TaskRedispatchPayload = {
    reason,
    context_delta: options.contextDelta ?? "unchanged",
    next_target: decision.next_target,
    kind: decision.kind,
  };
  const route: RouteDecidedPayload = {
    target: decision.next_target,
    candidates: [{ target: decision.next_target, score: 1 }],
    rationale: decision.why,
    decided_by: "rule",
    rule_id: "escalation",
    classifier_model: null,
    classifier_latency_ms: null,
    classifier_cost_usd: null,
    arm: currentTask.arm,
    escalated_from: from,
  };

  return {
    events: [
      makeEvent(currentTask, now, "task.redispatch", round, redispatch),
      makeEvent(currentTask, now, "route.decided", round, route),
    ],
    output: {
      task_id: currentTask.task_id,
      round,
      next_target: decision.next_target,
      kind: decision.kind,
    },
  };
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

export function close(
  store: Store,
  _policy: Policy,
  task: TaskRow,
  now: LifecycleNow,
  outcome: Outcome,
): LifecycleOutcome<CloseOutput> {
  const current = store.getTask(task.task_id) ?? task;
  if (current.state === "closed") {
    throw new LifecycleError("already_closed", `task ${current.task_id} is already closed`);
  }
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    throw new LifecycleError("invalid_arguments", `invalid outcome "${String(outcome)}"`);
  }

  const events = store.getEvents(task.task_id);
  const totals = computeTotals(events, current.current_round);
  const round = maxRound(events, current.current_round);
  const data: TaskClosedPayload = {
    outcome,
    total_rounds: totals.total_rounds,
    total_cost_usd: totals.total_cost_usd,
    total_wall_ms: totals.total_wall_ms,
  };

  return {
    events: [makeEvent(current, now, "task.closed", round, data)],
    output: {
      task_id: current.task_id,
      outcome,
      total_rounds: totals.total_rounds,
      total_cost_usd: totals.total_cost_usd,
      total_wall_ms: totals.total_wall_ms,
    },
  };
}

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

export function feedback(
  store: Store,
  _policy: Policy,
  task: TaskRow,
  now: LifecycleNow,
  args: FeedbackArgs,
): LifecycleOutcome<FeedbackOutput> {
  if (!(RATINGS as readonly string[]).includes(args.rating)) {
    throw new LifecycleError("invalid_arguments", `invalid rating "${String(args.rating)}"`);
  }
  const data: UserFeedbackPayload = {
    rating: args.rating,
    comment: args.comment ?? null,
  };
  const current = store.getTask(task.task_id) ?? task;
  return {
    events: [makeEvent(current, now, "user.feedback", current.current_round, data)],
    output: { task_id: current.task_id },
  };
}

// ---------------------------------------------------------------------------
// override
// ---------------------------------------------------------------------------

/** Latest route.decided event for the task's current round. */
function currentRoute(
  events: readonly EvenerEvent[],
  round: number,
): (EvenerEvent & { type: "route.decided" }) | null {
  let fallback: (EvenerEvent & { type: "route.decided" }) | null = null;
  let current: (EvenerEvent & { type: "route.decided" }) | null = null;
  for (const event of events) {
    if (event.type !== "route.decided") continue;
    const route = event as EvenerEvent & { type: "route.decided" };
    fallback = route;
    if (event.round === round) current = route;
  }
  return current ?? fallback;
}

export function override(
  store: Store,
  policy: Policy,
  task: TaskRow,
  now: LifecycleNow,
  args: OverrideArgs,
): LifecycleOutcome<OverrideOutput> {
  const current = store.getTask(task.task_id) ?? task;
  const from = current.current_target;
  if (from === null) {
    throw new LifecycleError("not_routed", `task ${current.task_id} has no current target`);
  }
  if (typeof args.to !== "string" || args.to.length === 0) {
    throw new LifecycleError("invalid_arguments", "--to is required");
  }

  const route = currentRoute(store.getEvents(task.task_id), current.current_round);
  if (route !== null && route.data.decided_by === "rule" && route.data.rule_id !== null) {
    const rule = policy.rules.find((candidate) => candidate.id === route.data.rule_id);
    if (rule?.locked === true && args.to !== "host") {
      throw new LifecycleError(
        "locked",
        `rule "${rule.id}" locked this round; only --to host is allowed`,
      );
    }
  }

  const data: UserOverridePayload = { from, to: args.to };
  return {
    events: [makeEvent(current, now, "user.override", current.current_round, data)],
    output: { task_id: current.task_id, from, to: args.to },
  };
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

export function sweep(
  store: Store,
  _policy: Policy,
  hostSessionId: string,
  now: LifecycleNow,
): LifecycleOutcome<SweepOutput> {
  if (typeof hostSessionId !== "string" || hostSessionId.length === 0) {
    throw new LifecycleError("invalid_arguments", "--host-session is required");
  }

  const events: EvenerEvent[] = [];
  const closed: string[] = [];
  for (const task of store.listTasks({ open: true, hostSessionId })) {
    const taskEvents = store.getEvents(task.task_id);
    const totals = computeTotals(taskEvents, task.current_round);
    const data: TaskClosedPayload = {
      outcome: "abandoned",
      total_rounds: totals.total_rounds,
      total_cost_usd: totals.total_cost_usd,
      total_wall_ms: totals.total_wall_ms,
    };
    events.push(
      makeEvent(task, now, "task.closed", maxRound(taskEvents, task.current_round), data),
    );
    closed.push(task.task_id);
  }

  return { events, output: { closed } };
}
