import assert from "node:assert/strict";
import test from "node:test";
import {
  callChatCompletions,
  ClassifierError,
  classifyTarget,
  labelWithModel,
  renderClassifierPrompt,
} from "../src/classifier.js";
import type { TaskFeatures } from "../src/classifier.js";
import { defaultPolicy, defaultPricing } from "../src/config.js";
import { labelTask } from "../src/labeler.js";
import type { Policy } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arm(): Policy {
  const policy = defaultPolicy();
  policy.classifier.model = "classifier-1";
  policy.classifier.api_key_env = "CLASSIFIER_KEY";
  return policy;
}

function features(overrides: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    label: "bugfix",
    pre_features: {
      description_chars: 42,
      files_mentioned: 2,
      repo_files: 10,
      language: "ts",
      has_repro: false,
      cross_file: true,
      time_bucket: "15m_1h",
    },
    constraints: [],
    excerpt: null,
    ...overrides,
  };
}

function chatResponse(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number } | null = {
    prompt_tokens: 10,
    completion_tokens: 5,
  },
): Response {
  const body: Record<string, unknown> = { choices: [{ message: { content } }] };
  if (usage !== null) body["usage"] = usage;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  return async (input, init) => handler(String(input), init);
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function abortingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        reject(new Error("missing abort signal"));
        return;
      }
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", () => reject(abortError()));
    });
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

test("renderClassifierPrompt renders policy and features without hash or excerpt", () => {
  const prompt = renderClassifierPrompt(arm(), features({ constraints: ["private_path"] }));

  assert.equal(
    prompt.system,
    "You are a routing classifier. Answer with one JSON object and nothing else.",
  );
  assert.match(prompt.user, /ROUTING POLICY/);
  assert.match(prompt.user, /host:/);
  assert.match(prompt.user, /codex:/);
  assert.match(prompt.user, /description/);
  assert.match(prompt.user, /cost_tier/);
  assert.match(prompt.user, /enabled/);
  assert.match(prompt.user, /preferences/);
  assert.match(prompt.user, /taxonomy/);
  assert.match(prompt.user, /label: bugfix/);
  assert.match(prompt.user, /description_chars: 42/);
  assert.match(prompt.user, /files_mentioned: 2/);
  assert.match(prompt.user, /private_path/);
  assert.match(prompt.user, /"target"/);
  assert.match(prompt.user, /"scores"/);
  assert.match(prompt.user, /"rationale"/);
  assert.equal(prompt.user.includes("description_hash"), false);
  assert.equal(prompt.user.includes("excerpt"), false);
});

test("renderClassifierPrompt sends the excerpt only when it is provided", () => {
  const prompt = renderClassifierPrompt(
    arm(),
    features({ excerpt: "Fix the crash in src/a.ts" }),
  );
  assert.match(prompt.user, /excerpt/);
  assert.match(prompt.user, /Fix the crash in src\/a\.ts/);
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

test("callChatCompletions posts to /chat/completions with JSON response format", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  let seenAuthorization = "";

  const fetchImpl = stubFetch((url, init) => {
    seenUrl = url;
    seenAuthorization = String(
      (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? "",
    );
    const raw = typeof init?.body === "string" ? init.body : "";
    seenBody = JSON.parse(raw) as Record<string, unknown>;
    return chatResponse('{"target":"codex"}', { prompt_tokens: 100, completion_tokens: 20 });
  });

  const result = await callChatCompletions({
    endpoint: "https://classifier.test/v1/",
    apiKey: "test-key",
    model: "classifier-1",
    messages: [{ role: "user", content: "hello" }],
    timeoutMs: 1000,
    temperature: 0,
    maxTokens: 50,
    requestExtra: { thinking: { type: "disabled" }, model: "ignored", temperature: 9 },
    fetchImpl,
  });

  assert.equal(seenUrl, "https://classifier.test/v1/chat/completions");
  assert.equal(seenAuthorization, "Bearer test-key");
  assert.equal(seenBody["model"], "classifier-1");
  assert.equal(seenBody["max_tokens"], 50);
  assert.equal(seenBody["temperature"], 0);
  assert.deepEqual(seenBody["thinking"], { type: "disabled" });
  assert.deepEqual(seenBody["response_format"], { type: "json_object" });
  assert.equal(result.content, '{"target":"codex"}');
  assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 20 });
  assert.ok(result.latency_ms >= 0);
});

test("callChatCompletions reports no_key, http, parse and timeout", async () => {
  const base = {
    endpoint: "https://classifier.test/v1",
    apiKey: "key",
    model: "classifier-1",
    messages: [{ role: "user" as const, content: "hello" }],
    timeoutMs: 1000,
    temperature: 0,
    maxTokens: 50,
  };

  await assert.rejects(
    () => callChatCompletions({ ...base, apiKey: "  " }),
    (err: unknown) => err instanceof ClassifierError && err.code === "no_key",
  );

  await assert.rejects(
    () =>
      callChatCompletions({
        ...base,
        fetchImpl: stubFetch(() => new Response("boom", { status: 503 })),
      }),
    (err: unknown) => err instanceof ClassifierError && err.code === "http",
  );

  await assert.rejects(
    () =>
      callChatCompletions({
        ...base,
        fetchImpl: stubFetch(() => new Response("not-json", { status: 200 })),
      }),
    (err: unknown) => err instanceof ClassifierError && err.code === "parse",
  );

  await assert.rejects(
    () => callChatCompletions({ ...base, timeoutMs: 10, fetchImpl: abortingFetch() }),
    (err: unknown) => err instanceof ClassifierError && err.code === "timeout",
  );
});

// ---------------------------------------------------------------------------
// classifyTarget
// ---------------------------------------------------------------------------

test("classifyTarget parses a fenced JSON answer and computes cost", async () => {
  const policy = arm();
  const fetchImpl = stubFetch(() =>
    chatResponse(
      'Sure, here it is:\n```json\n{"target":"dsh","scores":{"dsh":0.9,"codex":0.2},"rationale":"cheap"}\n```',
      { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
    ),
  );

  const result = await classifyTarget(policy, features(), { CLASSIFIER_KEY: "secret" }, fetchImpl);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.target, "dsh");
  assert.deepEqual(result.scores, { dsh: 0.9, codex: 0.2 });
  assert.equal(result.rationale, "cheap");
  assert.equal(result.model, "classifier-1");
  assert.ok(Math.abs(result.cost_usd - 0.45) < 1e-9);
});

test("classifyTarget applies the inline price's peak schedule at the given instant", async () => {
  const policy = arm();
  policy.classifier.price = { input_per_mtok: 1, output_per_mtok: 2, peak: "classifier-peak" };
  const pricing = defaultPricing();
  pricing.peak_schedules = {
    "classifier-peak": {
      tz: "Asia/Shanghai",
      windows: ["09:00-12:00"],
      weekdays_only: true,
      factor: 2,
    },
  };
  const fetchImpl = stubFetch(() =>
    chatResponse('{"target":"dsh","scores":{"dsh":1},"rationale":"x"}', {
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
    }),
  );

  const peak = await classifyTarget(
    policy,
    features(),
    { CLASSIFIER_KEY: "secret" },
    fetchImpl,
    pricing,
    new Date("2026-11-10T02:30:00.000Z"),
  );
  const off = await classifyTarget(
    policy,
    features(),
    { CLASSIFIER_KEY: "secret" },
    fetchImpl,
    pricing,
    new Date("2026-11-10T05:00:00.000Z"),
  );

  assert.equal(peak.ok, true);
  assert.equal(off.ok, true);
  if (!peak.ok || !off.ok) return;
  assert.ok(Math.abs(peak.cost_usd - 4) < 1e-9);
  assert.ok(Math.abs(off.cost_usd - 2) < 1e-9);
});

test("classifyTarget rejects a disabled target with invalid_target", async () => {
  const policy = arm();
  const dsh = policy.targets["dsh"];
  assert.ok(dsh !== undefined);
  dsh.enabled = false;

  const result = await classifyTarget(
    policy,
    features(),
    { CLASSIFIER_KEY: "secret" },
    stubFetch(() =>
      chatResponse('{"target":"dsh","scores":{"dsh":1},"rationale":"x"}'),
    ),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid_target");
});

test("classifyTarget reports timeout as a failed result", async () => {
  const policy = arm();
  policy.classifier.timeout_ms = 10;

  const result = await classifyTarget(
    policy,
    features(),
    { CLASSIFIER_KEY: "secret" },
    abortingFetch(),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "timeout");
  assert.ok(result.latency_ms >= 0);
});

test("classifyTarget leaves cost at zero when usage is absent", async () => {
  const result = await classifyTarget(
    arm(),
    features(),
    { CLASSIFIER_KEY: "secret" },
    stubFetch(() =>
      chatResponse('{"target":"codex","scores":{"codex":1},"rationale":"x"}', null),
    ),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.cost_usd, 0);
  assert.equal(result.model, "classifier-1");
});

// ---------------------------------------------------------------------------
// Labeler
// ---------------------------------------------------------------------------

test("labelWithModel uses the fixed prompt and falls back to the classifier endpoint/key", async () => {
  const policy = arm();
  policy.classifier.endpoint = "https://classifier.test/v1";
  policy.labeler = {
    ...policy.labeler,
    model: "labeler-1",
    endpoint: null,
    api_key_env: null,
    timeout_ms: null,
    price: null,
    request_extra: null,
  };

  let seenUrl = "";
  let seenUser = "";
  const fetchImpl = stubFetch((url, init) => {
    seenUrl = url;
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
    seenUser = body.messages?.find((message) => message.role === "user")?.content ?? "";
    return chatResponse('{"label":"docs","time_bucket":"15m_1h","has_repro":false}');
  });

  const result = await labelWithModel(
    policy.labeler,
    policy.taxonomy,
    "Update the README",
    { CLASSIFIER_KEY: "secret" },
    fetchImpl,
    policy.classifier,
  );

  assert.equal(result.label, "docs");
  assert.equal(result.time_bucket, "15m_1h");
  assert.equal(result.has_repro, false);
  assert.equal(result.error, null);
  assert.ok(Math.abs((result.cost_usd ?? -1) - 0.0000045) < 1e-12);
  assert.ok((result.latency_ms ?? -1) >= 0);
  assert.equal(seenUrl, "https://classifier.test/v1/chat/completions");
  assert.match(seenUser, /Classify this coding task into exactly one label from: bugfix/);
  assert.match(seenUser, /"has_repro"/);
  assert.match(seenUser, /Answer \{"label": "<label>", "time_bucket": "<bucket>", "has_repro": <true\|false>\}/);
  assert.match(seenUser, /25 min|15 min/);
  assert.match(seenUser, /Update the README/);
});

test("labelWithModel applies the inline price's peak schedule", async () => {
  const policy = arm();
  policy.labeler = {
    ...policy.labeler,
    model: "labeler-1",
    price: { input_per_mtok: 1, output_per_mtok: 2, peak: "labeler-peak" },
  };
  const pricing = defaultPricing();
  pricing.peak_schedules = {
    "labeler-peak": {
      tz: "Asia/Shanghai",
      windows: ["09:00-12:00"],
      weekdays_only: true,
      factor: 3,
    },
  };
  const fetchImpl = stubFetch(() =>
    chatResponse('{"label":"docs","time_bucket":"lt15m","has_repro":false}', {
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
    }),
  );

  const peak = await labelWithModel(
    policy.labeler,
    policy.taxonomy,
    "Update the README",
    { DEEPSEEK_API_KEY: "secret" },
    fetchImpl,
    policy.classifier,
    pricing,
    new Date("2026-11-10T02:30:00.000Z"),
  );
  const off = await labelWithModel(
    policy.labeler,
    policy.taxonomy,
    "Update the README",
    { DEEPSEEK_API_KEY: "secret" },
    fetchImpl,
    policy.classifier,
    pricing,
    new Date("2026-11-10T05:00:00.000Z"),
  );

  assert.ok(Math.abs((peak.cost_usd ?? 0) - 6) < 1e-9);
  assert.ok(Math.abs((off.cost_usd ?? 0) - 2) < 1e-9);
});

test("labelWithModel reports an http error instead of swallowing it", async () => {
  const policy = arm();
  policy.labeler = { ...policy.labeler, model: "labeler-1" };

  const result = await labelWithModel(
    policy.labeler,
    policy.taxonomy,
    "Update the README",
    { DEEPSEEK_API_KEY: "secret" },
    stubFetch(() => new Response("down", { status: 500 })),
    policy.classifier,
  );

  assert.equal(result.label, "unknown");
  assert.equal(result.time_bucket, null);
  assert.equal(result.has_repro, null);
  assert.equal(result.cost_usd, null);
  assert.match(result.error ?? "", /^http: /);
});

test("labelWithModel rejects a label outside the taxonomy as a parse error", async () => {
  const policy = arm();
  policy.labeler = { ...policy.labeler, model: "labeler-1" };

  const result = await labelWithModel(
    policy.labeler,
    policy.taxonomy,
    "Update the README",
    { DEEPSEEK_API_KEY: "secret" },
    stubFetch(() => chatResponse('{"label":"not-a-label","time_bucket":"lt15m"}')),
    policy.classifier,
  );

  assert.equal(result.label, "unknown");
  assert.match(result.error ?? "", /^parse: /);
});

test("labelTask uses the model label when configured and the heuristic otherwise", async () => {
  const policy = arm();
  policy.labeler = { ...policy.labeler, model: "labeler-1" };

  const preFeatures = { description_chars: 20, files_mentioned: 1 };
  const labelled = await labelTask(
    "Fix the crash on startup",
    policy,
    {
      env: { DEEPSEEK_API_KEY: "secret" },
      fetchImpl: stubFetch(() =>
        chatResponse('{"label":"refactor","time_bucket":"1h_4h","has_repro":true}'),
      ),
    },
    preFeatures,
  );
  assert.equal(labelled.label, "refactor");
  assert.equal(labelled.labeler_model, "labeler-1");
  assert.equal(labelled.time_bucket, "1h_4h");
  assert.equal(labelled.has_repro, true);
  assert.equal(labelled.warning, null);
  assert.ok((labelled.labeler_cost_usd ?? -1) > 0);
  assert.ok((labelled.labeler_latency_ms ?? -1) >= 0);

  const heuristicPolicy = arm();
  heuristicPolicy.labeler = { ...heuristicPolicy.labeler, model: null };
  const heuristic = await labelTask("Fix the crash on startup", heuristicPolicy, {}, preFeatures);
  assert.deepEqual(heuristic, {
    label: "bugfix",
    labeler_model: "heuristic",
    time_bucket: "lt15m",
    has_repro: null,
    labeler_cost_usd: null,
    labeler_latency_ms: null,
    warning: null,
  });
});

test("labelTask keeps the heuristic and warns when the model cannot label", async () => {
  const policy = arm();
  policy.labeler = { ...policy.labeler, model: "labeler-1" };

  const labelled = await labelTask(
    "Fix the crash on startup",
    policy,
    {
      env: { DEEPSEEK_API_KEY: "secret" },
      fetchImpl: stubFetch(() => new Response("down", { status: 500 })),
    },
    { description_chars: 20, files_mentioned: 1 },
  );
  assert.equal(labelled.label, "bugfix");
  assert.equal(labelled.labeler_model, "heuristic");
  assert.equal(labelled.time_bucket, "lt15m");
  assert.equal(labelled.has_repro, null);
  assert.match(labelled.warning ?? "", /^labeler: http: .*; fell back to heuristic$/);
});
