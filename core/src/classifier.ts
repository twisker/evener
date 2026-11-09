/**
 * Classifier transport and prompts.
 *
 * The routing classifier speaks the OpenAI-compatible `POST /chat/completions`
 * protocol with JSON-only answers (spec §2, §6.1). Everything here is pure
 * except for {@link callChatCompletions}, which accepts an injected `fetch` so
 * tests can avoid the network. The fixed-taxonomy labeler shares the same
 * transport but never sees the policy.
 */

import { LABELS, TIME_BUCKET_HEURISTIC_KEYS } from "./types.js";
import type {
  ArmPolicy,
  ClassifierConfig,
  ClassifierPrice,
  Label,
  LabelerConfig,
  PreFeatures,
  Pricing,
  PricingPeriod,
  Taxonomy,
  TimeBucket,
} from "./types.js";
import { peakSchedule, pricingPeriod } from "./pricing.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Task features sent to the routing classifier; never contains the hash. */
export interface TaskFeatures {
  label: Label;
  pre_features: PreFeatures;
  constraints: string[];
  excerpt: string | null;
}

export interface RenderedPrompt {
  system: string;
  user: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatCompletionsOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  /** Merged into the body before the fixed transport fields. */
  requestExtra?: Record<string, unknown> | null;
  fetchImpl?: typeof fetch;
}

export interface ChatCompletionsResult {
  content: string;
  usage: ChatUsage | null;
  latency_ms: number;
}

export type ClassifierErrorCode = "timeout" | "http" | "parse" | "no_key";

/** Transport failure with a machine-readable code. */
export class ClassifierError extends Error {
  readonly code: ClassifierErrorCode;

  constructor(code: ClassifierErrorCode, message: string) {
    super(message);
    this.name = "ClassifierError";
    this.code = code;
  }
}

export type ClassifierFailureCode =
  | ClassifierErrorCode
  | "invalid_target"
  | "no_model";

/**
 * Cost multiplier for an inline classifier/labeler price at `at`.
 *
 * The policy carries only the schedule name; it is resolved against the
 * pricing file's `peak_schedules`. With no pricing file in reach the tier is
 * `flat` and the list price is charged unchanged.
 */
function inlinePriceFactor(
  price: ClassifierPrice,
  pricing: Pricing | undefined,
  at: Date,
): { factor: number; period: PricingPeriod } {
  const schedule = peakSchedule(pricing, price.peak);
  const period = pricingPeriod(schedule, at);
  return {
    factor: period === "peak" && schedule !== null ? schedule.factor : 1,
    period,
  };
}

export type ClassifierResult =
  | {
      ok: true;
      target: string;
      scores: Record<string, number>;
      rationale: string;
      model: string;
      latency_ms: number;
      cost_usd: number;
    }
  | {
      ok: false;
      code: ClassifierFailureCode;
      message: string;
      latency_ms: number;
    };

const SYSTEM_PROMPT = "You are a routing classifier. Answer with one JSON object and nothing else.";
const LABELER_SYSTEM_PROMPT = "You are a task labeler. Answer with one JSON object and nothing else.";

const FALLBACK_CLASSIFIER_ENDPOINT = "https://api.deepseek.com/v1";
const FALLBACK_CLASSIFIER_KEY_ENV = "EVENER_CLASSIFIER_API_KEY";

// ---------------------------------------------------------------------------
// Prompt rendering (spec §6.1)
// ---------------------------------------------------------------------------

function renderTargets(arm: ArmPolicy): string {
  const lines: string[] = ["targets:"];
  for (const [name, target] of Object.entries(arm.targets)) {
    const rendered = {
      description: target.description,
      cost_tier: target.cost_tier,
      strengths: target.strengths ?? [],
      weaknesses: target.weaknesses ?? [],
      enabled: target.enabled,
    };
    lines.push(`  ${name}: ${JSON.stringify(rendered)}`);
  }
  return lines.join("\n");
}

/**
 * Render the routing prompt exactly per spec §6.1: policy targets,
 * preferences and taxonomy, then the task features. The description hash is
 * never part of {@link TaskFeatures} and the excerpt is omitted when null.
 */
export function renderClassifierPrompt(arm: ArmPolicy, task: TaskFeatures): RenderedPrompt {
  const taxonomy = LABELS.filter((label) => label !== "unknown");

  const lines: string[] = [
    "ROUTING POLICY",
    renderTargets(arm),
    `preferences: ${JSON.stringify(arm.preferences)}`,
    `taxonomy: ${JSON.stringify(taxonomy)}; "unknown" is always allowed as a last resort.`,
    "",
    "TASK",
    `label: ${task.label}`,
    `description_chars: ${task.pre_features.description_chars}`,
    `files_mentioned: ${task.pre_features.files_mentioned}`,
    `language: ${task.pre_features.language ?? "null"}`,
    `has_repro: ${task.pre_features.has_repro}`,
    `cross_file: ${task.pre_features.cross_file}`,
    `time_bucket: ${task.pre_features.time_bucket}`,
    `constraints: ${JSON.stringify(task.constraints)}`,
  ];
  if (task.excerpt !== null) {
    lines.push(`excerpt: ${JSON.stringify(task.excerpt)}`);
  }

  lines.push(
    "",
    "Choose exactly one enabled target. Answer with exactly one JSON object:",
    '{"target":"<enabled target key>","scores":{"<enabled target key>":0.0},"rationale":"<short reason>"}',
  );

  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return the first balanced `{...}` object in `content`, or null. This accepts
 * models that wrap JSON in Markdown fences or add prose before/after it.
 */
export function extractFirstJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (char === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }

  return null;
}

function parseJsonObject(content: string): Record<string, unknown> {
  // Prose occasionally contains brace pairs that are not JSON (e.g.
  // "choose {host}"), so try successive balanced objects until one parses.
  let searchFrom = 0;
  let sawObject = false;

  while (searchFrom < content.length) {
    const slice = content.slice(searchFrom);
    const block = extractFirstJsonObject(slice);
    if (block === null) break;
    sawObject = true;
    try {
      const parsed: unknown = JSON.parse(block);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next balanced object.
    }
    const offset = slice.indexOf("{");
    if (offset < 0) break;
    searchFrom += offset + 1;
  }

  throw new ClassifierError(
    "parse",
    sawObject
      ? "classifier answer contains no valid JSON object"
      : "classifier answer contains no JSON object",
  );
}

function parseUsage(value: unknown): ChatUsage | null {
  if (!isRecord(value)) return null;
  const prompt = value["prompt_tokens"];
  const completion = value["completion_tokens"];
  if (
    typeof prompt !== "number" ||
    !Number.isFinite(prompt) ||
    typeof completion !== "number" ||
    !Number.isFinite(completion)
  ) {
    return null;
  }
  return { prompt_tokens: prompt, completion_tokens: completion };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Transport (spec §6)
// ---------------------------------------------------------------------------

/**
 * Call an OpenAI-compatible chat completion endpoint.
 *
 * Throws {@link ClassifierError} with `no_key`, `timeout`, `http` or `parse`.
 */
export async function callChatCompletions(
  opts: ChatCompletionsOptions,
): Promise<ChatCompletionsResult> {
  const apiKey = opts.apiKey.trim();
  if (apiKey.length === 0) {
    throw new ClassifierError("no_key", "classifier API key is missing");
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);

  const url = `${opts.endpoint.replace(/\/+$/, "")}/chat/completions`;
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          ...(opts.requestExtra ?? {}),
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut || (err instanceof Error && err.name === "AbortError")) {
        throw new ClassifierError("timeout", `classifier timed out after ${opts.timeoutMs} ms`);
      }
      throw new ClassifierError("http", `classifier request failed: ${errorMessage(err)}`);
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 500);
      } catch {
        // The status code is enough.
      }
      throw new ClassifierError(
        "http",
        `classifier returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new ClassifierError("parse", `classifier response is not JSON: ${errorMessage(err)}`);
    }

    if (!isRecord(body)) {
      throw new ClassifierError("parse", "classifier response is not a JSON object");
    }
    const choices = body["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ClassifierError("parse", "classifier response has no choices");
    }
    const first = choices[0];
    if (!isRecord(first)) {
      throw new ClassifierError("parse", "classifier choice is not an object");
    }
    const message = first["message"];
    if (!isRecord(message) || typeof message["content"] !== "string") {
      throw new ClassifierError("parse", "classifier response has no message content");
    }

    return {
      content: message["content"],
      usage: parseUsage(body["usage"]),
      latency_ms: Math.max(0, Math.round(Date.now() - started)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Routing classification
// ---------------------------------------------------------------------------

function isEnabledTarget(arm: ArmPolicy, target: string): boolean {
  const policy = arm.targets[target];
  return policy !== undefined && policy.enabled === true;
}

function parseClassifierPayload(
  content: string,
): { target: string; scores: Record<string, number>; rationale: string } {
  const parsed = parseJsonObject(content);

  const target = parsed["target"];
  if (typeof target !== "string" || target.length === 0) {
    throw new ClassifierError("parse", "classifier answer has no target");
  }

  const rawScores = parsed["scores"];
  if (!isRecord(rawScores)) {
    throw new ClassifierError("parse", "classifier answer has no scores object");
  }
  const scores: Record<string, number> = {};
  for (const [name, value] of Object.entries(rawScores)) {
    if (typeof value === "number" && Number.isFinite(value)) scores[name] = value;
  }
  if (Object.keys(scores).length === 0) {
    throw new ClassifierError("parse", "classifier answer has no numeric scores");
  }

  const rationaleValue = parsed["rationale"];
  const rationale = typeof rationaleValue === "string" ? rationaleValue : "";

  return { target, scores, rationale };
}

/**
 * Classify a task into a target. Returns `ok: false` for transport failures and
 * for targets that are not an enabled key of `arm.targets`.
 */
export async function classifyTarget(
  arm: ArmPolicy,
  task: TaskFeatures,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
  pricing?: Pricing,
  at: Date = new Date(),
): Promise<ClassifierResult> {
  const started = Date.now();
  const model = arm.classifier.model;
  if (model === null) {
    return {
      ok: false,
      code: "no_model",
      message: "classifier.model is not configured",
      latency_ms: Math.max(0, Math.round(Date.now() - started)),
    };
  }

  const apiKey = env[arm.classifier.api_key_env] ?? "";
  const prompt = renderClassifierPrompt(arm, task);

  try {
    const response = await callChatCompletions({
      endpoint: arm.classifier.endpoint,
      apiKey,
      model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      timeoutMs: arm.classifier.timeout_ms,
      temperature: arm.classifier.temperature,
      maxTokens: arm.classifier.max_tokens,
      requestExtra: arm.classifier.request_extra,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });

    const parsed = parseClassifierPayload(response.content);
    if (!isEnabledTarget(arm, parsed.target)) {
      return {
        ok: false,
        code: "invalid_target",
        message: `classifier chose target "${parsed.target}", which is not enabled`,
        latency_ms: Math.max(0, Math.round(Date.now() - started)),
      };
    }

    const usage = response.usage;
    const price = arm.classifier.price;
    const { factor } = inlinePriceFactor(price, pricing, at);
    const costUsd =
      usage === null
        ? 0
        : ((usage.prompt_tokens / 1_000_000) * price.input_per_mtok +
            (usage.completion_tokens / 1_000_000) * price.output_per_mtok) *
          factor;

    return {
      ok: true,
      target: parsed.target,
      scores: parsed.scores,
      rationale: parsed.rationale,
      model,
      latency_ms: Math.max(0, Math.round(Date.now() - started)),
      cost_usd: costUsd,
    };
  } catch (err) {
    const latency = Math.max(0, Math.round(Date.now() - started));
    if (err instanceof ClassifierError) {
      return { ok: false, code: err.code, message: err.message, latency_ms: latency };
    }
    return { ok: false, code: "parse", message: errorMessage(err), latency_ms: latency };
  }
}

// ---------------------------------------------------------------------------
// Fixed-taxonomy labeler (model path)
// ---------------------------------------------------------------------------

function resolveLabelerTransport(
  labeler: LabelerConfig,
  classifier: ClassifierConfig | undefined,
): {
  endpoint: string;
  apiKeyEnv: string;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  price: ClassifierPrice | null;
  requestExtra: Record<string, unknown> | null;
} {
  return {
    endpoint:
      labeler.endpoint ??
      classifier?.endpoint ??
      FALLBACK_CLASSIFIER_ENDPOINT,
    apiKeyEnv:
      labeler.api_key_env ??
      classifier?.api_key_env ??
      FALLBACK_CLASSIFIER_KEY_ENV,
    timeoutMs: labeler.timeout_ms ?? classifier?.timeout_ms ?? 3000,
    temperature: classifier?.temperature ?? 0,
    maxTokens: classifier?.max_tokens ?? 300,
    price: labeler.price ?? classifier?.price ?? null,
    requestExtra: labeler.request_extra ?? classifier?.request_extra ?? null,
  };
}

/** The fixed taxonomy labeler's model answer. */
export interface LabelModelResult {
  label: Label;
  time_bucket: TimeBucket | null;
  has_repro: boolean | null;
  cost_usd: number | null;
  latency_ms: number | null;
  /** `"<ClassifierError code>: <message>"`, or null on success. */
  error: string | null;
}

const LABELER_TIME_BUCKETS = [...TIME_BUCKET_HEURISTIC_KEYS, "gt4h"] as const;

function parseTimeBucket(value: unknown): TimeBucket | null {
  if (
    typeof value === "string" &&
    (LABELER_TIME_BUCKETS as readonly string[]).includes(value)
  ) {
    return value as TimeBucket;
  }
  return null;
}

function labelerCost(
  usage: ChatUsage | null,
  price: ClassifierPrice | null,
  pricing: Pricing | undefined,
  at: Date,
): number | null {
  if (usage === null || price === null) return null;
  const { factor } = inlinePriceFactor(price, pricing, at);
  return (
    ((usage.prompt_tokens / 1_000_000) * price.input_per_mtok +
      (usage.completion_tokens / 1_000_000) * price.output_per_mtok) *
    factor
  );
}

/**
 * Label a task with the fixed taxonomy. The prompt never mentions the routing
 * policy. Transport or parse failures are returned with an `error` string and
 * an `unknown` label so the caller can fall back to the heuristic with a
 * warning.
 *
 * `classifier` supplies the endpoint/key/timeout/price/request_extra fallback
 * when the labeler config leaves them null (spec §5). Temperature and
 * max_tokens always come from the classifier.
 */
export async function labelWithModel(
  policyLabeler: LabelerConfig,
  taxonomy: Taxonomy,
  description: string,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
  classifier?: ClassifierConfig,
  pricing?: Pricing,
  at: Date = new Date(),
): Promise<LabelModelResult> {
  const model = policyLabeler.model;
  if (model === null) {
    return {
      label: "unknown",
      time_bucket: null,
      has_repro: null,
      cost_usd: null,
      latency_ms: null,
      error: null,
    };
  }

  const taxonomyLabels = taxonomy.labels.length > 0 ? taxonomy.labels : [...LABELS];
  const labels = taxonomyLabels.filter((label) => label !== "unknown");
  const allowed = new Set<string>(taxonomyLabels);
  // The spec keeps "unknown" available as a last resort regardless of taxonomy.
  allowed.add("unknown");

  const transport = resolveLabelerTransport(policyLabeler, classifier);
  const bucketDescription =
    "lt15m (<15 min), 15m_1h (15 min-1 h), 1h_4h (1-4 h), gt4h (>4 h)";
  const promptExtra =
    policyLabeler.prompt_extra === null ? "" : `\n\n${policyLabeler.prompt_extra}`;
  const answer = `Classify this coding task into exactly one label from: ${labels.join(", ")}. ` +
    `Also estimate the human time needed to complete it as exactly one time bucket: ${bucketDescription}. ` +
    'Set "has_repro" to true only if the task text itself supplies a failing test, reproduction steps, or an error/stack trace; otherwise set it to false. ' +
    'Answer {"label": "<label>", "time_bucket": "<bucket>", "has_repro": <true|false>}.\n\nTask:\n' +
    description +
    promptExtra;

  const started = Date.now();
  let response: ChatCompletionsResult | null = null;
  let costUsd: number | null = null;

  try {
    response = await callChatCompletions({
      endpoint: transport.endpoint,
      apiKey: env[transport.apiKeyEnv] ?? "",
      model,
      messages: [
        { role: "system", content: LABELER_SYSTEM_PROMPT },
        { role: "user", content: answer },
      ],
      timeoutMs: transport.timeoutMs,
      temperature: transport.temperature,
      maxTokens: transport.maxTokens,
      requestExtra: transport.requestExtra,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });

    costUsd = labelerCost(response.usage, transport.price, pricing, at);

    const parsed = parseJsonObject(response.content);
    const labelValue = parsed["label"];
    if (typeof labelValue !== "string" || !allowed.has(labelValue)) {
      throw new ClassifierError(
        "parse",
        `labeler answer label ${JSON.stringify(labelValue)} is not in the taxonomy`,
      );
    }

    const hasReproValue = parsed["has_repro"];
    return {
      label: labelValue as Label,
      time_bucket: parseTimeBucket(parsed["time_bucket"]),
      has_repro: typeof hasReproValue === "boolean" ? hasReproValue : null,
      cost_usd: costUsd,
      latency_ms: response.latency_ms,
      error: null,
    };
  } catch (err) {
    const latency =
      response?.latency_ms ?? Math.max(0, Math.round(Date.now() - started));
    const code = err instanceof ClassifierError ? err.code : "parse";
    return {
      label: "unknown",
      time_bucket: null,
      has_repro: null,
      cost_usd: costUsd,
      latency_ms: latency,
      error: `${code}: ${errorMessage(err)}`,
    };
  }
}
