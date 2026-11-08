/**
 * Routing decision (spec §6).
 *
 * Order: state check → open circuits → rules → experiment arm reuse →
 * escalation for later rounds → classifier → static fallback. The module is
 * side-effect free apart from reading circuit events; the command layer appends
 * the resulting `route.decided` event.
 */

import { classifyTarget } from "./classifier.js";
import type { TaskFeatures } from "./classifier.js";
import type { Store } from "./store.js";
import type {
  ArmPolicy,
  DecidedBy,
  Label,
  Policy,
  PreFeatures,
  RouteCandidate,
  RouteDecidedPayload,
  Rule,
  TaskCreatedPayload,
  TaskRow,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A rule plus the target it selected. */
export interface RuleMatch {
  rule: Rule;
  target: string;
}

export type RuleFeatures = TaskFeatures;

/** Every `route.decided` payload field plus the decision's lock flag. */
export interface RouteDecision extends RouteDecidedPayload {
  locked: boolean;
}

export interface DecideInput {
  store: Store;
  /** The effective policy for the task's arm (already merged). */
  policy: Policy;
  /** Experiment arm name, or null when experiments are off. */
  arm: string | null;
  task: TaskRow;
  created: TaskCreatedPayload;
  env: Readonly<Record<string, string | undefined>>;
  now: string;
  fetchImpl?: typeof fetch;
}

/** Error raised for state or target problems; the command maps it to a code. */
export class RouterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Rule evaluation (spec §6 step 3)
// ---------------------------------------------------------------------------

/** Evaluate rules in order; first match wins. */
export function evaluateRules(rules: Rule[], features: RuleFeatures): RuleMatch | null {
  for (const rule of rules) {
    const condition = rule.if;
    let matched = false;

    if (condition.constraint !== undefined) {
      matched = features.constraints.includes(condition.constraint);
    } else if (condition.label !== undefined) {
      matched = features.label === condition.label;
    } else if (condition.files_mentioned_gte !== undefined) {
      matched = features.pre_features.files_mentioned >= condition.files_mentioned_gte;
    } else if (condition.description_chars_gte !== undefined) {
      matched = features.pre_features.description_chars >= condition.description_chars_gte;
    }

    if (matched) return { rule, target: rule.then };
  }

  return null;
}

function describeCondition(rule: Rule): string {
  const condition = rule.if;
  if (condition.constraint !== undefined) return `constraint=${condition.constraint}`;
  if (condition.label !== undefined) return `label=${condition.label}`;
  if (condition.files_mentioned_gte !== undefined) {
    return `files_mentioned>=${condition.files_mentioned_gte}`;
  }
  if (condition.description_chars_gte !== undefined) {
    return `description_chars>=${condition.description_chars_gte}`;
  }
  return "unknown condition";
}

// ---------------------------------------------------------------------------
// Circuits and target availability (spec §6 steps 2, 7)
// ---------------------------------------------------------------------------

/**
 * Targets whose latest `target.circuit` event is `open` and whose `until` is
 * still in the future. A null `until` is treated as closed; the breaker always
 * writes an explicit deadline.
 */
export function openCircuits(store: Store, now: string | Date): Set<string> {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  const latest = new Map<string, { state: string; until: string | null }>();

  for (const event of store.listEvents({ types: ["target.circuit"] })) {
    if (event.type !== "target.circuit") continue;
    latest.set(event.data.target, {
      state: event.data.state,
      until: event.data.until,
    });
  }

  const open = new Set<string>();
  for (const [target, circuit] of latest) {
    if (circuit.state !== "open" || circuit.until === null) continue;
    const untilMs = Date.parse(circuit.until);
    if (Number.isFinite(untilMs) && Number.isFinite(nowMs) && untilMs > nowMs) {
      open.add(target);
    }
  }
  return open;
}

function isAvailable(arm: ArmPolicy, target: string, open: ReadonlySet<string>): boolean {
  const policy = arm.targets[target];
  return policy !== undefined && policy.enabled === true && !open.has(target);
}

/**
 * First enabled, non-open target in the escalation chain, optionally after the
 * named target. Returns null when the chain has no usable entry.
 */
export function firstEnabledInChain(
  arm: ArmPolicy,
  open: ReadonlySet<string>,
  after?: string,
): string | null {
  const chain = arm.escalation.chain;
  let start = 0;
  if (after !== undefined) {
    const index = chain.indexOf(after);
    if (index >= 0) start = index + 1;
  }

  for (let index = start; index < chain.length; index += 1) {
    const target = chain[index];
    if (target !== undefined && isAvailable(arm, target, open)) return target;
  }
  return null;
}

/**
 * `fallback_table[label]`, then `fallback_table.unknown`, then `host`. If that
 * target is disabled/open, walk the escalation chain after it.
 */
export function fallbackTarget(
  arm: ArmPolicy,
  label: Label,
  open: ReadonlySet<string>,
): string | null {
  const preferred = arm.fallback_table[label] ?? arm.fallback_table.unknown ?? "host";
  if (isAvailable(arm, preferred, open)) return preferred;
  return firstEnabledInChain(arm, open, preferred);
}

// ---------------------------------------------------------------------------
// Decision assembly
// ---------------------------------------------------------------------------

interface Chosen {
  target: string;
  candidates: RouteCandidate[];
  rationale: string;
  decided_by: DecidedBy;
  rule_id: string | null;
  classifier_model: string | null;
  classifier_latency_ms: number | null;
  classifier_cost_usd: number | null;
  escalated_from: string | null;
  locked: boolean;
}

function toDecision(arm: string | null, chosen: Chosen): RouteDecision {
  return {
    target: chosen.target,
    candidates: chosen.candidates,
    rationale: chosen.rationale,
    decided_by: chosen.decided_by,
    rule_id: chosen.rule_id,
    classifier_model: chosen.classifier_model,
    classifier_latency_ms: chosen.classifier_latency_ms,
    classifier_cost_usd: chosen.classifier_cost_usd,
    arm,
    escalated_from: chosen.escalated_from,
    locked: chosen.locked,
  };
}

function ruleDecision(rule: Rule, target: string): Chosen {
  return {
    target,
    candidates: [{ target, score: 1 }],
    rationale: `rule "${rule.id}" matched ${describeCondition(rule)}`,
    decided_by: "rule",
    rule_id: rule.id,
    classifier_model: null,
    classifier_latency_ms: null,
    classifier_cost_usd: null,
    escalated_from: null,
    locked: rule.locked === true,
  };
}

function fallbackDecision(
  target: string,
  label: Label,
  why: string,
): Chosen {
  return {
    target,
    candidates: [{ target, score: 1 }],
    rationale: `${why}; fallback_table[${label}] -> ${target}`,
    decided_by: "fallback",
    rule_id: null,
    classifier_model: null,
    classifier_latency_ms: null,
    classifier_cost_usd: null,
    escalated_from: null,
    locked: false,
  };
}

function assertDecidable(task: TaskRow): void {
  if (task.current_round === 1) {
    if (task.state !== "created") {
      throw new RouterError(
        "invalid_state",
        `task ${task.task_id} is ${task.state}; decide requires created on round 1`,
      );
    }
    return;
  }

  if (task.state !== "awaiting_acceptance") {
    throw new RouterError(
      "invalid_state",
      `task ${task.task_id} is ${task.state}; decide requires awaiting_acceptance after round 1`,
    );
  }
}

function taskFeatures(
  policy: Policy,
  created: TaskCreatedPayload,
  preFeatures: PreFeatures,
): RuleFeatures {
  return {
    label: created.analysis_label,
    pre_features: preFeatures,
    constraints: created.constraints,
    excerpt: policy.privacy.store_description_excerpt ? created.description_excerpt : null,
  };
}

// ---------------------------------------------------------------------------
// decide (spec §6 steps 1–7)
// ---------------------------------------------------------------------------

export async function decide(input: DecideInput): Promise<RouteDecision> {
  const { store, policy, arm, task, created, env, now } = input;

  // 1. State.
  assertDecidable(task);

  // 2. Circuits are treated as disabled for this decision.
  const open = openCircuits(store, now);

  const features = taskFeatures(policy, created, created.pre_features);
  const armPolicy: ArmPolicy = policy;

  // 3. Rules, evaluated in order. A rule whose target is unavailable for this
  //    decision is skipped so the result always names a usable target.
  let remaining = armPolicy.rules;
  while (remaining.length > 0) {
    const match = evaluateRules(remaining, features);
    if (match === null) break;
    if (isAvailable(armPolicy, match.target, open)) {
      return toDecision(arm, ruleDecision(match.rule, match.target));
    }
    const index = remaining.indexOf(match.rule);
    remaining = index >= 0 ? remaining.slice(index + 1) : [];
  }

  // 4./5. Later rounds reuse the escalation target chosen by `next`; the
  //      classifier is only consulted for the first round.
  if (task.current_round > 1) {
    const current = task.current_target;
    if (current !== null && isAvailable(armPolicy, current, open)) {
      return toDecision(arm, {
        target: current,
        candidates: [{ target: current, score: 1 }],
        rationale: `round ${task.current_round} keeps escalation target "${current}"`,
        decided_by: "rule",
        rule_id: "escalation",
        classifier_model: null,
        classifier_latency_ms: null,
        classifier_cost_usd: null,
        escalated_from: null,
        locked: false,
      });
    }

    const next = fallbackTarget(armPolicy, created.analysis_label, open);
    if (next === null) {
      throw new RouterError("no_target", "no enabled target is available for this decision");
    }
    return toDecision(
      arm,
      fallbackDecision(next, created.analysis_label, "escalation target unavailable"),
    );
  }

  // 6. Classifier, when configured.
  if (armPolicy.classifier.model !== null) {
    const result = await classifyTarget(armPolicy, features, env, input.fetchImpl);
    if (result.ok) {
      if (isAvailable(armPolicy, result.target, open)) {
        const candidates = Object.entries(result.scores)
          .map(([target, score]) => ({ target, score }))
          .sort((left, right) => right.score - left.score);
        return toDecision(arm, {
          target: result.target,
          candidates,
          rationale: result.rationale,
          decided_by: "classifier",
          rule_id: null,
          classifier_model: result.model,
          classifier_latency_ms: result.latency_ms,
          classifier_cost_usd: result.cost_usd,
          escalated_from: null,
          locked: false,
        });
      }
      // The classifier picked a target that an open circuit disabled.
    }
  }

  // 7. Static fallback.
  const fallback = fallbackTarget(armPolicy, created.analysis_label, open);
  if (fallback === null) {
    throw new RouterError("no_target", "no enabled target is available for this decision");
  }
  const why =
    armPolicy.classifier.model === null
      ? "classifier not configured"
      : "classifier did not produce a usable target";
  return toDecision(arm, fallbackDecision(fallback, created.analysis_label, why));
}
