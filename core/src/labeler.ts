/**
 * Fixed-taxonomy analysis labeler.
 *
 * The heuristic path is fully implemented here. T3 wires the model path by
 * passing a `labelerModelCall` backed by `classifier.ts`; until then the model
 * branch is intentionally inert and falls back to the heuristic. This label
 * never influences routing.
 */

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

/** Inputs the eventual model-backed labeler will need. */
export interface LabelerIO {
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Optional model call. T3 supplies this from `classifier.ts`; `null` means the
 * model could not produce a usable label and the heuristic should be used.
 */
export type LabelerModelCall = (
  description: string,
  policy: Policy,
  io: LabelerIO,
) => Promise<Label | null>;

function isLabel(value: unknown): value is Label {
  return typeof value === "string" && (LABELS as readonly string[]).includes(value);
}

/**
 * Label a task. With no model configured, or no model call wired yet, this is
 * the deterministic heuristic. A failed model call also falls back.
 */
export async function labelTask(
  description: string,
  policy: Policy,
  io: LabelerIO = {},
  labelerModelCall?: LabelerModelCall,
): Promise<{ label: Label; labeler_model: string }> {
  const heuristic = labelHeuristic(description);
  const model = policy.labeler.model;

  if (model === null || labelerModelCall === undefined) {
    return { label: heuristic, labeler_model: "heuristic" };
  }

  try {
    const result = await labelerModelCall(description, policy, io);
    if (isLabel(result)) {
      return { label: result, labeler_model: model };
    }
  } catch {
    // Fall through to the heuristic; labeling must never fail a task.
  }

  return { label: heuristic, labeler_model: "heuristic" };
}
