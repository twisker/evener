/**
 * Pure projections for the read-only web panel (spec §13).
 *
 * The server only parses query parameters and serialises these values; every
 * number and derived state in the panel comes from this module (the page never
 * computes statistics itself).
 */

import { policyVersion } from "../config.js";
import { roundTarget } from "../report.js";
import {
  DECIDED_BY_VALUES,
  PRICING_PERIODS,
  REDISPATCH_KINDS,
  REJECT_REASONS,
  REVIEW_VERDICTS,
  VERDICTS,
} from "../types.js";
import type {
  CheckResult,
  DecidedBy,
  DispatchStatus,
  EvenerEvent,
  NormalisedUsage,
  Policy,
  PricingPeriod,
  RedispatchKind,
  RejectReason,
  ReviewVerdict,
  TaskRow,
  Verdict,
} from "../types.js";

// ---------------------------------------------------------------------------
// Defensive payload readers
// ---------------------------------------------------------------------------

type Payload = Record<string, unknown>;

function payload(event: EvenerEvent): Payload {
  return event.data as unknown as Payload;
}

function asRecord(value: unknown): Payload | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function usageOf(value: unknown): NormalisedUsage | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    input: numberOrZero(record["input"]),
    cached_input: numberOrZero(record["cached_input"]),
    output: numberOrZero(record["output"]),
    reasoning: numberOrZero(record["reasoning"]),
  };
}

function checksOf(value: unknown): Record<string, CheckResult> {
  const checks: Record<string, CheckResult> = {};
  if (!Array.isArray(value)) return checks;
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const name = stringOrNull(record["name"]);
    const result = oneOf(record["result"], ["pass", "fail", "skipped"] as const);
    if (name !== null && result !== null) checks[name] = result;
  }
  return checks;
}

/** Events may be keyed with a Map (the server) or a plain object (tests). */
export type EventsByTask =
  | ReadonlyMap<string, readonly EvenerEvent[]>
  | Readonly<Record<string, readonly EvenerEvent[]>>;

function eventsFor(
  eventsByTask: EventsByTask,
  taskId: string,
): readonly EvenerEvent[] {
  if (eventsByTask instanceof Map) return eventsByTask.get(taskId) ?? [];
  const byTask = eventsByTask as Readonly<Record<string, readonly EvenerEvent[]>>;
  return byTask[taskId] ?? [];
}

// ---------------------------------------------------------------------------
// TaskSummary
// ---------------------------------------------------------------------------

export interface TaskSummary extends TaskRow {
  current_model: string | null;
  started_ts: string | null;
  running_ms: number | null;
  last_event_type: string;
  last_event_ts: string;
  description_excerpt: string | null;
}

export function taskSummaries(
  tasks: readonly TaskRow[],
  eventsByTask: EventsByTask,
  now: Date,
): TaskSummary[] {
  return tasks.map((task) => {
    const events = eventsFor(eventsByTask, task.task_id);
    let lastEvent: EvenerEvent | undefined;
    let currentModel: string | null = null;
    let startedTs: string | null = null;
    let descriptionExcerpt: string | null = null;

    for (const event of events) {
      lastEvent = event;
      if (event.type === "task.created") {
        descriptionExcerpt = stringOrNull(payload(event)["description_excerpt"]);
      }
      if (event.type === "dispatch.started" && event.round === task.current_round) {
        const data = payload(event);
        currentModel = stringOrNull(data["model"]);
        startedTs = event.ts;
      }
    }

    const startedMs = startedTs === null ? Number.NaN : Date.parse(startedTs);
    const runningMs =
      task.state === "dispatching" && Number.isFinite(startedMs)
        ? Math.max(0, Math.floor(now.getTime() - startedMs))
        : null;

    return {
      ...task,
      current_model: currentModel,
      started_ts: startedTs,
      running_ms: runningMs,
      last_event_type: lastEvent?.type ?? "unknown",
      last_event_ts: lastEvent?.ts ?? task.created_ts,
      description_excerpt: descriptionExcerpt,
    };
  });
}

// ---------------------------------------------------------------------------
// RoundView
// ---------------------------------------------------------------------------

export interface RoundRedispatch {
  kind: RedispatchKind;
  next_target: string;
  reason: string;
}

export interface RoundView {
  round: number;
  target: string | null;
  model: string | null;
  decided_by: DecidedBy | null;
  rule_id: string | null;
  rationale: string | null;
  arm: string | null;
  escalated_from: string | null;
  dispatch_status: DispatchStatus | "running" | null;
  wall_ms: number | null;
  model_ms: number | null;
  tool_ms: number | null;
  usage: NormalisedUsage | null;
  cost_usd: number | null;
  pricing_period: PricingPeriod | null;
  verdict: Verdict | null;
  reject_reason: RejectReason | null;
  checks: Record<string, CheckResult>;
  review_verdict: ReviewVerdict | null;
  reviewer_cost_usd: number | null;
  self_accepted: boolean;
  output_path: string | null;
  stderr_path: string | null;
  redispatch: RoundRedispatch | null;
}

export function roundViews(events: readonly EvenerEvent[]): RoundView[] {
  const groups = new Map<number, EvenerEvent[]>();
  for (const event of events) {
    const group = groups.get(event.round);
    if (group === undefined) groups.set(event.round, [event]);
    else group.push(event);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([round, roundEvents]) => buildRoundView(events, round, roundEvents));
}

function buildRoundView(
  allEvents: readonly EvenerEvent[],
  round: number,
  roundEvents: readonly EvenerEvent[],
): RoundView {
  let started: Payload | null = null;
  let finished: Payload | null = null;
  let route: Payload | null = null;
  let acceptance: Payload | null = null;
  let redispatch: Payload | null = null;

  for (const event of roundEvents) {
    switch (event.type) {
      case "dispatch.started":
        started = payload(event);
        break;
      case "dispatch.finished":
        finished = payload(event);
        break;
      case "route.decided":
        route = payload(event);
        break;
      case "acceptance.finished":
        acceptance = payload(event);
        break;
      case "task.redispatch":
        redispatch = payload(event);
        break;
    }
  }

  const outputPath = finished === null ? null : stringOrNull(finished["output_path"]);
  const stderrPath =
    outputPath !== null && outputPath.endsWith(".out.md")
      ? `${outputPath.slice(0, -".out.md".length)}.stderr`
      : null;

  const dispatchStatus: DispatchStatus | "running" | null = (() => {
    if (finished !== null) {
      return oneOf(finished["status"], [
        "success",
        "error",
        "timeout",
        "budget_exceeded",
      ] as const);
    }
    if (started !== null) return "running";
    return null;
  })();

  const pricingPeriod: PricingPeriod | null = (() => {
    if (finished === null) return null;
    return oneOf(finished["pricing_period"], PRICING_PERIODS) ?? "flat";
  })();

  const redispatchView: RoundRedispatch | null = (() => {
    if (redispatch === null) return null;
    const kind = oneOf(redispatch["kind"], REDISPATCH_KINDS);
    const nextTarget = stringOrNull(redispatch["next_target"]);
    const reason = stringOrNull(redispatch["reason"]);
    if (kind === null || nextTarget === null || reason === null) return null;
    return { kind, next_target: nextTarget, reason };
  })();

  return {
    round,
    target: roundTarget(allEvents, round),
    model: started === null ? null : stringOrNull(started["model"]),
    decided_by: route === null ? null : oneOf(route["decided_by"], DECIDED_BY_VALUES),
    rule_id: route === null ? null : stringOrNull(route["rule_id"]),
    rationale: route === null ? null : stringOrNull(route["rationale"]),
    arm: route === null ? null : stringOrNull(route["arm"]),
    escalated_from: route === null ? null : stringOrNull(route["escalated_from"]),
    dispatch_status: dispatchStatus,
    wall_ms: finished === null ? null : numberOrNull(finished["wall_ms"]),
    model_ms: finished === null ? null : numberOrNull(finished["model_ms"]),
    tool_ms: finished === null ? null : numberOrNull(finished["tool_ms"]),
    usage: finished === null ? null : usageOf(finished["usage"]),
    cost_usd: finished === null ? null : numberOrNull(finished["cost_usd"]),
    pricing_period: pricingPeriod,
    verdict: acceptance === null ? null : oneOf(acceptance["verdict"], VERDICTS),
    reject_reason:
      acceptance === null ? null : oneOf(acceptance["reject_reason"], REJECT_REASONS),
    checks: acceptance === null ? {} : checksOf(acceptance["checks"]),
    review_verdict:
      acceptance === null ? null : oneOf(acceptance["review_verdict"], REVIEW_VERDICTS),
    reviewer_cost_usd:
      acceptance === null ? null : numberOrZero(acceptance["reviewer_cost_usd"]),
    self_accepted: acceptance !== null && acceptance["self_accepted"] === true,
    output_path: outputPath,
    stderr_path: stderrPath,
    redispatch: redispatchView,
  };
}

// ---------------------------------------------------------------------------
// SessionView
// ---------------------------------------------------------------------------

export interface SessionTokens {
  input: number;
  cached_input: number;
  output: number;
}

export interface SessionView {
  host_session_id: string;
  host: string;
  first_ts: string;
  last_ts: string;
  tasks: number;
  accepted: number;
  open: number;
  delegated_cost_usd: number;
  host_round_cost_usd: number;
  reviewer_cost_usd: number;
  overhead_cost_usd: number;
  total_cost_usd: number;
  peak_cost_usd: number;
  off_cost_usd: number;
  reviewer_tokens: SessionTokens | null;
  targets: Record<string, number>;
}

interface SessionAccumulator {
  host_session_id: string;
  host: string;
  firstMs: number;
  lastMs: number;
  tasks: number;
  accepted: number;
  open: number;
  delegated: number;
  hostRounds: number;
  reviewer: number;
  overhead: number;
  peak: number;
  off: number;
  reviewerTokens: SessionTokens | null;
  targets: Record<string, number>;
}

function updateSpan(acc: SessionAccumulator, ts: string): void {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return;
  if (ms < acc.firstMs) acc.firstMs = ms;
  if (ms > acc.lastMs) acc.lastMs = ms;
}

export function sessionViews(
  tasks: readonly TaskRow[],
  eventsByTask: EventsByTask,
  since: Date,
): SessionView[] {
  const sinceMs = since.getTime();
  const sessions = new Map<string, SessionAccumulator>();

  for (const task of tasks) {
    const createdMs = Date.parse(task.created_ts);
    if (Number.isFinite(createdMs) && createdMs < sinceMs) continue;

    const key = task.host_session_id ?? "(none)";
    let acc = sessions.get(key);
    if (acc === undefined) {
      acc = {
        host_session_id: key,
        host: task.host,
        firstMs: Number.POSITIVE_INFINITY,
        lastMs: Number.NEGATIVE_INFINITY,
        tasks: 0,
        accepted: 0,
        open: 0,
        delegated: 0,
        hostRounds: 0,
        reviewer: 0,
        overhead: 0,
        peak: 0,
        off: 0,
        reviewerTokens: null,
        targets: {},
      };
      sessions.set(key, acc);
    }

    acc.tasks += 1;
    if (task.outcome === "accepted") acc.accepted += 1;
    if (task.state !== "closed") acc.open += 1;
    updateSpan(acc, task.created_ts);

    const roundTargets = new Map<number, string>();
    for (const event of eventsFor(eventsByTask, task.task_id)) {
      updateSpan(acc, event.ts);
      const data = payload(event);

      switch (event.type) {
        case "task.created":
          acc.overhead += numberOrZero(data["labeler_cost_usd"]);
          break;
        case "route.decided": {
          acc.overhead += numberOrZero(data["classifier_cost_usd"]);
          const target = stringOrNull(data["target"]);
          if (target !== null) roundTargets.set(event.round, target);
          break;
        }
        case "user.override": {
          const target = stringOrNull(data["to"]);
          if (target !== null) roundTargets.set(event.round, target);
          break;
        }
        case "dispatch.started": {
          const target = stringOrNull(data["target"]);
          if (target !== null) roundTargets.set(event.round, target);
          break;
        }
        case "dispatch.finished": {
          const cost = numberOrZero(data["cost_usd"]);
          const target =
            roundTargets.get(event.round) ?? task.current_target ?? "unknown";
          if (target === "host") acc.hostRounds += cost;
          else acc.delegated += cost;

          acc.targets[target] = (acc.targets[target] ?? 0) + 1;
          const period = oneOf(data["pricing_period"], PRICING_PERIODS) ?? "flat";
          if (period === "peak") acc.peak += cost;
          else acc.off += cost;
          break;
        }
        case "acceptance.finished": {
          acc.reviewer += numberOrZero(data["reviewer_cost_usd"]);
          const usage = asRecord(data["reviewer_usage"]);
          if (usage !== null) {
            const tokens = acc.reviewerTokens ?? {
              input: 0,
              cached_input: 0,
              output: 0,
            };
            tokens.input += numberOrZero(usage["input"]);
            tokens.cached_input += numberOrZero(usage["cached_input"]);
            tokens.output += numberOrZero(usage["output"]);
            acc.reviewerTokens = tokens;
          }
          break;
        }
      }
    }
  }

  return [...sessions.values()]
    .map((acc): SessionView => {
      const total = acc.delegated + acc.hostRounds + acc.reviewer + acc.overhead;
      const firstMs = Number.isFinite(acc.firstMs) ? acc.firstMs : 0;
      const lastMs = Number.isFinite(acc.lastMs) ? acc.lastMs : firstMs;
      return {
        host_session_id: acc.host_session_id,
        host: acc.host,
        first_ts: new Date(firstMs).toISOString(),
        last_ts: new Date(lastMs).toISOString(),
        tasks: acc.tasks,
        accepted: acc.accepted,
        open: acc.open,
        delegated_cost_usd: acc.delegated,
        host_round_cost_usd: acc.hostRounds,
        reviewer_cost_usd: acc.reviewer,
        overhead_cost_usd: acc.overhead,
        total_cost_usd: total,
        peak_cost_usd: acc.peak,
        off_cost_usd: acc.off,
        reviewer_tokens: acc.reviewerTokens,
        targets: acc.targets,
      };
    })
    .sort((left, right) => {
      const delta = Date.parse(right.last_ts) - Date.parse(left.last_ts);
      return delta !== 0 ? delta : right.host_session_id.localeCompare(left.host_session_id);
    });
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface Overview {
  now: string;
  home: string;
  policy_name: string;
  policy_version: string;
  experiment_mode: string;
  arms: string[];
  pricing_version: string;
  open_tasks: number;
  tasks_7d: number;
  accepted_7d: number;
  cost_7d_usd: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function overview(
  tasks: readonly TaskRow[],
  events: readonly EvenerEvent[],
  policy: Policy,
  pricingVersionValue: string,
  now: Date,
  home = "",
): Overview {
  void events;
  const weekStart = now.getTime() - WEEK_MS;
  const recent = tasks.filter((task) => {
    const created = Date.parse(task.created_ts);
    return Number.isFinite(created) && created >= weekStart && created <= now.getTime();
  });

  const arms =
    policy.experiment.mode === "off"
      ? ["all"]
      : Object.keys(policy.experiment.arms).sort();
  if (arms.length === 0) arms.push("all");

  return {
    now: now.toISOString(),
    home,
    policy_name: policy.policy_name,
    policy_version: policyVersion(policy),
    experiment_mode: policy.experiment.mode,
    arms,
    pricing_version: pricingVersionValue,
    open_tasks: tasks.filter((task) => task.state !== "closed").length,
    tasks_7d: recent.length,
    accepted_7d: recent.filter((task) => task.outcome === "accepted").length,
    cost_7d_usd: recent.reduce((sum, task) => sum + task.total_cost_usd, 0),
  };
}
