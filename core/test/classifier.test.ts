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
import { defaultPolicy } from "../src/config.js";
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
    pre_features: { description_chars: 42, files_mentioned: 2, repo_files: 10 },
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
    fetchImpl,
  });

  assert.equal(seenUrl, "https://classifier.test/v1/chat/completions");
  assert.equal(seenAuthorization, "Bearer test-key");
  assert.equal(seenBody["model"], "classifier-1");
  assert.equal(seenBody["max_tokens"], 50);
  assert.equal(seenBody["temperature"], 0);
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
  assert.ok(Math.abs(result.cost_usd - 0.49) < 1e-9);
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
  policy.labeler = { model: "labeler-1", endpoint: null, api_key_env: null };

  let seenUrl = "";
  let seenUser = "";
  const fetchImpl = stubFetch((url, init) => {
    seenUrl = url;
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
    seenUser = body.messages?.find((message) => message.role === "user")?.content ?? "";
    return chatResponse('{"label":"docs"}');
  });

  const label = await labelWithModel(
    policy.labeler,
    policy.taxonomy,
    "Update the README",
    { CLASSIFIER_KEY: "secret" },
    fetchImpl,
    policy.classifier,
  );

  assert.equal(label, "docs");
  assert.equal(seenUrl, "https://classifier.test/v1/chat/completions");
  assert.match(seenUser, /Classify this coding task into exactly one label from: bugfix/);
  assert.match(seenUser, /Answer \{"label": "<label>"\}/);
  assert.match(seenUser, /Update the README/);
});

test("labelWithModel returns unknown on HTTP failure", async () => {
  const policy = arm();
  policy.labeler = { model: "labeler-1", endpoint: null, api_key_env: null };

  const label = await labelWithModel(
    policy.labeler,
    policy.taxonomy,
    "Update the README",
    { CLASSIFIER_KEY: "secret" },
    stubFetch(() => new Response("down", { status: 500 })),
    policy.classifier,
  );

  assert.equal(label, "unknown");
});

test("labelTask uses the model label when configured and the heuristic otherwise", async () => {
  const policy = arm();
  policy.labeler = { model: "labeler-1", endpoint: null, api_key_env: null };

  const labelled = await labelTask("Fix the crash on startup", policy, {
    env: { CLASSIFIER_KEY: "secret" },
    fetchImpl: stubFetch(() => chatResponse('{"label":"refactor"}')),
  });
  assert.deepEqual(labelled, { label: "refactor", labeler_model: "labeler-1" });

  const heuristicPolicy = arm();
  heuristicPolicy.labeler = { model: null, endpoint: null, api_key_env: null };
  const heuristic = await labelTask("Fix the crash on startup", heuristicPolicy, {});
  assert.deepEqual(heuristic, { label: "bugfix", labeler_model: "heuristic" });
});

test("labelTask keeps the heuristic when the model cannot label", async () => {
  const policy = arm();
  policy.labeler = { model: "labeler-1", endpoint: null, api_key_env: null };

  const labelled = await labelTask("Fix the crash on startup", policy, {
    env: { CLASSIFIER_KEY: "secret" },
    fetchImpl: stubFetch(() => new Response("down", { status: 500 })),
  });
  assert.deepEqual(labelled, { label: "bugfix", labeler_model: "heuristic" });
});
