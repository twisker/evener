/**
 * Fixed-taxonomy analysis labeler.
 *
 * With `labeler.model` configured the description is sent through the shared
 * classifier transport with a fixed prompt; otherwise the deterministic
 * keyword heuristic is used. Any model failure also falls back to the
 * heuristic. This label never influences routing.
 */

import { labelWithModel } from "./classifier.js";
import { timeBucketHeuristic } from "./features.js";
import { LABELS } from "./types.js";
import type { Label, Policy, PreFeatures, TimeBucket } from "./types.js";

const BUGFIX = /fix|bug|crash|error|regression|broken/;
const MECHANICAL = /rename|move|migrate|format|lint|boilerplate|bulk|batch|replace all/;
const REFACTOR = /refactor|extract|cleanup|simplify|restructure/;
const TEST = /test|spec|coverage/;
const DOCS = /doc|readme|comment|changelog/;
const FEATURE = /add|implement|feature|support|new/;
const QUESTION_START = /^(why|what|how|explain|where)\b/;

/**
 * Keyword heuristic, first match wins in this order:
 * bugfix, question, mechanical, refactor, test, docs, feature, unknown.
 */
export function labelHeuristic(description: string): Label {
  const lower = description.toLowerCase();
  const trimmed = lower.trim();

  if (BUGFIX.test(lower)) return "bugfix";
  if (trimmed.endsWith("?") || QUESTION_START.test(trimmed)) return "question";
  if (MECHANICAL.test(lower)) return "mechanical";
  if (REFACTOR.test(lower)) return "refactor";
  if (TEST.test(lower)) return "test";
  if (DOCS.test(lower)) return "docs";
  if (FEATURE.test(lower)) return "feature";
  return "unknown";
}

/** Inputs available to the model-backed labeler. */
export interface LabelerIO {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
}

export interface LabelTaskResult {
  label: Label;
  labeler_model: string;
  time_bucket: TimeBucket;
  /** Model value when it is a boolean, otherwise null. */
  has_repro: boolean | null;
  labeler_cost_usd: number | null;
  labeler_latency_ms: number | null;
  warning: string | null;
}

function isLabel(value: string): value is Label {
  return (LABELS as readonly string[]).includes(value);
}

/**
 * Label a task and estimate its time bucket. With no model configured this is
 * the deterministic heuristic; with one configured the fixed-prompt model is
 * used and a failure falls back to the heuristic with a warning. An invalid
 * model time bucket alone falls back to the heuristic bucket. Labeling must
 * never fail a task.
 *
 * `preFeatures` is used for the heuristic fallback; when omitted the bucket is
 * `"unknown"` (the caller normally passes the computed features).
 */
export async function labelTask(
  description: string,
  policy: Policy,
  io: LabelerIO = {},
  preFeatures?: Pick<PreFeatures, "files_mentioned" | "description_chars">,
): Promise<LabelTaskResult> {
  const heuristic = labelHeuristic(description);
  const heuristicBucket: TimeBucket =
    preFeatures === undefined
      ? "unknown"
      : timeBucketHeuristic(preFeatures, policy.labeler.time_bucket_heuristic);
  const model = policy.labeler.model;

  if (model === null) {
    return {
      label: heuristic,
      labeler_model: "heuristic",
      time_bucket: heuristicBucket,
      has_repro: null,
      labeler_cost_usd: null,
      labeler_latency_ms: null,
      warning: null,
    };
  }

  try {
    const result = await labelWithModel(
      policy.labeler,
      policy.taxonomy,
      description,
      io.env ?? {},
      io.fetchImpl,
      policy.classifier,
    );
    if (result.error === null && isLabel(result.label)) {
      return {
        label: result.label,
        labeler_model: model,
        time_bucket: result.time_bucket ?? heuristicBucket,
        has_repro: result.has_repro,
        labeler_cost_usd: result.cost_usd,
        labeler_latency_ms: result.latency_ms,
        warning: null,
      };
    }
    return {
      label: heuristic,
      labeler_model: "heuristic",
      time_bucket: heuristicBucket,
      has_repro: null,
      labeler_cost_usd: result.cost_usd,
      labeler_latency_ms: result.latency_ms,
      warning: `labeler: ${result.error ?? "parse: invalid label"}; fell back to heuristic`,
    };
  } catch (err) {
    // Fall through to the heuristic; labeling must never fail a task.
    const message = err instanceof Error ? err.message : String(err);
    return {
      label: heuristic,
      labeler_model: "heuristic",
      time_bucket: heuristicBucket,
      has_repro: null,
      labeler_cost_usd: null,
      labeler_latency_ms: null,
      warning: `labeler: parse: ${message}; fell back to heuristic`,
    };
  }
}
