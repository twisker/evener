/**
 * `evener apply <n>` — apply one saved report suggestion to a policy file.
 *
 * The report is the only source of the change; the policy file is edited in
 * place with the `yaml` document API so comments and unrelated layout survive.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { loadEffectivePolicy, loadPolicy } from "./config.js";

/** Error raised when a suggestion cannot be applied. */
export class ApplyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApplyError";
    this.code = code;
  }
}

export interface ApplyResult {
  field: string;
  from: unknown;
  to: unknown;
  policy_version: string;
}

interface LoadedSuggestion {
  n: number;
  field: string;
  from: unknown;
  to: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadSuggestions(reportFile: string): LoadedSuggestion[] {
  let text: string;
  try {
    text = readFileSync(reportFile, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ApplyError(
      code === "ENOENT" ? "report_not_found" : "report_read_error",
      `cannot read report ${reportFile}: ${String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ApplyError("invalid_report", `report ${reportFile} is not valid JSON: ${String(err)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["suggestions"])) {
    throw new ApplyError(
      "invalid_report",
      `report ${reportFile} has no suggestions array`,
    );
  }

  const suggestions: LoadedSuggestion[] = [];
  for (const entry of parsed["suggestions"]) {
    if (!isRecord(entry)) continue;
    const n = entry["n"];
    const field = entry["field"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) continue;
    if (typeof field !== "string" || field.length === 0) continue;
    suggestions.push({ n, field, from: entry["from"], to: entry["to"] });
  }
  return suggestions;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === "number" && typeof right === "number") {
    return Number.isNaN(left) && Number.isNaN(right);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        valuesEqual(left[key], right[key]),
    );
  }
  return false;
}

function splitField(field: string): string[] {
  const parts = field.split(".").filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new ApplyError("invalid_field", `invalid suggestion field: ${field}`);
  }
  return parts;
}

function targetPolicyFile(home: string, arm: string | undefined): string {
  const topPath = join(home, "policy.yaml");
  const top = loadPolicy(topPath);
  if (arm === undefined || arm.length === 0) return topPath;

  const relative = top.experiment.arms[arm];
  if (typeof relative !== "string" || relative.length === 0) {
    throw new ApplyError(
      "unknown_arm",
      `experiment arm "${arm}" is not defined in ${topPath}`,
    );
  }
  return isAbsolute(relative) ? relative : resolve(home, relative);
}

/**
 * Apply suggestion `n` (1-based) from a saved report.
 *
 * The edit is conditional: when the current value at `field` no longer equals
 * the suggestion's `from`, the call fails with code `stale` and leaves the file
 * untouched.
 */
export function applySuggestion(
  home: string,
  reportFile: string,
  n: number,
  arm?: string,
): ApplyResult {
  if (!Number.isInteger(n) || n < 1) {
    throw new ApplyError("invalid_arguments", "suggestion number must be a positive integer");
  }

  const suggestions = loadSuggestions(reportFile);
  const suggestion = suggestions.find((entry) => entry.n === n);
  if (suggestion === undefined) {
    throw new ApplyError("suggestion_not_found", `report has no suggestion ${n}`);
  }

  const pathParts = splitField(suggestion.field);
  const file = targetPolicyFile(home, arm);

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new ApplyError(
      "policy_not_found",
      `cannot read policy file ${file}: ${String(err)}`,
    );
  }

  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new ApplyError(
      "invalid_yaml",
      `cannot parse policy file ${file}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }

  let current = document.getIn(pathParts);
  // An absent numeric bias means the policy default is zero; treat it as 0 so
  // the first suggestion for a new label/target can be applied.
  if (current === undefined && typeof suggestion.from === "number" && suggestion.from === 0) {
    current = 0;
  }
  if (!valuesEqual(current, suggestion.from)) {
    throw new ApplyError(
      "stale",
      `stale: policy value at ${suggestion.field} is ${JSON.stringify(current)}, expected ${JSON.stringify(suggestion.from)}`,
    );
  }

  document.setIn(pathParts, suggestion.to);
  const updated = document.toString();
  writeFileSync(file, updated, "utf8");

  let policyVersionValue: string;
  try {
    policyVersionValue = loadEffectivePolicy(home, { arm }).policy_version;
  } catch (err) {
    // Never leave an invalid policy behind if validation rejects the edit.
    writeFileSync(file, text, "utf8");
    throw err;
  }

  return {
    field: suggestion.field,
    from: suggestion.from,
    to: suggestion.to,
    policy_version: policyVersionValue,
  };
}
