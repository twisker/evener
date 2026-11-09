/**
 * Report builder (spec §9).
 *
 * `buildReport` turns the event store into a plain JSON object with the six
 * report sections in their frozen order. No I/O happens here; the command layer
 * saves the JSON and renders markdown.
 */

import type { Store } from "./store.js";
import { LANGUAGES, TIME_BUCKETS } from "./types.js";
import {
  mean,
  mdd as minimumDetectableDifference,
  logCostCI,
  pooledSd,
  quantile,
  variance,
  welchT,
} from "./stats.js";
import type {
  AcceptanceFinishedPayload,
  DispatchFinishedPayload,
  EvenerEvent,
  Label,
  Policy,
  Pricing,
  QualityWeights,
  RejectReason,
  RouteDecidedPayload,
  TaskClosedPayload,
  TaskRedispatchPayload,
  TaskRow,
  UserFeedbackPayload,
  PostRevertPayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public report types
// ---------------------------------------------------------------------------

export const REPORT_DIMENSIONS = [
  "label",
  "language",
  "time_bucket",
  "has_repro",
  "cross_file",
] as const;
export type ReportBy = (typeof REPORT_DIMENSIONS)[number];

export interface ReportOptions {
  since: Date;
  by?: ReportBy;
  now: Date;
}

export interface ReportHeader {
  since: string;
  now: string;
  by: ReportBy;
  total_tasks: number;
  closed_tasks: number;
  accepted_tasks: number;
  arms: Record<string, number>;
  policy_name: string;
  policy_versions: string[];
  experiment_mode: string;
  saved_to: string | null;
}

export interface ArmReport {
  arm: string;
  n: number;
  accepted: number;
  cpat: number | null;
  quality_score: number | null;
  quality_per_cost: number | null;
  mean_cost_usd: number | null;
  mean_wall_ms: number | null;
  weights: QualityWeights;
  insufficient: boolean;
}

export interface StratumReport {
  dimension: ReportBy;
  key: string;
  arm: string;
  n: number;
  accepted: number;
  cpat: number | null;
  quality_score: number | null;
  quality_per_cost: number | null;
  mean_wall_ms: number | null;
  weights: QualityWeights;
  insufficient: boolean;
}

export interface TargetProfile {
  target: string;
  n: number;
  accepted: number;
  dispatches: number;
  first_pass_rate: number | null;
  final_pass_rate: number | null;
  cpat: number | null;
  quality_score: number | null;
  reject_reasons: Record<RejectReason, number>;
  rejections: number;
  style_rejections: number;
  style_ratio: number | null;
  style_suspected: boolean;
  mean_cost_usd: number | null;
  mean_wall_ms: number | null;
  failures: number;
  failure_rate: number | null;
  classifier_latency_p50_ms: number | null;
  classifier_latency_p90_ms: number | null;
  insufficient: boolean;
}

export interface ComparisonReport {
  a: string;
  b: string;
  n_a: number;
  n_b: number;
  ratio: number | null;
  ci_low: number | null;
  ci_high: number | null;
  t: number | null;
  df: number | null;
  p: number | null;
  pooled_sd_log: number | null;
  mdd: number | null;
  insufficient: boolean;
}

export interface LabelDetectability {
  analysis_label: Label;
  n: number;
  mdd: number | null;
}

export interface DetectabilityReport {
  alpha: number;
  power: number;
  mdd: number | null;
  comparisons: ComparisonReport[];
  by_label: LabelDetectability[];
}

export interface ReportAlert {
  code: string;
  level: "warning";
  message: string;
  [key: string]: unknown;
}

export interface ReportSuggestion {
  n: number;
  field: string;
  from: unknown;
  to: unknown;
  evidence: string;
}

export interface Report {
  header: ReportHeader;
  arms: ArmReport[];
  strata: StratumReport[];
  targets: TargetProfile[];
  detectability: DetectabilityReport;
  alerts: ReportAlert[];
  suggestions: ReportSuggestion[];
}

// ---------------------------------------------------------------------------
// Internal analysis
// ---------------------------------------------------------------------------

interface RoundData {
  round: number;
  target: string | null;
  classifierCostUsd: number;
  classifierLatencyMs: number | null;
  dispatch: DispatchFinishedPayload | null;
  acceptance: AcceptanceFinishedPayload | null;
}

interface DispatchRecord {
  round: number;
  target: string;
  data: DispatchFinishedPayload;
}

interface AcceptanceRecord {
  round: number;
  target: string;
  data: AcceptanceFinishedPayload;
}

interface RejectionRecord {
  round: number;
  target: string;
  reason: RejectReason;
}

interface RedispatchRecord {
  round: number;
  data: TaskRedispatchPayload;
}

interface TaskData {
  task: TaskRow;
  rounds: Map<number, RoundData>;
  dispatches: DispatchRecord[];
  acceptances: AcceptanceRecord[];
  rejections: RejectionRecord[];
  redispatch: RedispatchRecord[];
  feedback: UserFeedbackPayload[];
  reverts: PostRevertPayload[];
  reviewerCostUsd: number;
  closed: TaskClosedPayload | null;
}

/**
 * The target that actually ran a round.
 *
 * `dispatch.started` is authoritative because `user.override` can change the
 * target between `route.decided` and dispatch. Only when no dispatch target was
 * recorded (e.g. the task was abandoned before dispatch) fall back to the last
 * `route.decided` / `user.override` in that round.
 */
export function roundTarget(events: readonly EvenerEvent[], round: number): string | null {
  let dispatched: string | null = null;
  let routed: string | null = null;
  for (const event of events) {
    if (event.round !== round) continue;
    switch (event.type) {
      case "dispatch.started":
        dispatched = event.data.target;
        break;
      case "route.decided":
        routed = event.data.target;
        break;
      case "user.override":
        routed = event.data.to;
        break;
    }
  }
  return dispatched ?? routed;
}

function roundFor(rounds: Map<number, RoundData>, round: number): RoundData {
  const existing = rounds.get(round);
  if (existing !== undefined) return existing;
  const created: RoundData = {
    round,
    target: null,
    classifierCostUsd: 0,
    classifierLatencyMs: null,
    dispatch: null,
    acceptance: null,
  };
  rounds.set(round, created);
  return created;
}

function analyseTask(task: TaskRow, events: readonly EvenerEvent[], windowStart: number, now: number): TaskData {
  const rounds = new Map<number, RoundData>();
  const dispatches: DispatchRecord[] = [];
  const acceptances: AcceptanceRecord[] = [];
  const rejections: RejectionRecord[] = [];
  const redispatch: RedispatchRecord[] = [];
  const feedback: UserFeedbackPayload[] = [];
  const reverts: PostRevertPayload[] = [];
  let reviewerCostUsd = 0;
  let closed: TaskClosedPayload | null = null;

  const inWindow = (ts: string): boolean => {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) && ms >= windowStart && ms <= now;
  };

  for (const event of events) {
    const eventMs = Date.parse(event.ts);
    if (!Number.isFinite(eventMs) || eventMs > now) continue;

    switch (event.type) {
      case "task.created":
        // The fixed-taxonomy labeler is Evener overhead, like the classifier.
        roundFor(rounds, event.round).classifierCostUsd +=
          event.data.labeler_cost_usd ?? 0;
        break;
      case "route.decided": {
        const data: RouteDecidedPayload = event.data;
        const round = roundFor(rounds, event.round);
        round.classifierCostUsd += data.classifier_cost_usd ?? 0;
        if (data.classifier_latency_ms !== null) {
          round.classifierLatencyMs = data.classifier_latency_ms;
        }
        break;
      }
      case "dispatch.started":
        roundFor(rounds, event.round);
        break;
      case "dispatch.finished": {
        const round = roundFor(rounds, event.round);
        round.dispatch = event.data;
        break;
      }
      case "acceptance.finished": {
        const round = roundFor(rounds, event.round);
        round.acceptance = event.data;
        reviewerCostUsd += event.data.reviewer_cost_usd;
        break;
      }
      case "task.redispatch": {
        redispatch.push({ round: event.round, data: event.data });
        roundFor(rounds, event.round);
        break;
      }
      case "task.closed":
        closed = event.data;
        break;
      case "user.feedback":
        if (inWindow(event.ts)) feedback.push(event.data);
        break;
      case "post.revert":
        if (inWindow(event.ts)) reverts.push(event.data);
        break;
      case "user.override":
      case "target.circuit":
        break;
    }
  }

  // Attribute every round to the target from its dispatch events (or the last
  // route/override when the task never reached dispatch).
  for (const round of rounds.values()) {
    round.target = roundTarget(events, round.round);
  }
  for (const round of rounds.values()) {
    const target = round.target ?? task.current_target ?? "unknown";
    if (round.dispatch !== null) {
      dispatches.push({ round: round.round, target, data: round.dispatch });
    }
    if (round.acceptance !== null) {
      acceptances.push({ round: round.round, target, data: round.acceptance });
      if (round.acceptance.verdict === "rejected") {
        rejections.push({
          round: round.round,
          target,
          reason: round.acceptance.reject_reason ?? "other",
        });
      }
    }
  }

  return {
    task,
    rounds,
    dispatches,
    acceptances,
    rejections,
    redispatch,
    feedback,
    reverts,
    reviewerCostUsd,
    closed,
  };
}

const REJECT_REASONS: readonly RejectReason[] = [
  "tests_failed",
  "build_failed",
  "out_of_scope",
  "incomplete",
  "style",
  "misunderstood",
  "regression",
  "other",
];

// ---------------------------------------------------------------------------
// Quality weights / quality score
// ---------------------------------------------------------------------------

/** Redistribute missing feedback/revert weight proportionally to first/final. */
export function effectiveQualityWeights(
  base: QualityWeights,
  hasFeedback: boolean,
  hasRevert: boolean,
): QualityWeights {
  const weights: QualityWeights = { ...base };

  const distribute = (amount: number): void => {
    const total = weights.first_pass + weights.final_pass;
    if (total > 0) {
      weights.first_pass += amount * (weights.first_pass / total);
      weights.final_pass += amount * (weights.final_pass / total);
    } else {
      weights.first_pass += amount / 2;
      weights.final_pass += amount / 2;
    }
  };

  if (!hasFeedback) {
    const amount = weights.feedback;
    weights.feedback = 0;
    distribute(amount);
  }
  if (!hasRevert) {
    const amount = weights.revert;
    weights.revert = 0;
    distribute(amount);
  }
  return weights;
}

interface StyleStats {
  target: string;
  rejections: number;
  style_rejections: number;
  style_ratio: number;
  style_suspected: boolean;
}

function computeStyleStats(
  tasks: readonly TaskData[],
  policy: Policy,
): Map<string, StyleStats> {
  const counts = new Map<string, { total: number; style: number }>();
  for (const task of tasks) {
    for (const rejection of task.rejections) {
      const entry = counts.get(rejection.target) ?? { total: 0, style: 0 };
      entry.total += 1;
      if (rejection.reason === "style") entry.style += 1;
      counts.set(rejection.target, entry);
    }
  }

  const result = new Map<string, StyleStats>();
  for (const [target, entry] of counts) {
    const ratio = entry.total > 0 ? entry.style / entry.total : 0;
    result.set(target, {
      target,
      rejections: entry.total,
      style_rejections: entry.style,
      style_ratio: ratio,
      style_suspected: entry.total > 0 && ratio >= policy.style_rejection_suspect_ratio,
    });
  }
  return result;
}

function isQualityFirstPass(task: TaskData, suspected: ReadonlySet<string>): boolean {
  if (task.task.first_pass === 1) return true;
  if (task.task.first_pass !== 0) return false;
  const first = task.rejections.find((rejection) => rejection.round === 1);
  return (
    first !== undefined &&
    first.reason === "style" &&
    suspected.has(first.target)
  );
}

function isQualityFinalPass(task: TaskData, suspected: ReadonlySet<string>): boolean {
  if (task.task.outcome === "accepted") return true;
  if (task.rejections.length === 0) return false;
  return task.rejections.every(
    (rejection) => rejection.reason === "style" && suspected.has(rejection.target),
  );
}

interface QualityMetrics {
  quality_score: number;
  first_pass: number;
  final_pass: number;
  feedback: number;
  revert: number;
  feedback_up: number;
  feedback_down: number;
  revert_events: number;
}

function computeQuality(
  tasks: readonly TaskData[],
  weights: QualityWeights,
  suspected: ReadonlySet<string>,
): QualityMetrics | null {
  if (tasks.length === 0) return null;

  const firstPassCount = tasks.filter((task) => isQualityFirstPass(task, suspected)).length;
  const finalPassCount = tasks.filter((task) => isQualityFinalPass(task, suspected)).length;
  const firstPass = firstPassCount / tasks.length;
  const finalPass = finalPassCount / tasks.length;

  let up = 0;
  let down = 0;
  for (const task of tasks) {
    for (const feedback of task.feedback) {
      if (feedback.rating === "up") up += 1;
      else down += 1;
    }
  }
  const feedbackScore = up + down > 0 ? ((up - down) / (up + down) + 1) / 2 : 0.5;

  const revertRatios: number[] = [];
  for (const task of tasks) {
    for (const revert of task.reverts) revertRatios.push(revert.reverted_ratio);
  }
  const revertScore = revertRatios.length > 0 ? 1 - mean(revertRatios) : 1;

  const score =
    weights.first_pass * firstPass +
    weights.final_pass * finalPass +
    weights.feedback * feedbackScore +
    weights.revert * revertScore;

  return {
    quality_score: Math.min(1, Math.max(0, score)),
    first_pass: firstPass,
    final_pass: finalPass,
    feedback: feedbackScore,
    revert: revertScore,
    feedback_up: up,
    feedback_down: down,
    revert_events: revertRatios.length,
  };
}

// ---------------------------------------------------------------------------
// CPAT / grouping helpers
// ---------------------------------------------------------------------------

function closedTasks(tasks: readonly TaskData[]): TaskData[] {
  return tasks.filter((task) => task.task.state === "closed");
}

function acceptedTasks(tasks: readonly TaskData[]): TaskData[] {
  return closedTasks(tasks).filter((task) => task.task.outcome === "accepted");
}

function cpatFor(tasks: readonly TaskData[]): number | null {
  const closed = closedTasks(tasks);
  const accepted = closed.filter((task) => task.task.outcome === "accepted").length;
  if (accepted === 0) return null;
  let cost = 0;
  for (const task of closed) cost += task.task.total_cost_usd;
  return cost / accepted;
}

function qualityPerCost(quality: number | null, cpat: number | null): number | null {
  if (quality === null || cpat === null || cpat <= 0) return null;
  return quality / cpat;
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return mean(values);
}

function finalRound(task: TaskData): number {
  let max = task.task.current_round;
  if (task.closed !== null) max = Math.max(max, task.closed.total_rounds);
  for (const round of task.rounds.keys()) max = Math.max(max, round);
  return max;
}

function armForTask(task: TaskRow, experimentOn: boolean): string {
  if (!experimentOn) return "all";
  return task.arm ?? "all";
}

/** Render one task's key for the chosen stratification dimension. */
export function stratumKey(task: TaskRow, dimension: ReportBy): string {
  switch (dimension) {
    case "label":
      return task.analysis_label;
    case "language":
      return task.language ?? "null";
    case "time_bucket":
      return task.time_bucket;
    case "has_repro":
      return task.has_repro ? "true" : "false";
    case "cross_file":
      return task.cross_file ? "true" : "false";
  }
}

function orderedStratumKeys(
  dimension: ReportBy,
  observed: ReadonlySet<string>,
  policy: Policy,
): string[] {
  const canonical: readonly string[] = (() => {
    switch (dimension) {
      case "label":
        return policy.taxonomy.labels;
      case "language":
        return LANGUAGES;
      case "time_bucket":
        return TIME_BUCKETS;
      case "has_repro":
      case "cross_file":
        return ["false", "true"];
    }
  })();

  const ordered = canonical.filter((key) => observed.has(key));
  const extras = [...observed].filter((key) => !ordered.includes(key)).sort();
  return [...ordered, ...extras];
}

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

export function buildReport(
  store: Store,
  policy: Policy,
  _pricing: Pricing,
  opts: ReportOptions,
): Report {
  const since = opts.since;
  const now = opts.now;
  const by: ReportBy = opts.by ?? "label";
  const sinceIso = since.toISOString();
  const nowIso = now.toISOString();
  const sinceMs = since.getTime();
  const nowMs = now.getTime();

  const windowTasks = store
    .listTasks({ since: sinceIso })
    .filter((task) => {
      const ms = Date.parse(task.created_ts);
      return Number.isFinite(ms) && ms <= nowMs;
    });

  const tasks: TaskData[] = windowTasks.map((task) =>
    analyseTask(task, store.getEvents(task.task_id), sinceMs, nowMs),
  );

  const experimentOn = policy.experiment.mode !== "off";
  const armNames = (() => {
    if (!experimentOn) return ["all"];
    const names = new Set<string>();
    for (const name of Object.keys(policy.experiment.arms)) names.add(name);
    for (const task of windowTasks) {
      if (task.arm !== null) names.add(task.arm);
    }
    if (windowTasks.some((task) => task.arm === null)) names.add("all");
    if (names.size === 0) names.add("all");
    return [...names].sort();
  })();

  const hasFeedback = tasks.some((task) => task.feedback.length > 0);
  const hasRevert = tasks.some((task) => task.reverts.length > 0);
  const weights = effectiveQualityWeights(policy.quality_weights, hasFeedback, hasRevert);
  const styleStats = computeStyleStats(tasks, policy);
  const suspected = new Set(
    [...styleStats.values()]
      .filter((stats) => stats.style_suspected)
      .map((stats) => stats.target),
  );

  // --- Section 1: header ---------------------------------------------------
  const armTaskCounts: Record<string, number> = {};
  for (const name of armNames) armTaskCounts[name] = 0;
  for (const task of windowTasks) {
    const name = armForTask(task, experimentOn);
    armTaskCounts[name] = (armTaskCounts[name] ?? 0) + 1;
  }
  const policyVersions = [...new Set(windowTasks.map((task) => task.policy_version))].sort();

  const header: ReportHeader = {
    since: sinceIso,
    now: nowIso,
    by,
    total_tasks: windowTasks.length,
    closed_tasks: windowTasks.filter((task) => task.state === "closed").length,
    accepted_tasks: windowTasks.filter((task) => task.outcome === "accepted").length,
    arms: armTaskCounts,
    policy_name: policy.policy_name,
    policy_versions: policyVersions,
    experiment_mode: policy.experiment.mode,
    saved_to: null,
  };

  // --- Section 2: arms -----------------------------------------------------
  const arms: ArmReport[] = armNames.map((name) => {
    const group = tasks.filter((task) => armForTask(task.task, experimentOn) === name);
    const closed = closedTasks(group);
    const accepted = acceptedTasks(group);
    const quality = computeQuality(closed, weights, suspected);
    const cpat = cpatFor(group);
    return {
      arm: name,
      n: closed.length,
      accepted: accepted.length,
      cpat,
      quality_score: quality?.quality_score ?? null,
      quality_per_cost: qualityPerCost(quality?.quality_score ?? null, cpat),
      mean_cost_usd: meanOf(closed.map((task) => task.task.total_cost_usd)),
      mean_wall_ms: meanOf(closed.map((task) => task.task.total_wall_ms)),
      weights,
      insufficient: closed.length < 8 || accepted.length === 0,
    };
  });

  // --- Section 3: strata by the chosen dimension ---------------------------
  const observedLabels = [...new Set(windowTasks.map((task) => task.analysis_label))];
  const labelOrder = policy.taxonomy.labels.filter((label) => observedLabels.includes(label));
  const extraLabels = observedLabels
    .filter((label) => !labelOrder.includes(label))
    .sort();
  const labels = [...labelOrder, ...extraLabels];

  const observedKeys = new Set(windowTasks.map((task) => stratumKey(task, by)));
  const stratumKeys = orderedStratumKeys(by, observedKeys, policy);

  const strata: StratumReport[] = [];
  for (const key of stratumKeys) {
    for (const armName of armNames) {
      const group = tasks.filter(
        (task) =>
          stratumKey(task.task, by) === key &&
          armForTask(task.task, experimentOn) === armName,
      );
      if (group.length === 0) continue;
      const closed = closedTasks(group);
      const accepted = acceptedTasks(group);
      const quality = computeQuality(closed, weights, suspected);
      const cpat = cpatFor(group);
      strata.push({
        dimension: by,
        key,
        arm: armName,
        n: closed.length,
        accepted: accepted.length,
        cpat,
        quality_score: quality?.quality_score ?? null,
        quality_per_cost: qualityPerCost(quality?.quality_score ?? null, cpat),
        mean_wall_ms: meanOf(closed.map((task) => task.task.total_wall_ms)),
        weights,
        insufficient: closed.length < 8,
      });
    }
  }

  // --- Section 4: target profiles ------------------------------------------
  const observedTargets = new Set<string>();
  for (const name of Object.keys(policy.targets)) observedTargets.add(name);
  for (const task of tasks) {
    for (const round of task.rounds.values()) {
      if (round.target !== null) observedTargets.add(round.target);
    }
  }
  const targetNames = [...observedTargets].sort();

  const targets: TargetProfile[] = targetNames.map((target) => {
    const targetRounds: { task: TaskData; round: RoundData }[] = [];
    for (const task of tasks) {
      for (const round of task.rounds.values()) {
        if (round.target === target) targetRounds.push({ task, round });
      }
    }
    const closedTargetRounds = targetRounds.filter(
      (entry) => entry.task.task.state === "closed",
    );
    const closedTaskIds = new Set(
      closedTargetRounds.map((entry) => entry.task.task.task_id),
    );
    const targetTasks = tasks.filter((task) => closedTaskIds.has(task.task.task_id));

    const dispatches: DispatchFinishedPayload[] = [];
    const roundCosts: number[] = [];
    const closedRoundCosts: number[] = [];
    for (const entry of targetRounds) {
      const dispatch = entry.round.dispatch;
      const acceptance = entry.round.acceptance;
      if (dispatch !== null) dispatches.push(dispatch);
      if (dispatch === null && acceptance === null) continue;
      const cost = (dispatch?.cost_usd ?? 0) + (acceptance?.reviewer_cost_usd ?? 0);
      roundCosts.push(cost);
      if (entry.task.task.state === "closed") closedRoundCosts.push(cost);
    }

    const rejections = tasks.flatMap((task) =>
      task.rejections.filter((rejection) => rejection.target === target),
    );
    const rejectCounts = {} as Record<RejectReason, number>;
    for (const reason of REJECT_REASONS) rejectCounts[reason] = 0;
    for (const rejection of rejections) {
      rejectCounts[rejection.reason] = (rejectCounts[rejection.reason] ?? 0) + 1;
    }

    const latencies: number[] = [];
    for (const entry of targetRounds) {
      if (entry.round.classifierLatencyMs !== null) {
        latencies.push(entry.round.classifierLatencyMs);
      }
    }

    const failures = dispatches.filter(
      (dispatch) => dispatch.status === "error" || dispatch.status === "timeout",
    ).length;
    const accepted = closedTargetRounds.filter(
      (entry) => entry.round.acceptance?.verdict === "accepted",
    ).length;
    const firstRounds = closedTargetRounds.filter((entry) => entry.round.round === 1);
    const finalRounds = closedTargetRounds.filter(
      (entry) => entry.round.round === finalRound(entry.task),
    );
    const firstPassRate =
      firstRounds.length > 0
        ? firstRounds.filter((entry) => entry.round.acceptance?.verdict === "accepted")
            .length / firstRounds.length
        : null;
    const finalPassRate =
      finalRounds.length > 0
        ? finalRounds.filter((entry) => entry.round.acceptance?.verdict === "accepted")
            .length / finalRounds.length
        : null;
    const style = styleStats.get(target);
    const quality = computeQuality(targetTasks, weights, suspected);
    const totalRoundCost = closedRoundCosts.reduce((sum, cost) => sum + cost, 0);

    return {
      target,
      n: closedTargetRounds.length,
      accepted,
      dispatches: dispatches.length,
      first_pass_rate: firstPassRate,
      final_pass_rate: finalPassRate,
      cpat: accepted > 0 ? totalRoundCost / accepted : null,
      quality_score: quality?.quality_score ?? null,
      reject_reasons: rejectCounts,
      rejections: rejections.length,
      style_rejections: style?.style_rejections ?? 0,
      style_ratio: style?.style_ratio ?? null,
      style_suspected: style?.style_suspected ?? false,
      mean_cost_usd: meanOf(roundCosts),
      mean_wall_ms: meanOf(dispatches.map((dispatch) => dispatch.wall_ms)),
      failures,
      failure_rate: dispatches.length > 0 ? failures / dispatches.length : null,
      classifier_latency_p50_ms:
        latencies.length > 0 ? quantile(latencies, 0.5) : null,
      classifier_latency_p90_ms:
        latencies.length > 0 ? quantile(latencies, 0.9) : null,
      insufficient: closedTargetRounds.length < 8,
    };
  });

  // --- Section 5: detectability -------------------------------------------
  const alpha = policy.experiment.alpha;
  const power = policy.experiment.power;
  const acceptedLogCosts = (name: string): number[] =>
    acceptedTasks(
      tasks.filter((task) => armForTask(task.task, experimentOn) === name),
    ).map((task) => Math.log(Math.max(task.task.total_cost_usd, 0) + 0.001));

  const comparisons: ComparisonReport[] = [];
  for (let i = 0; i < armNames.length; i += 1) {
    for (let j = i + 1; j < armNames.length; j += 1) {
      const aName = armNames[i];
      const bName = armNames[j];
      if (aName === undefined || bName === undefined) continue;
      const a = acceptedLogCosts(aName);
      const b = acceptedLogCosts(bName);
      if (a.length < 2 || b.length < 2) {
        comparisons.push({
          a: aName,
          b: bName,
          n_a: a.length,
          n_b: b.length,
          ratio: null,
          ci_low: null,
          ci_high: null,
          t: null,
          df: null,
          p: null,
          pooled_sd_log: null,
          mdd: null,
          insufficient: true,
        });
        continue;
      }
      const test = welchT(a, b);
      const ci = logCostCI(a, b, alpha);
      const sd = pooledSd(a, b);
      comparisons.push({
        a: aName,
        b: bName,
        n_a: a.length,
        n_b: b.length,
        ratio: ci.ratio,
        ci_low: ci.lo,
        ci_high: ci.hi,
        t: test.t,
        df: test.df,
        p: test.p,
        pooled_sd_log: sd,
        mdd: minimumDetectableDifference(a.length, b.length, sd, alpha, power),
        insufficient: a.length < 8 || b.length < 8,
      });
    }
  }

  const allAcceptedLogCosts = tasks
    .filter((task) => task.task.state === "closed" && task.task.outcome === "accepted")
    .map((task) => Math.log(Math.max(task.task.total_cost_usd, 0) + 0.001));
  const overallMdd = (() => {
    if (comparisons.length > 0) return comparisons[0]?.mdd ?? null;
    if (allAcceptedLogCosts.length < 2) return null;
    const split = Math.floor(allAcceptedLogCosts.length / 2);
    const nA = Math.max(split, 1);
    const nB = Math.max(allAcceptedLogCosts.length - split, 1);
    return minimumDetectableDifference(
      nA,
      nB,
      Math.sqrt(variance(allAcceptedLogCosts)),
      alpha,
      power,
    );
  })();

  const byLabel: LabelDetectability[] = labels.map((label) => {
    const labelCosts = tasks
      .filter(
        (task) =>
          task.task.analysis_label === label &&
          task.task.state === "closed" &&
          task.task.outcome === "accepted",
      )
      .map((task) => Math.log(Math.max(task.task.total_cost_usd, 0) + 0.001));
    if (labelCosts.length < 2) {
      return { analysis_label: label, n: labelCosts.length, mdd: null };
    }
    const split = Math.floor(labelCosts.length / 2);
    const nA = Math.max(split, 1);
    const nB = Math.max(labelCosts.length - split, 1);
    return {
      analysis_label: label,
      n: labelCosts.length,
      mdd: minimumDetectableDifference(
        nA,
        nB,
        Math.sqrt(variance(labelCosts)),
        alpha,
        power,
      ),
    };
  });

  const detectability: DetectabilityReport = {
    alpha,
    power,
    mdd: overallMdd,
    comparisons,
    by_label: byLabel,
  };

  // --- Section 6a: alerts --------------------------------------------------
  const alerts: ReportAlert[] = [];
  const sortedClosed = [...closedTasks(tasks)].sort((left, right) =>
    left.task.task_id.localeCompare(right.task.task_id),
  );
  for (const task of sortedClosed) {
    if (!(task.task.total_cost_usd > 0)) continue;
    const ratio = task.reviewerCostUsd / task.task.total_cost_usd;
    if (ratio > policy.limits.acceptance_overhead_warn_task_ratio) {
      alerts.push({
        code: "acceptance_overhead_task",
        level: "warning",
        message: `task ${task.task.task_id} acceptance overhead ${(ratio * 100).toFixed(1)}% > ${(policy.limits.acceptance_overhead_warn_task_ratio * 100).toFixed(0)}%`,
        task_id: task.task.task_id,
        ratio,
        threshold: policy.limits.acceptance_overhead_warn_task_ratio,
      });
    }
  }

  let totalCost = 0;
  let totalReviewerCost = 0;
  for (const task of sortedClosed) {
    totalCost += task.task.total_cost_usd;
    totalReviewerCost += task.reviewerCostUsd;
  }
  if (totalCost > 0) {
    const windowRatio = totalReviewerCost / totalCost;
    if (windowRatio > policy.limits.acceptance_overhead_warn_weekly_ratio) {
      alerts.push({
        code: "acceptance_overhead_window",
        level: "warning",
        message: `window acceptance overhead ${(windowRatio * 100).toFixed(1)}% > ${(policy.limits.acceptance_overhead_warn_weekly_ratio * 100).toFixed(0)}%`,
        ratio: windowRatio,
        threshold: policy.limits.acceptance_overhead_warn_weekly_ratio,
      });
    }
  }

  for (const target of targetNames) {
    const stats = styleStats.get(target);
    if (stats?.style_suspected === true) {
      alerts.push({
        code: "style_suspicion",
        level: "warning",
        message: `target ${target} has ${(stats.style_ratio * 100).toFixed(0)}% style rejections (suspected reviewer preference); style excluded from its quality penalty`,
        target,
        style_rejections: stats.style_rejections,
        rejections: stats.rejections,
        style_ratio: stats.style_ratio,
        threshold: policy.style_rejection_suspect_ratio,
      });
    }
  }

  // --- Section 6b: suggestions --------------------------------------------
  const suggestions: ReportSuggestion[] = [];

  // Rule 1: per-label / per-target first-pass + CPAT gap.
  const targetCell = (
    label: Label,
    target: string,
  ): { n: number; firstPass: number; cpat: number | null } => {
    const cellRounds: { task: TaskData; round: RoundData }[] = [];
    for (const task of tasks) {
      if (task.task.analysis_label !== label) continue;
      if (task.task.state !== "closed") continue;
      for (const round of task.rounds.values()) {
        if (round.target === target) cellRounds.push({ task, round });
      }
    }

    const firstRounds = cellRounds.filter((entry) => entry.round.round === 1);
    const firstPass =
      firstRounds.length > 0
        ? firstRounds.filter((entry) => entry.round.acceptance?.verdict === "accepted")
            .length / firstRounds.length
        : 0;

    let accepted = 0;
    let totalCost = 0;
    for (const entry of cellRounds) {
      const dispatch = entry.round.dispatch;
      const acceptance = entry.round.acceptance;
      if (dispatch === null && acceptance === null) continue;
      totalCost += (dispatch?.cost_usd ?? 0) + (acceptance?.reviewer_cost_usd ?? 0);
      if (acceptance?.verdict === "accepted") accepted += 1;
    }

    return {
      n: cellRounds.length,
      firstPass,
      cpat: accepted > 0 ? totalCost / accepted : null,
    };
  };

  let rule1: ReportSuggestion | null = null;
  for (const label of labels) {
    if (rule1 !== null) break;
    const candidateTargets = [...observedTargets].sort();
    for (let i = 0; i < candidateTargets.length && rule1 === null; i += 1) {
      for (let j = 0; j < candidateTargets.length && rule1 === null; j += 1) {
        const x = candidateTargets[i];
        const y = candidateTargets[j];
        if (x === undefined || y === undefined || x === y) continue;
        const cellX = targetCell(label, x);
        const cellY = targetCell(label, y);
        if (cellX.n < 8 || cellY.n < 8) continue;
        if (cellX.firstPass < cellY.firstPass + 0.2) continue;
        if (cellX.cpat === null || cellY.cpat === null) continue;
        if (!(cellX.cpat < cellY.cpat)) continue;
        if (policy.targets[x] === undefined) continue;

        const bias = policy.preferences.per_label_bias[label]?.[x] ?? 0;
        const to = Math.max(-1, Math.min(1, Math.round((bias + 0.2) * 1e6) / 1e6));
        if (to === bias) continue;
        rule1 = {
          n: 1,
          field: `preferences.per_label_bias.${label}.${x}`,
          from: bias,
          to,
          evidence: `${label}: ${x} first-pass ${cellX.firstPass.toFixed(2)} (n=${cellX.n}) vs ${y} ${cellY.firstPass.toFixed(2)} (n=${cellY.n}); CPAT ${cellX.cpat.toFixed(4)} < ${cellY.cpat.toFixed(4)}`,
        };
      }
    }
  }
  if (rule1 !== null) suggestions.push(rule1);

  // Rule 2: target failure rate.
  if (suggestions.length < 3) {
    for (const target of targetNames) {
      const profile = targets.find((entry) => entry.target === target);
      if (profile === undefined || profile.dispatches < 8) continue;
      if (profile.failure_rate === null || profile.failure_rate <= 0.3) continue;
      if (policy.targets[target]?.enabled !== true) continue;
      suggestions.push({
        n: suggestions.length + 1,
        field: `targets.${target}.enabled`,
        from: true,
        to: false,
        evidence: `target ${target} failure rate ${profile.failure_rate.toFixed(2)} over ${profile.dispatches} dispatches (> 0.3, n >= 8)`,
      });
      break;
    }
  }

  // Rule 3: retry round-2 acceptance rate.
  if (suggestions.length < 3 && policy.escalation.retry_same_target_once) {
    let retryN = 0;
    let retryAccepted = 0;
    for (const task of tasks) {
      const hasRetry = task.redispatch.some(
        (event) => event.data.kind === "retry" && event.round === 2,
      );
      if (!hasRetry) continue;
      const acceptance = task.rounds.get(2)?.acceptance;
      if (acceptance === undefined || acceptance === null) continue;
      retryN += 1;
      if (acceptance.verdict === "accepted") retryAccepted += 1;
    }
    const rate = retryN > 0 ? retryAccepted / retryN : 0;
    if (retryN >= 8 && rate < 0.2) {
      suggestions.push({
        n: suggestions.length + 1,
        field: "escalation.retry_same_target_once",
        from: true,
        to: false,
        evidence: `round-2 acceptance after retry ${rate.toFixed(2)} over ${retryN} retries (< 0.2, n >= 8)`,
      });
    }
  }

  return {
    header,
    arms,
    strata,
    targets,
    detectability,
    alerts,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function formatNumber(value: number | null, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(4)}`;
}

function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)} ms`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function insufficientCell(insufficient: boolean, content: string): string {
  return insufficient ? "样本不足 / insufficient" : content;
}

const DIMENSION_LABELS: Record<ReportBy, string> = {
  label: "标签 / label",
  language: "语言 / language",
  time_bucket: "时间桶 / time_bucket",
  has_repro: "有复现 / has_repro",
  cross_file: "跨文件 / cross_file",
};

/** Compact bilingual markdown rendering of a report. */
export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  const header = report.header;

  lines.push("# Evener 报告 / Report");
  lines.push("");
  lines.push(`- 时间窗 / Window: \`${header.since}\` → \`${header.now}\``);
  lines.push(
    `- 任务 / Tasks: ${header.total_tasks} total, ${header.closed_tasks} closed, ${header.accepted_tasks} accepted`,
  );
  lines.push(`- 策略 / Policy: ${header.policy_name} (${header.experiment_mode})`);
  lines.push(`- 策略版本 / Policy versions: ${header.policy_versions.join(", ") || "—"}`);
  const armCounts = Object.entries(header.arms)
    .map(([arm, count]) => `${arm}=${count}`)
    .join(", ");
  lines.push(`- 各臂任务 / Tasks per arm: ${armCounts || "—"}`);
  if (header.saved_to !== null) {
    lines.push(`- 保存至 / Saved to: \`${header.saved_to}\``);
  }
  lines.push("");

  lines.push("## 总表 / Summary");
  lines.push("");
  lines.push("| 臂 / Arm | CPAT | 质量分 / Quality | 性价比 / Value | 平均耗时 / Mean wall | n | 状态 / Status |");
  lines.push("|---|---:|---:|---:|---:|---:|---|");
  for (const arm of report.arms) {
    lines.push(
      `| ${escapeCell(arm.arm)} | ${formatUsd(arm.cpat)} | ${formatNumber(arm.quality_score)} | ${formatNumber(arm.quality_per_cost)} | ${formatMs(arm.mean_wall_ms)} | ${arm.n} | ${arm.insufficient ? "样本不足 / insufficient" : "ok"} |`,
    );
  }
  lines.push("");

  const dimension = report.header.by;
  lines.push(`## 分层 / Strata by ${dimension}`);
  lines.push("");
  lines.push(
    `| ${DIMENSION_LABELS[dimension]} | 臂 / Arm | CPAT | 质量分 / Quality | 性价比 / Value | n | 状态 / Status |`,
  );
  lines.push("|---|---|---:|---:|---:|---:|---|");
  for (const row of report.strata) {
    lines.push(
      `| ${escapeCell(row.key)} | ${escapeCell(row.arm)} | ${formatUsd(row.cpat)} | ${formatNumber(row.quality_score)} | ${formatNumber(row.quality_per_cost)} | ${row.n} | ${row.insufficient ? "样本不足 / insufficient" : "ok"} |`,
    );
  }
  lines.push("");

  lines.push("## 目标画像 / Targets");
  lines.push("");
  lines.push("| 目标 / Target | 首次通过 / First pass | 最终通过 / Final pass | 平均成本 / Mean cost | 平均耗时 / Mean wall | 故障率 / Failure rate | 驳回分布 / Reject reasons | 分类延迟 p50/p90 / Classifier latency | 状态 / Status |");
  lines.push("|---|---:|---:|---:|---:|---:|---|---|---|");
  for (const target of report.targets) {
    const reasons = Object.entries(target.reject_reasons)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(" ");
    const latency = `${formatMs(target.classifier_latency_p50_ms)} / ${formatMs(target.classifier_latency_p90_ms)}`;
    const style = target.style_suspected ? " ⚠ style" : "";
    lines.push(
      `| ${escapeCell(target.target)} | ${formatNumber(target.first_pass_rate)} | ${formatNumber(target.final_pass_rate)} | ${formatUsd(target.mean_cost_usd)} | ${formatMs(target.mean_wall_ms)} | ${formatNumber(target.failure_rate)} | ${escapeCell(reasons || "—")} | ${latency} | ${target.insufficient ? "样本不足 / insufficient" : "ok"}${style} |`,
    );
  }
  lines.push("");

  lines.push("## 可检出差异 / Detectability");
  lines.push("");
  lines.push("| A | B | 比值 / Ratio | 90% CI | p | MDD | nA / nB |");
  lines.push("|---|---|---:|---|---:|---:|---|");
  for (const comparison of report.detectability.comparisons) {
    lines.push(
      `| ${escapeCell(comparison.a)} | ${escapeCell(comparison.b)} | ${formatNumber(comparison.ratio)} | ${formatNumber(comparison.ci_low)} – ${formatNumber(comparison.ci_high)} | ${formatNumber(comparison.p)} | ${formatNumber(comparison.mdd)} | ${comparison.n_a} / ${comparison.n_b} |`,
    );
  }
  if (report.detectability.comparisons.length === 0) {
    lines.push(
      `| all | — | — | — | — | ${formatNumber(report.detectability.mdd)} | — |`,
    );
  }
  lines.push("");
  lines.push(
    `MDD（最小可检出差异 / minimum detectable difference）: 在 alpha=${report.detectability.alpha}、power=${report.detectability.power} 下，当前样本量与方差能检出的最小相对成本差异；样本越大，MDD 越小。`,
  );
  lines.push("");
  const labelMdd = report.detectability.by_label
    .filter((entry) => entry.mdd !== null)
    .map((entry) => `${entry.analysis_label}=${formatNumber(entry.mdd)}`)
    .join(", ");
  if (labelMdd.length > 0) {
    lines.push(`按标签 / By label: ${labelMdd}`);
    lines.push("");
  }

  lines.push("## 告警 / Alerts");
  lines.push("");
  if (report.alerts.length === 0) {
    lines.push("无 / none");
  } else {
    for (const alert of report.alerts) {
      lines.push(`- **${alert.code}**: ${escapeCell(alert.message)}`);
    }
  }
  lines.push("");

  lines.push("## 建议 / Suggestions");
  lines.push("");
  if (report.suggestions.length === 0) {
    lines.push("无 / none");
  } else {
    lines.push("| # | 字段 / Field | 当前 / From | 建议 / To | 依据 / Evidence |");
    lines.push("|---:|---|---|---|---|");
    for (const suggestion of report.suggestions) {
      lines.push(
        `| ${suggestion.n} | \`${escapeCell(suggestion.field)}\` | ${escapeCell(JSON.stringify(suggestion.from))} | ${escapeCell(JSON.stringify(suggestion.to))} | ${escapeCell(suggestion.evidence)} |`,
      );
    }
    lines.push("");
    lines.push("使用 `evener apply <n>` 应用建议 / Apply with `evener apply <n>`.");
  }
  lines.push("");

  return lines.join("\n");
}
