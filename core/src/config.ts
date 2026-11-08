import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { sha256 } from "./util.js";
import {
  ASSIGNMENTS,
  COST_TIERS,
  EXPERIMENT_MODES,
  LABELS,
  LANGUAGES,
  REJECT_REASONS,
  TIME_BUCKET_HEURISTIC_KEYS,
  TIME_BUCKETS,
} from "./types.js";
import type {
  ExperimentMode,
  Label,
  Language,
  Policy,
  Pricing,
  RejectReason,
  TimeBucket,
} from "./types.js";

// Re-exported for callers that only import from config.
export type { Policy, Pricing } from "./types.js";

export interface ValidationIssue {
  /** JSON pointer, e.g. `/rules/0/then`; empty string means the document root. */
  path: string;
  message: string;
}

export type PolicyValidationResult =
  | {
      ok: true;
      policy: Policy;
      errors: ValidationIssue[];
      warnings: ValidationIssue[];
    }
  | {
      ok: false;
      errors: ValidationIssue[];
      warnings: ValidationIssue[];
    };

export type PricingValidationResult =
  | {
      ok: true;
      pricing: Pricing;
      errors: ValidationIssue[];
      warnings: ValidationIssue[];
    }
  | {
      ok: false;
      errors: ValidationIssue[];
      warnings: ValidationIssue[];
    };

export interface EffectivePolicy {
  policy: Policy;
  policy_version: string;
  arm: string | null;
}

export interface ConfigErrorOptions {
  code?: string;
  exitCode?: number;
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
}

/** Error raised for unreadable or invalid configuration files. */
export class ConfigError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly errors: ValidationIssue[];
  readonly warnings: ValidationIssue[];

  constructor(message: string, opts: ConfigErrorOptions = {}) {
    super(message);
    this.name = "ConfigError";
    this.code = opts.code ?? "invalid_config";
    this.exitCode = opts.exitCode ?? 2;
    this.errors = opts.errors ?? [];
    this.warnings = opts.warnings ?? [];
  }
}

// ---------------------------------------------------------------------------
// Paths / home
// ---------------------------------------------------------------------------

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/**
 * Resolve the Evener home directory: `--home` > `$EVENER_HOME` > `~/.evener`.
 * The result is always absolute.
 */
export function resolveHome(
  opts: { home?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): string {
  const env = opts.env ?? process.env;
  const fromFlag = opts.home?.trim();
  const fromEnv = env["EVENER_HOME"]?.trim();
  const chosen = fromFlag || fromEnv || join(homedir(), ".evener");
  return resolve(expandHome(chosen));
}

let cachedTemplatesDir: string | undefined;

/** Absolute path to the packaged YAML templates. */
export function templatesDir(): string {
  if (cachedTemplatesDir !== undefined) return cachedTemplatesDir;

  // dist/src/config.js -> core/templates; src/config.ts -> core/templates as
  // well under ts-node/tsx-style source execution.
  const candidates = [
    fileURLToPath(new URL("../../templates", import.meta.url)),
    fileURLToPath(new URL("../templates", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "policy.default.yaml"))) {
      cachedTemplatesDir = candidate;
      return candidate;
    }
  }
  cachedTemplatesDir = candidates[0] ?? join(process.cwd(), "templates");
  return cachedTemplatesDir;
}

export function policyTemplatePath(): string {
  return join(templatesDir(), "policy.default.yaml");
}

export function pricingTemplatePath(): string {
  return join(templatesDir(), "pricing.default.yaml");
}

// ---------------------------------------------------------------------------
// YAML reading helpers
// ---------------------------------------------------------------------------

type ReadYamlResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; issue: ValidationIssue };

function readYamlDocument(file: string): ReadYamlResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = code === "ENOENT" ? `file not found: ${file}` : `cannot read ${file}: ${String(err)}`;
    return {
      ok: false,
      code: code === "ENOENT" ? "file_not_found" : "file_read_error",
      issue: { path: "", message },
    };
  }

  try {
    return { ok: true, value: parseYaml(text) };
  } catch (err) {
    return {
      ok: false,
      code: "yaml_parse_error",
      issue: { path: "", message: `invalid YAML in ${file}: ${String(err)}` },
    };
  }
}

// ---------------------------------------------------------------------------
// Defaults (single source: the YAML templates)
// ---------------------------------------------------------------------------

export function defaultPolicy(): Policy {
  const result = readYamlDocument(policyTemplatePath());
  if (!result.ok) {
    throw new ConfigError(result.issue.message, { code: result.code, exitCode: 1, errors: [result.issue] });
  }
  // YAML parse boundary: the template is trusted and validated by tests.
  return result.value as Policy;
}

export function defaultPricing(): Pricing {
  const result = readYamlDocument(pricingTemplatePath());
  if (!result.ok) {
    throw new ConfigError(result.issue.message, { code: result.code, exitCode: 1, errors: [result.issue] });
  }
  // YAML parse boundary: the template is trusted and validated by tests.
  return result.value as Pricing;
}

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalise(value[key]);
    }
    return out;
  }
  return value;
}

/** JSON with object keys sorted recursively (arrays keep their order). */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalise(value)) ?? "";
}

/** First 12 hex chars of the canonical policy hash. */
export function policyVersion(policy: Policy): string {
  return sha256(canonicalStringify(policy)).slice(0, 12);
}

/** First 12 hex chars of the canonical pricing hash. */
export function pricingVersion(pricing: Pricing): string {
  return sha256(canonicalStringify(pricing)).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Validation: shared plumbing
// ---------------------------------------------------------------------------

const POLICY_KEYS = [
  "schema_version",
  "policy_name",
  "classifier",
  "labeler",
  "taxonomy",
  "targets",
  "rules",
  "fallback_table",
  "preferences",
  "escalation",
  "limits",
  "privacy",
  "experiment",
  "quality_weights",
  "style_rejection_suspect_ratio",
  "host",
] as const;

/** Sections that must be present in a top-level policy file. */
const REQUIRED_POLICY_KEYS = [
  "schema_version",
  "policy_name",
  "classifier",
  "taxonomy",
  "targets",
  "rules",
  "fallback_table",
] as const;

const CLASSIFIER_KEYS = [
  "model",
  "endpoint",
  "api_key_env",
  "timeout_ms",
  "temperature",
  "max_tokens",
  "price",
] as const;
const CLASSIFIER_PRICE_KEYS = ["input_per_mtok", "output_per_mtok"] as const;
const LABELER_KEYS = ["model", "endpoint", "api_key_env", "time_bucket_heuristic", "prompt_extra"] as const;
const TIME_BUCKET_THRESHOLD_KEYS = ["max_files", "max_chars"] as const;
const TAXONOMY_KEYS = ["labels"] as const;
const TARGET_KEYS = [
  "description",
  "command",
  "model",
  "api_key_env",
  "cost_tier",
  "strengths",
  "weaknesses",
  "enabled",
] as const;
const RULE_KEYS = ["id", "if", "then", "locked"] as const;
const CONDITION_KEYS = [
  "constraint",
  "label",
  "files_mentioned_gte",
  "description_chars_gte",
  "time_bucket",
  "language",
  "has_repro",
  "cross_file",
] as const;
const PREFERENCES_KEYS = ["cost_weight", "quality_weight", "per_label_bias"] as const;
const ESCALATION_KEYS = [
  "chain",
  "retry_same_target_once",
  "escalate_on_reasons",
  "never_escalate_on",
  "force_escalate_after_same_reason",
] as const;
const LIMITS_KEYS = [
  "max_rounds_per_task",
  "max_cost_per_task_usd",
  "max_wall_per_round_s",
  "daily_budget_usd",
  "acceptance_overhead_warn_task_ratio",
  "acceptance_overhead_warn_weekly_ratio",
  "circuit_breaker",
] as const;
const CIRCUIT_BREAKER_KEYS = ["failures", "open_minutes"] as const;
const PRIVACY_KEYS = ["store_description_excerpt", "private_paths", "never_delegate_repos"] as const;
const EXPERIMENT_KEYS = ["mode", "arms", "assignment", "alpha", "power"] as const;
const QUALITY_WEIGHT_KEYS = ["first_pass", "final_pass", "feedback", "revert"] as const;
const HOST_KEYS = ["claude_code"] as const;
const CLAUDE_CODE_KEYS = ["confirm_before_dispatch", "route_subagent_tasks"] as const;
const PRICING_KEYS = ["schema_version", "models"] as const;
const MODEL_PRICE_KEYS = ["input_per_mtok", "cached_input_per_mtok", "output_per_mtok"] as const;

const POLICY_KEY_SET = new Set<string>(POLICY_KEYS);
const LABEL_SET = new Set<string>(LABELS);
const REJECT_REASON_SET = new Set<string>(REJECT_REASONS);

function pointer(base: string, key: string | number): string {
  const token = String(key).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${base}/${token}`;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function warnUnknown(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  base: string,
  warnings: ValidationIssue[],
): void {
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      warnings.push({ path: pointer(base, key), message: `unknown key "${key}"` });
    }
  }
}

function asObject(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    errors.push({ path, message: "must be an object" });
    return null;
  }
  return value;
}

interface StringOptions {
  nullable?: boolean;
  nonEmpty?: boolean;
}

function checkString(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
  opts: StringOptions = {},
): string | null {
  if (value === null && opts.nullable === true) return null;
  if (typeof value !== "string") {
    errors.push({ path, message: opts.nullable === true ? "must be a string or null" : "must be a string" });
    return null;
  }
  if (opts.nonEmpty !== false && value.length === 0) {
    errors.push({ path, message: "must not be empty" });
  }
  return value;
}

function checkBoolean(value: unknown, path: string, errors: ValidationIssue[]): boolean | null {
  if (typeof value !== "boolean") {
    errors.push({ path, message: "must be a boolean" });
    return null;
  }
  return value;
}

interface NumberOptions {
  nullable?: boolean;
  integer?: boolean;
  min?: number;
  max?: number;
  exclusiveMin?: boolean;
  exclusiveMax?: boolean;
}

function checkNumber(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
  opts: NumberOptions = {},
): number | null {
  if (value === null && opts.nullable === true) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, message: opts.nullable === true ? "must be a number or null" : "must be a finite number" });
    return null;
  }
  if (opts.integer === true && !Number.isInteger(value)) {
    errors.push({ path, message: "must be an integer" });
  }
  if (opts.min !== undefined) {
    const bad = opts.exclusiveMin === true ? value <= opts.min : value < opts.min;
    if (bad) {
      errors.push({
        path,
        message: `must be ${opts.exclusiveMin === true ? ">" : ">="} ${opts.min}`,
      });
    }
  }
  if (opts.max !== undefined) {
    const bad = opts.exclusiveMax === true ? value >= opts.max : value > opts.max;
    if (bad) {
      errors.push({
        path,
        message: `must be ${opts.exclusiveMax === true ? "<" : "<="} ${opts.max}`,
      });
    }
  }
  return value;
}

function checkEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: ValidationIssue[],
): T | null {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    errors.push({ path, message: `must be one of: ${allowed.join(", ")}` });
    return null;
  }
  return value as T;
}

function checkStringArray(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
  opts: { nonEmpty?: boolean; nonEmptyEntries?: boolean } = {},
): string[] | null {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array of strings" });
    return null;
  }
  if (opts.nonEmpty === true && value.length === 0) {
    errors.push({ path, message: "must not be empty" });
  }
  const out: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      errors.push({ path: pointer(path, index), message: "must be a string" });
      return;
    }
    if (opts.nonEmptyEntries === true && entry.length === 0) {
      errors.push({ path: pointer(path, index), message: "must not be empty" });
    }
    out.push(entry);
  });
  return out;
}

function checkLabelArray(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
): Label[] | null {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array of labels" });
    return null;
  }
  const out: Label[] = [];
  value.forEach((entry, index) => {
    const label = checkEnum(entry, LABELS, pointer(path, index), errors);
    if (label !== null) out.push(label);
  });
  return out;
}

function checkRejectReasonArray(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
): RejectReason[] | null {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array of reject reasons" });
    return null;
  }
  const out: RejectReason[] = [];
  value.forEach((entry, index) => {
    const reason = checkEnum(entry, REJECT_REASONS, pointer(path, index), errors);
    if (reason !== null) out.push(reason);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Deep merge: objects merge, arrays replace
// ---------------------------------------------------------------------------

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = cloneValue(entry);
    return out;
  }
  return value;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) out[key] = cloneValue(value);
    for (const [key, value] of Object.entries(override)) {
      out[key] = hasOwn(out, key) ? deepMerge(out[key], value) : cloneValue(value);
    }
    return out;
  }
  return cloneValue(override);
}

// ---------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------

function validateClassifier(obj: Record<string, unknown>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const base = "/classifier";
  warnUnknown(obj, CLASSIFIER_KEYS, base, warnings);
  checkString(obj["model"], pointer(base, "model"), errors, { nullable: true });
  checkString(obj["endpoint"], pointer(base, "endpoint"), errors);
  checkString(obj["api_key_env"], pointer(base, "api_key_env"), errors);
  checkNumber(obj["timeout_ms"], pointer(base, "timeout_ms"), errors, {
    integer: true,
    min: 0,
    exclusiveMin: true,
  });
  checkNumber(obj["temperature"], pointer(base, "temperature"), errors, { min: 0 });
  checkNumber(obj["max_tokens"], pointer(base, "max_tokens"), errors, {
    integer: true,
    min: 0,
    exclusiveMin: true,
  });
  const price = asObject(obj["price"], pointer(base, "price"), errors);
  if (price !== null) {
    warnUnknown(price, CLASSIFIER_PRICE_KEYS, pointer(base, "price"), warnings);
    checkNumber(price["input_per_mtok"], pointer(pointer(base, "price"), "input_per_mtok"), errors, { min: 0 });
    checkNumber(price["output_per_mtok"], pointer(pointer(base, "price"), "output_per_mtok"), errors, { min: 0 });
  }
}

/**
 * The heuristic object must list its bounded buckets in canonical order. A
 * partial object is allowed (defaults fill the rest), but present keys may not
 * be reordered.
 */
function checkHeuristicBucketOrder(
  rawLabeler: unknown,
  errors: ValidationIssue[],
): void {
  if (!isPlainObject(rawLabeler)) return;
  const heuristic = rawLabeler["time_bucket_heuristic"];
  if (!isPlainObject(heuristic)) return;

  const present = Object.keys(heuristic).filter((key) =>
    (TIME_BUCKET_HEURISTIC_KEYS as readonly string[]).includes(key),
  );
  const canonical = TIME_BUCKET_HEURISTIC_KEYS.filter((key) => present.includes(key));
  if (present.join(",") !== canonical.join(",")) {
    errors.push({
      path: "/labeler/time_bucket_heuristic",
      message: `buckets must appear in order: ${TIME_BUCKET_HEURISTIC_KEYS.join(", ")}`,
    });
  }
}

function validateTimeBucketHeuristic(
  value: unknown,
  base: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const heuristic = asObject(value, base, errors);
  if (heuristic === null) return;
  warnUnknown(heuristic, TIME_BUCKET_HEURISTIC_KEYS, base, warnings);

  const keys = Object.keys(heuristic).filter((key) =>
    (TIME_BUCKET_HEURISTIC_KEYS as readonly string[]).includes(key),
  );
  const canonical = TIME_BUCKET_HEURISTIC_KEYS.filter((key) => keys.includes(key));
  if (keys.join(",") !== canonical.join(",")) {
    errors.push({
      path: base,
      message: `buckets must appear in order: ${TIME_BUCKET_HEURISTIC_KEYS.join(", ")}`,
    });
  }

  for (const bucket of TIME_BUCKET_HEURISTIC_KEYS) {
    const bucketPath = pointer(base, bucket);
    const threshold = asObject(heuristic[bucket], bucketPath, errors);
    if (threshold === null) continue;
    warnUnknown(threshold, TIME_BUCKET_THRESHOLD_KEYS, bucketPath, warnings);
    checkNumber(threshold["max_files"], pointer(bucketPath, "max_files"), errors, {
      integer: true,
      min: 1,
    });
    checkNumber(threshold["max_chars"], pointer(bucketPath, "max_chars"), errors, {
      integer: true,
      min: 1,
    });
  }
}

function validateLabeler(obj: Record<string, unknown>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const base = "/labeler";
  warnUnknown(obj, LABELER_KEYS, base, warnings);
  checkString(obj["model"], pointer(base, "model"), errors, { nullable: true });
  checkString(obj["endpoint"], pointer(base, "endpoint"), errors, { nullable: true });
  checkString(obj["api_key_env"], pointer(base, "api_key_env"), errors, { nullable: true });
  validateTimeBucketHeuristic(
    obj["time_bucket_heuristic"],
    pointer(base, "time_bucket_heuristic"),
    errors,
    warnings,
  );
  checkString(obj["prompt_extra"], pointer(base, "prompt_extra"), errors, { nullable: true });
}

function validateTaxonomy(obj: Record<string, unknown>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const base = "/taxonomy";
  warnUnknown(obj, TAXONOMY_KEYS, base, warnings);
  checkLabelArray(obj["labels"], pointer(base, "labels"), errors);
}

function validateTargets(
  value: unknown,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): Set<string> | null {
  const targets = asObject(value, "/targets", errors);
  if (targets === null) return null;
  const names = Object.keys(targets);
  if (names.length === 0) {
    errors.push({ path: "/targets", message: "must define at least one target" });
    return new Set<string>();
  }
  for (const [name, rawTarget] of Object.entries(targets)) {
    const base = pointer("/targets", name);
    const target = asObject(rawTarget, base, errors);
    if (target === null) continue;
    warnUnknown(target, TARGET_KEYS, base, warnings);
    checkString(target["description"], pointer(base, "description"), errors);
    checkEnum(target["cost_tier"], COST_TIERS, pointer(base, "cost_tier"), errors);
    checkBoolean(target["enabled"], pointer(base, "enabled"), errors);
    if (hasOwn(target, "command")) {
      checkStringArray(target["command"], pointer(base, "command"), errors, {
        nonEmpty: true,
        nonEmptyEntries: true,
      });
    }
    if (hasOwn(target, "model")) {
      checkString(target["model"], pointer(base, "model"), errors, { nullable: true });
    }
    if (hasOwn(target, "api_key_env")) {
      checkString(target["api_key_env"], pointer(base, "api_key_env"), errors, { nullable: true });
    }
    if (hasOwn(target, "strengths")) {
      checkLabelArray(target["strengths"], pointer(base, "strengths"), errors);
    }
    if (hasOwn(target, "weaknesses")) {
      checkLabelArray(target["weaknesses"], pointer(base, "weaknesses"), errors);
    }
  }
  return new Set(names);
}

function validateRules(
  value: unknown,
  targets: Set<string> | null,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "/rules", message: "must be an array" });
    return;
  }
  value.forEach((rawRule, index) => {
    const base = pointer("/rules", index);
    const rule = asObject(rawRule, base, errors);
    if (rule === null) return;
    warnUnknown(rule, RULE_KEYS, base, warnings);
    checkString(rule["id"], pointer(base, "id"), errors);
    const condition = asObject(rule["if"], pointer(base, "if"), errors);
    if (condition !== null) {
      const conditionPath = pointer(base, "if");
      warnUnknown(condition, CONDITION_KEYS, conditionPath, warnings);
      const present = CONDITION_KEYS.filter((key) => hasOwn(condition, key));
      if (present.length === 0) {
        errors.push({
          path: conditionPath,
          message:
            "must contain at least one of constraint, label, files_mentioned_gte, " +
            "description_chars_gte, time_bucket, language, has_repro, cross_file",
        });
      }

      if (hasOwn(condition, "constraint")) {
        checkString(condition["constraint"], pointer(conditionPath, "constraint"), errors);
      }
      if (hasOwn(condition, "label")) {
        checkEnum(condition["label"], LABELS, pointer(conditionPath, "label"), errors);
      }
      if (hasOwn(condition, "files_mentioned_gte")) {
        checkNumber(
          condition["files_mentioned_gte"],
          pointer(conditionPath, "files_mentioned_gte"),
          errors,
          { integer: true, min: 0 },
        );
      }
      if (hasOwn(condition, "description_chars_gte")) {
        checkNumber(
          condition["description_chars_gte"],
          pointer(conditionPath, "description_chars_gte"),
          errors,
          { integer: true, min: 0 },
        );
      }
      if (hasOwn(condition, "time_bucket")) {
        checkEnum<TimeBucket>(
          condition["time_bucket"],
          TIME_BUCKETS,
          pointer(conditionPath, "time_bucket"),
          errors,
        );
      }
      if (hasOwn(condition, "language")) {
        checkEnum<Language>(
          condition["language"],
          LANGUAGES,
          pointer(conditionPath, "language"),
          errors,
        );
      }
      if (hasOwn(condition, "has_repro")) {
        checkBoolean(condition["has_repro"], pointer(conditionPath, "has_repro"), errors);
      }
      if (hasOwn(condition, "cross_file")) {
        checkBoolean(condition["cross_file"], pointer(conditionPath, "cross_file"), errors);
      }
    }
    const then = checkString(rule["then"], pointer(base, "then"), errors);
    if (then !== null && targets !== null && !targets.has(then)) {
      errors.push({ path: pointer(base, "then"), message: `target "${then}" is not a key of targets` });
    }
    if (hasOwn(rule, "locked")) {
      checkBoolean(rule["locked"], pointer(base, "locked"), errors);
    }
  });
}

function validateFallbackTable(
  value: unknown,
  targets: Set<string> | null,
  errors: ValidationIssue[],
): void {
  const table = asObject(value, "/fallback_table", errors);
  if (table === null) return;
  for (const [label, rawTarget] of Object.entries(table)) {
    const path = pointer("/fallback_table", label);
    if (!LABEL_SET.has(label)) {
      errors.push({ path, message: `unknown label "${label}"` });
    }
    const target = checkString(rawTarget, path, errors);
    if (target !== null && targets !== null && !targets.has(target)) {
      errors.push({ path, message: `target "${target}" is not a key of targets` });
    }
  }
}

function validatePreferences(obj: Record<string, unknown>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const base = "/preferences";
  warnUnknown(obj, PREFERENCES_KEYS, base, warnings);
  checkNumber(obj["cost_weight"], pointer(base, "cost_weight"), errors, { min: 0, max: 1 });
  checkNumber(obj["quality_weight"], pointer(base, "quality_weight"), errors, { min: 0, max: 1 });
  const biases = asObject(obj["per_label_bias"], pointer(base, "per_label_bias"), errors);
  if (biases === null) return;
  for (const [label, rawBias] of Object.entries(biases)) {
    const labelPath = pointer(pointer(base, "per_label_bias"), label);
    if (!LABEL_SET.has(label)) {
      errors.push({ path: labelPath, message: `unknown label "${label}"` });
    }
    const bias = asObject(rawBias, labelPath, errors);
    if (bias === null) continue;
    for (const [target, value] of Object.entries(bias)) {
      checkNumber(value, pointer(labelPath, target), errors, { min: -1, max: 1 });
    }
  }
}

function validateEscalation(
  obj: Record<string, unknown>,
  targets: Set<string> | null,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const base = "/escalation";
  warnUnknown(obj, ESCALATION_KEYS, base, warnings);
  const chain = checkStringArray(obj["chain"], pointer(base, "chain"), errors, { nonEmptyEntries: true });
  if (chain !== null && targets !== null) {
    chain.forEach((target, index) => {
      if (!targets.has(target)) {
        errors.push({
          path: pointer(pointer(base, "chain"), index),
          message: `target "${target}" is not a key of targets`,
        });
      }
    });
  }
  checkBoolean(obj["retry_same_target_once"], pointer(base, "retry_same_target_once"), errors);
  checkRejectReasonArray(obj["escalate_on_reasons"], pointer(base, "escalate_on_reasons"), errors);
  checkRejectReasonArray(obj["never_escalate_on"], pointer(base, "never_escalate_on"), errors);
  checkNumber(obj["force_escalate_after_same_reason"], pointer(base, "force_escalate_after_same_reason"), errors, {
    integer: true,
    min: 0,
    exclusiveMin: true,
  });
}

function validateLimits(obj: Record<string, unknown>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const base = "/limits";
  warnUnknown(obj, LIMITS_KEYS, base, warnings);
  checkNumber(obj["max_rounds_per_task"], pointer(base, "max_rounds_per_task"), errors, {
    integer: true,
    min: 0,
    exclusiveMin: true,
  });
  checkNumber(obj["max_cost_per_task_usd"], pointer(base, "max_cost_per_task_usd"), errors, {
    min: 0,
    exclusiveMin: true,
  });
  checkNumber(obj["max_wall_per_round_s"], pointer(base, "max_wall_per_round_s"), errors, {
    min: 0,
    exclusiveMin: true,
  });
  checkNumber(obj["daily_budget_usd"], pointer(base, "daily_budget_usd"), errors, {
    nullable: true,
    min: 0,
    exclusiveMin: true,
  });
  checkNumber(obj["acceptance_overhead_warn_task_ratio"], pointer(base, "acceptance_overhead_warn_task_ratio"), errors, {
    min: 0,
    exclusiveMin: true,
  });
  checkNumber(
    obj["acceptance_overhead_warn_weekly_ratio"],
    pointer(base, "acceptance_overhead_warn_weekly_ratio"),
    errors,
    { min: 0, exclusiveMin: true },
  );
  const circuit = asObject(obj["circuit_breaker"], pointer(base, "circuit_breaker"), errors);
  if (circuit !== null) {
    warnUnknown(circuit, CIRCUIT_BREAKER_KEYS, pointer(base, "circuit_breaker"), warnings);
    checkNumber(circuit["failures"], pointer(pointer(base, "circuit_breaker"), "failures"), errors, {
      integer: true,
      min: 0,
      exclusiveMin: true,
    });
    checkNumber(circuit["open_minutes"], pointer(pointer(base, "circuit_breaker"), "open_minutes"), errors, {
      min: 0,
      exclusiveMin: true,
    });
  }
}

function validatePrivacy(obj: Record<string, unknown>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const base = "/privacy";
  warnUnknown(obj, PRIVACY_KEYS, base, warnings);
  checkBoolean(obj["store_description_excerpt"], pointer(base, "store_description_excerpt"), errors);
  checkStringArray(obj["private_paths"], pointer(base, "private_paths"), errors);
  checkStringArray(obj["never_delegate_repos"], pointer(base, "never_delegate_repos"), errors);
}

function validateExperiment(obj: Record<string, unknown>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const base = "/experiment";
  warnUnknown(obj, EXPERIMENT_KEYS, base, warnings);
  checkEnum<ExperimentMode>(obj["mode"], EXPERIMENT_MODES, pointer(base, "mode"), errors);
  const arms = asObject(obj["arms"], pointer(base, "arms"), errors);
  if (arms !== null) {
    for (const [name, value] of Object.entries(arms)) {
      if (typeof value !== "string") {
        errors.push({ path: pointer(pointer(base, "arms"), name), message: "must be a file path string" });
      } else if (value.length === 0) {
        errors.push({ path: pointer(pointer(base, "arms"), name), message: "must not be empty" });
      }
    }
  }
  checkEnum(obj["assignment"], ASSIGNMENTS, pointer(base, "assignment"), errors);
  checkNumber(obj["alpha"], pointer(base, "alpha"), errors, { min: 0, max: 1, exclusiveMin: true, exclusiveMax: true });
  checkNumber(obj["power"], pointer(base, "power"), errors, { min: 0, max: 1, exclusiveMin: true, exclusiveMax: true });
}

function validateQualityWeights(
  obj: Record<string, unknown>,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const base = "/quality_weights";
  warnUnknown(obj, QUALITY_WEIGHT_KEYS, base, warnings);
  for (const key of QUALITY_WEIGHT_KEYS) {
    checkNumber(obj[key], pointer(base, key), errors, { min: 0, max: 1 });
  }
}

function validateHost(obj: Record<string, unknown>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const base = "/host";
  warnUnknown(obj, HOST_KEYS, base, warnings);
  const claudeCode = asObject(obj["claude_code"], pointer(base, "claude_code"), errors);
  if (claudeCode === null) return;
  warnUnknown(claudeCode, CLAUDE_CODE_KEYS, pointer(base, "claude_code"), warnings);
  checkBoolean(claudeCode["confirm_before_dispatch"], pointer(pointer(base, "claude_code"), "confirm_before_dispatch"), errors);
  checkBoolean(claudeCode["route_subagent_tasks"], pointer(pointer(base, "claude_code"), "route_subagent_tasks"), errors);
}

function validatePolicySections(merged: Record<string, unknown>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const schemaVersion = checkNumber(merged["schema_version"], "/schema_version", errors, { integer: true });
  if (schemaVersion !== null && schemaVersion !== 1) {
    errors.push({ path: "/schema_version", message: "must be 1" });
  }
  checkString(merged["policy_name"], "/policy_name", errors);

  const classifier = asObject(merged["classifier"], "/classifier", errors);
  if (classifier !== null) validateClassifier(classifier, errors, warnings);
  const labeler = asObject(merged["labeler"], "/labeler", errors);
  if (labeler !== null) validateLabeler(labeler, errors, warnings);
  const taxonomy = asObject(merged["taxonomy"], "/taxonomy", errors);
  if (taxonomy !== null) validateTaxonomy(taxonomy, errors, warnings);

  const targets = validateTargets(merged["targets"], errors, warnings);

  validateRules(merged["rules"], targets, errors, warnings);
  validateFallbackTable(merged["fallback_table"], targets, errors);

  const preferences = asObject(merged["preferences"], "/preferences", errors);
  if (preferences !== null) validatePreferences(preferences, errors, warnings);
  const escalation = asObject(merged["escalation"], "/escalation", errors);
  if (escalation !== null) validateEscalation(escalation, targets, errors, warnings);
  const limits = asObject(merged["limits"], "/limits", errors);
  if (limits !== null) validateLimits(limits, errors, warnings);
  const privacy = asObject(merged["privacy"], "/privacy", errors);
  if (privacy !== null) validatePrivacy(privacy, errors, warnings);
  const experiment = asObject(merged["experiment"], "/experiment", errors);
  if (experiment !== null) validateExperiment(experiment, errors, warnings);
  const qualityWeights = asObject(merged["quality_weights"], "/quality_weights", errors);
  if (qualityWeights !== null) validateQualityWeights(qualityWeights, errors, warnings);

  checkNumber(merged["style_rejection_suspect_ratio"], "/style_rejection_suspect_ratio", errors, {
    min: 0,
    max: 1,
  });
  const host = asObject(merged["host"], "/host", errors);
  if (host !== null) validateHost(host, errors, warnings);
}

function validatePolicyInternal(
  input: unknown,
  opts: { requireCore: boolean },
): PolicyValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!isPlainObject(input)) {
    errors.push({ path: "", message: "policy must be a YAML object" });
    return { ok: false, errors, warnings };
  }

  for (const key of Object.keys(input)) {
    if (!POLICY_KEY_SET.has(key)) {
      errors.push({ path: pointer("", key), message: `unknown top-level key "${key}"` });
    }
  }
  if (opts.requireCore) {
    for (const key of REQUIRED_POLICY_KEYS) {
      if (!hasOwn(input, key)) {
        errors.push({ path: pointer("", key), message: "required key is missing" });
      }
    }
  }

  checkHeuristicBucketOrder(input["labeler"], errors);

  const merged = deepMerge(defaultPolicy(), input);
  if (!isPlainObject(merged)) {
    errors.push({ path: "", message: "policy must be a YAML object" });
    return { ok: false, errors, warnings };
  }

  validatePolicySections(merged, errors, warnings);

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, policy: merged as unknown as Policy, errors, warnings };
}

/**
 * Validate a policy object. Missing optional sections are filled from the
 * bundled template before validation; unknown top-level keys are errors and
 * unknown nested keys are warnings.
 */
export function validatePolicy(input: unknown): PolicyValidationResult {
  return validatePolicyInternal(input, { requireCore: true });
}

/** Validate a policy file, reporting read and YAML errors as validation errors. */
export function validatePolicyFile(file: string): PolicyValidationResult {
  const doc = readYamlDocument(file);
  if (!doc.ok) {
    return { ok: false, errors: [doc.issue], warnings: [] };
  }
  return validatePolicy(doc.value);
}

/** Load and validate a policy file, throwing `ConfigError` on failure. */
export function loadPolicy(file: string): Policy {
  const doc = readYamlDocument(file);
  if (!doc.ok) {
    throw new ConfigError(doc.issue.message, {
      code: doc.code,
      exitCode: doc.code === "file_not_found" ? 1 : 2,
      errors: [doc.issue],
    });
  }
  const result = validatePolicy(doc.value);
  if (!result.ok) {
    throw new ConfigError(`invalid policy: ${result.errors.length} error(s)`, {
      code: "invalid_config",
      exitCode: 2,
      errors: result.errors,
      warnings: result.warnings,
    });
  }
  return result.policy;
}

function loadPolicyFragment(file: string): { policy: Policy; raw: Record<string, unknown> } {
  const doc = readYamlDocument(file);
  if (!doc.ok) {
    throw new ConfigError(doc.issue.message, {
      code: doc.code,
      exitCode: doc.code === "file_not_found" ? 1 : 2,
      errors: [doc.issue],
    });
  }
  if (!isPlainObject(doc.value)) {
    throw new ConfigError(`invalid policy arm: ${file} must be a YAML object`, {
      code: "invalid_config",
      exitCode: 2,
      errors: [{ path: "", message: "arm policy must be a YAML object" }],
    });
  }
  const result = validatePolicyInternal(doc.value, { requireCore: false });
  if (!result.ok) {
    throw new ConfigError(`invalid policy arm: ${result.errors.length} error(s)`, {
      code: "invalid_config",
      exitCode: 2,
      errors: result.errors,
      warnings: result.warnings,
    });
  }
  return { policy: result.policy, raw: doc.value };
}

/**
 * Load `$EVENER_HOME/policy.yaml` and, when an experiment arm is requested,
 * merge that arm's routing sections over the top-level experiment/limits/
 * privacy/host/quality_weights sections (spec §5).
 */
export function loadEffectivePolicy(home: string, opts: { arm?: string } = {}): EffectivePolicy {
  const topPath = join(home, "policy.yaml");
  const top = loadPolicy(topPath);
  const armName = opts.arm;

  if (armName === undefined || armName === null || armName.length === 0) {
    return { policy: top, policy_version: policyVersion(top), arm: null };
  }

  const relative = top.experiment.arms[armName];
  if (typeof relative !== "string" || relative.length === 0) {
    throw new ConfigError(`experiment arm "${armName}" is not defined in ${topPath}`, {
      code: "invalid_config",
      exitCode: 2,
      errors: [{ path: "/experiment/arms", message: `arm "${armName}" is not defined` }],
    });
  }

  const armPath = isAbsolute(relative) ? relative : resolve(home, relative);
  const fragment = loadPolicyFragment(armPath);
  const armPolicy = fragment.policy;

  // Only the routing sections named in the spec come from the arm; the rest of
  // the top-level policy (experiment/limits/privacy/host/quality_weights etc.)
  // remains in force. Sections absent from a sparse arm file fall back to the
  // top-level value.
  const merged: Policy = {
    ...top,
    ...(hasOwn(fragment.raw, "classifier") ? { classifier: armPolicy.classifier } : {}),
    ...(hasOwn(fragment.raw, "labeler") ? { labeler: armPolicy.labeler } : {}),
    ...(hasOwn(fragment.raw, "targets") ? { targets: armPolicy.targets } : {}),
    ...(hasOwn(fragment.raw, "rules") ? { rules: armPolicy.rules } : {}),
    ...(hasOwn(fragment.raw, "fallback_table") ? { fallback_table: armPolicy.fallback_table } : {}),
    ...(hasOwn(fragment.raw, "preferences") ? { preferences: armPolicy.preferences } : {}),
    ...(hasOwn(fragment.raw, "escalation") ? { escalation: armPolicy.escalation } : {}),
  };

  return { policy: merged, policy_version: policyVersion(merged), arm: armName };
}

// ---------------------------------------------------------------------------
// Pricing validation
// ---------------------------------------------------------------------------

function validatePricingInternal(input: unknown): PricingValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!isPlainObject(input)) {
    errors.push({ path: "", message: "pricing must be a YAML object" });
    return { ok: false, errors, warnings };
  }

  const allowed = new Set<string>(PRICING_KEYS);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      errors.push({ path: pointer("", key), message: `unknown top-level key "${key}"` });
    }
  }
  for (const key of PRICING_KEYS) {
    if (!hasOwn(input, key)) {
      errors.push({ path: pointer("", key), message: "required key is missing" });
    }
  }

  const merged = deepMerge(defaultPricing(), input);
  if (!isPlainObject(merged)) {
    errors.push({ path: "", message: "pricing must be a YAML object" });
    return { ok: false, errors, warnings };
  }

  const schemaVersion = checkNumber(merged["schema_version"], "/schema_version", errors, { integer: true });
  if (schemaVersion !== null && schemaVersion !== 1) {
    errors.push({ path: "/schema_version", message: "must be 1" });
  }
  const models = asObject(merged["models"], "/models", errors);
  if (models !== null) {
    for (const [name, rawPrice] of Object.entries(models)) {
      const base = pointer("/models", name);
      const price = asObject(rawPrice, base, errors);
      if (price === null) continue;
      warnUnknown(price, MODEL_PRICE_KEYS, base, warnings);
      for (const key of MODEL_PRICE_KEYS) {
        checkNumber(price[key], pointer(base, key), errors, { min: 0 });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, pricing: merged as unknown as Pricing, errors, warnings };
}

export function validatePricing(input: unknown): PricingValidationResult {
  return validatePricingInternal(input);
}

export function validatePricingFile(file: string): PricingValidationResult {
  const doc = readYamlDocument(file);
  if (!doc.ok) {
    return { ok: false, errors: [doc.issue], warnings: [] };
  }
  return validatePricing(doc.value);
}

export function loadPricing(file: string): Pricing {
  const doc = readYamlDocument(file);
  if (!doc.ok) {
    throw new ConfigError(doc.issue.message, {
      code: doc.code,
      exitCode: doc.code === "file_not_found" ? 1 : 2,
      errors: [doc.issue],
    });
  }
  const result = validatePricing(doc.value);
  if (!result.ok) {
    throw new ConfigError(`invalid pricing: ${result.errors.length} error(s)`, {
      code: "invalid_config",
      exitCode: 2,
      errors: result.errors,
      warnings: result.warnings,
    });
  }
  return result.pricing;
}
