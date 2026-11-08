/**
 * Experiment arm assignment.
 *
 * v1 has two assignments: uniformly random, and a deterministic label-stratified
 * hash bucket based on the task id. The arm is recorded on every task event.
 */

import { randomInt } from "node:crypto";
import { sha256 } from "./util.js";
import type { Label, Policy } from "./types.js";

/**
 * Pick an arm for a new task, or null when experiments are off / no arms are
 * configured. Arm names are sorted so the deterministic mapping is stable.
 */
export function assignArm(policy: Policy, taskId: string, _label: Label): string | null {
  if (policy.experiment.mode === "off") return null;

  const arms = Object.keys(policy.experiment.arms).sort();
  if (arms.length === 0) return null;

  if (policy.experiment.assignment === "by_label_stratified") {
    // parseInt of the first 8 hex chars is a stable 32-bit bucket.
    const bucket = parseInt(sha256(taskId).slice(0, 8), 16) % arms.length;
    return arms[bucket] ?? null;
  }

  const index = randomInt(arms.length);
  return arms[index] ?? null;
}
