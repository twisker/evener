/**
 * Shared event, policy and storage types.
 *
 * This module is the single source of truth for every closed enum in the
 * protocol. The runtime const arrays are used by validation and by the
 * classifier/labeler prompts; the literal union types are derived from them so
 * the two can never drift apart.
 */

// ---------------------------------------------------------------------------
// Closed enums (spec §4 and §5)
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  "task.created",
  "route.decided",
  "dispatch.started",
  "dispatch.finished",
  "acceptance.finished",
  "task.redispatch",
  "task.closed",
  "user.feedback",
  "user.override",
  "post.revert",
  "target.circuit",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const VERDICTS = ["accepted", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const REJECT_REASONS = [
  "tests_failed",
  "build_failed",
  "out_of_scope",
  "incomplete",
  "style",
  "misunderstood",
  "regression",
  "other",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const DISPATCH_STATUSES = [
  "success",
  "error",
  "timeout",
  "budget_exceeded",
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export const OUTCOMES = ["accepted", "handed_to_human", "abandoned"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const LABELS = [
  "bugfix",
  "feature",
  "refactor",
  "test",
  "docs",
  "mechanical",
  "question",
  "unknown",
] as const;
export type Label = (typeof LABELS)[number];

export const LANGUAGES = [
  "ts",
  "js",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "rb",
  "php",
  "cs",
  "cpp",
  "c",
  "swift",
  "sh",
  "sql",
  "md",
  "yaml",
  "json",
  "other",
] as const;
export type Language = (typeof LANGUAGES)[number];

export const TIME_BUCKETS = ["lt15m", "15m_1h", "1h_4h", "gt4h", "unknown"] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

/** The three bounded heuristic buckets, walked in order. */
export const TIME_BUCKET_HEURISTIC_KEYS = ["lt15m", "15m_1h", "1h_4h"] as const;
export type HeuristicTimeBucket = (typeof TIME_BUCKET_HEURISTIC_KEYS)[number];

export const DECIDED_BY_VALUES = [
  "rule",
  "classifier",
  "fallback",
  "override",
] as const;
export type DecidedBy = (typeof DECIDED_BY_VALUES)[number];

export const CHECK_NAMES = ["tests", "lint", "build", "scope", "other"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export const CHECK_RESULTS = ["pass", "fail", "skipped"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const REVIEW_VERDICTS = ["pass", "fail", "skipped"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const CONTEXT_DELTAS = ["added", "modified", "unchanged"] as const;
export type ContextDelta = (typeof CONTEXT_DELTAS)[number];

export const REDISPATCH_KINDS = ["retry", "escalate"] as const;
export type RedispatchKind = (typeof REDISPATCH_KINDS)[number];

export const EXPERIMENT_MODES = ["off", "interleave", "bandit"] as const;
export type ExperimentMode = (typeof EXPERIMENT_MODES)[number];

export const ASSIGNMENTS = ["random", "by_label_stratified"] as const;
export type Assignment = (typeof ASSIGNMENTS)[number];

export const RATINGS = ["up", "down"] as const;
export type Rating = (typeof RATINGS)[number];

export const CIRCUIT_STATES = ["open", "closed"] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

export const COST_TIERS = ["low", "mid", "high"] as const;
export type CostTier = (typeof COST_TIERS)[number];

export const TASK_STATES = [
  "created",
  "routed",
  "dispatching",
  "awaiting_acceptance",
  "closed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

// ---------------------------------------------------------------------------
// Event schema (spec §4)
// ---------------------------------------------------------------------------

export interface Envelope {
  event_id: string;
  task_id: string;
  round: number;
  ts: string;
  type: EventType;
  host: string;
  host_session_id: string | null;
  policy_version: string;
  schema_version: 1;
  data: object;
}

export interface PreFeatures {
  description_chars: number;
  files_mentioned: number;
  repo_files: number | null;
  /** Most frequent extension among files/tokens, or null when none were seen. */
  language: Language | null;
  has_repro: boolean;
  cross_file: boolean;
  time_bucket: TimeBucket;
}

export interface TaskCreatedPayload {
  description_hash: string;
  description_excerpt: string | null;
  repo_fingerprint: string | null;
  pre_features: PreFeatures;
  analysis_label: Label;
  labeler_model: string;
  constraints: string[];
}

export interface RouteCandidate {
  target: string;
  score: number;
}

export interface RouteDecidedPayload {
  target: string;
  candidates: RouteCandidate[];
  rationale: string;
  decided_by: DecidedBy;
  rule_id: string | null;
  classifier_model: string | null;
  classifier_latency_ms: number | null;
  classifier_cost_usd: number | null;
  arm: string | null;
  escalated_from: string | null;
}

export interface DispatchStartedPayload {
  target: string;
  target_version: string | null;
  model: string | null;
  context_bytes: number;
  command: string;
}

export interface NormalisedUsage {
  input: number;
  cached_input: number;
  output: number;
  reasoning: number;
}

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface DispatchFinishedPayload {
  status: DispatchStatus;
  wall_ms: number;
  usage: NormalisedUsage;
  usage_raw: Record<string, unknown>;
  cost_usd: number;
  price_table_version: string;
  diff_stats: DiffStats | null;
  tool_calls: number | null;
  exit_code: number | null;
  target_session_id: string | null;
  output_path: string | null;
}

export interface AcceptanceCheck {
  name: CheckName;
  result: CheckResult;
}

export interface AcceptanceFinishedPayload {
  verdict: Verdict;
  checks: AcceptanceCheck[];
  review_verdict: ReviewVerdict;
  reject_reason: RejectReason | null;
  reviewer_cost_usd: number;
  reviewer_wall_ms: number;
}

export interface TaskRedispatchPayload {
  reason: string;
  context_delta: ContextDelta;
  next_target: string;
  kind: RedispatchKind;
}

export interface TaskClosedPayload {
  outcome: Outcome;
  total_rounds: number;
  total_cost_usd: number;
  total_wall_ms: number;
}

export interface UserFeedbackPayload {
  rating: Rating;
  comment: string | null;
}

export interface UserOverridePayload {
  from: string;
  to: string;
}

export interface PostRevertPayload {
  days_after: number;
  reverted_ratio: number;
}

export interface TargetCircuitPayload {
  target: string;
  state: CircuitState;
  until: string | null;
}

/** Payload shape keyed by event type. */
export interface PayloadByType {
  "task.created": TaskCreatedPayload;
  "route.decided": RouteDecidedPayload;
  "dispatch.started": DispatchStartedPayload;
  "dispatch.finished": DispatchFinishedPayload;
  "acceptance.finished": AcceptanceFinishedPayload;
  "task.redispatch": TaskRedispatchPayload;
  "task.closed": TaskClosedPayload;
  "user.feedback": UserFeedbackPayload;
  "user.override": UserOverridePayload;
  "post.revert": PostRevertPayload;
  "target.circuit": TargetCircuitPayload;
}

/** Discriminated union over `type`, with the matching payload in `data`. */
export type EvenerEvent = {
  [K in EventType]: Omit<Envelope, "type" | "data"> & {
    type: K;
    data: PayloadByType[K];
  };
}[EventType];

// ---------------------------------------------------------------------------
// Policy schema (spec §5)
// ---------------------------------------------------------------------------

export interface ClassifierPrice {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface ClassifierConfig {
  model: string | null;
  endpoint: string;
  api_key_env: string;
  timeout_ms: number;
  temperature: number;
  max_tokens: number;
  price: ClassifierPrice;
}

export interface LabelerConfig {
  model: string | null;
  endpoint: string | null;
  api_key_env: string | null;
  /** Heuristic time estimates, walked in this order. */
  time_bucket_heuristic: TimeBucketHeuristic;
  /** Free text appended to the model labeler prompt. */
  prompt_extra: string | null;
}

export interface TimeBucketThreshold {
  max_files: number;
  max_chars: number;
}

export type TimeBucketHeuristic = Record<HeuristicTimeBucket, TimeBucketThreshold>;

export interface Taxonomy {
  labels: Label[];
}

export interface TargetPolicy {
  description: string;
  /** Absent for `host`, which runs in the current host session. */
  command?: string[];
  /** For pricing only; null means cost is unknown and recorded as 0. */
  model?: string | null;
  /** Presence check only. */
  api_key_env?: string | null;
  cost_tier: CostTier;
  strengths?: Label[];
  weaknesses?: Label[];
  enabled: boolean;
}

/**
 * A rule may contain one or more conditions; all present conditions must hold
 * (AND). Every field is optional in the type so validation can report an empty
 * condition, but a valid policy always carries at least one.
 */
export interface RuleCondition {
  constraint?: string;
  label?: Label;
  files_mentioned_gte?: number;
  description_chars_gte?: number;
  time_bucket?: TimeBucket;
  language?: Language;
  has_repro?: boolean;
  cross_file?: boolean;
}

export interface Rule {
  id: string;
  if: RuleCondition;
  then: string;
  locked?: boolean;
}

export interface Preferences {
  cost_weight: number;
  quality_weight: number;
  per_label_bias: Partial<Record<Label, Record<string, number>>>;
}

export interface Escalation {
  chain: string[];
  retry_same_target_once: boolean;
  escalate_on_reasons: RejectReason[];
  never_escalate_on: RejectReason[];
  force_escalate_after_same_reason: number;
}

export interface CircuitBreakerConfig {
  failures: number;
  open_minutes: number;
}

export interface Limits {
  max_rounds_per_task: number;
  max_cost_per_task_usd: number;
  max_wall_per_round_s: number;
  daily_budget_usd: number | null;
  acceptance_overhead_warn_task_ratio: number;
  acceptance_overhead_warn_weekly_ratio: number;
  circuit_breaker: CircuitBreakerConfig;
}

export interface Privacy {
  store_description_excerpt: boolean;
  private_paths: string[];
  never_delegate_repos: string[];
}

export interface Experiment {
  mode: ExperimentMode;
  /** Arm name -> policy file path relative to EVENER_HOME. */
  arms: Record<string, string>;
  assignment: Assignment;
  alpha: number;
  power: number;
}

export interface QualityWeights {
  first_pass: number;
  final_pass: number;
  feedback: number;
  revert: number;
}

export interface ClaudeCodeHostConfig {
  confirm_before_dispatch: boolean;
  route_subagent_tasks: boolean;
}

export interface HostConfig {
  claude_code: ClaudeCodeHostConfig;
}

export interface Policy {
  schema_version: 1;
  policy_name: string;
  classifier: ClassifierConfig;
  labeler: LabelerConfig;
  taxonomy: Taxonomy;
  targets: Record<string, TargetPolicy>;
  rules: Rule[];
  fallback_table: Partial<Record<Label, string>>;
  preferences: Preferences;
  escalation: Escalation;
  limits: Limits;
  privacy: Privacy;
  experiment: Experiment;
  quality_weights: QualityWeights;
  style_rejection_suspect_ratio: number;
  host: HostConfig;
}

/**
 * The routing-relevant sections supplied by an experiment arm file. The
 * top-level experiment file supplies experiment/limits/privacy/host/
 * quality_weights instead.
 */
export interface ArmPolicy {
  classifier: ClassifierConfig;
  labeler: LabelerConfig;
  targets: Record<string, TargetPolicy>;
  rules: Rule[];
  fallback_table: Partial<Record<Label, string>>;
  preferences: Preferences;
  escalation: Escalation;
}

// ---------------------------------------------------------------------------
// Pricing schema (spec §5)
// ---------------------------------------------------------------------------

export interface ModelPrice {
  input_per_mtok: number;
  cached_input_per_mtok: number;
  output_per_mtok: number;
}

export interface Pricing {
  schema_version: 1;
  models: Record<string, ModelPrice>;
}

// ---------------------------------------------------------------------------
// Store projection (spec §4 DDL)
// ---------------------------------------------------------------------------

export interface TaskRow {
  task_id: string;
  created_ts: string;
  closed_ts: string | null;
  host: string;
  host_session_id: string | null;
  analysis_label: Label;
  language: Language | null;
  has_repro: boolean;
  cross_file: boolean;
  time_bucket: TimeBucket;
  arm: string | null;
  policy_version: string;
  current_round: number;
  current_target: string | null;
  state: TaskState;
  outcome: Outcome | null;
  /** 1 if round 1 was accepted, 0 otherwise, null while open/unknown. */
  first_pass: number | null;
  total_cost_usd: number;
  total_wall_ms: number;
  rating: Rating | null;
  /** 1 if a user override was applied, 0 otherwise. */
  overridden: number;
}
