/**
 * Fixed-taxonomy analysis labeler.
 *
 * With `labeler.model` configured the description is sent through the shared
 * classifier transport with a fixed prompt; otherwise the deterministic
 * keyword heuristic is used. Any model failure also falls back to the
 * heuristic. This label never influences routing.
 */

import { labelWithModel } from "./classifier.js";
import { LABELS } from "./types.js";
import type { Label, Policy } from "./types.js";

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

function isLabel(value: string): value is Label {
  return (LABELS as readonly string[]).includes(value);
}

/**
 * Label a task. With no model configured this is the deterministic heuristic;
 * with one configured the fixed-prompt model is used and a failure falls back
 * to the heuristic. Labeling must never fail a task.
 */
export async function labelTask(
  description: string,
  policy: Policy,
  io: LabelerIO = {},
): Promise<{ label: Label; labeler_model: string }> {
  const heuristic = labelHeuristic(description);
  const model = policy.labeler.model;

  if (model === null) {
    return { label: heuristic, labeler_model: "heuristic" };
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
    // `labelWithModel` reports failures as `unknown`; keep the deterministic
    // heuristic as the labeler's fallback in that case.
    if (isLabel(result) && result !== "unknown") {
      return { label: result, labeler_model: model };
    }
  } catch {
    // Fall through to the heuristic; labeling must never fail a task.
  }

  return { label: heuristic, labeler_model: "heuristic" };
}
