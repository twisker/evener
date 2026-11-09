import assert from "node:assert/strict";
import test from "node:test";
import { defaultPolicy } from "../src/config.js";
import { labelTask } from "../src/labeler.js";

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

function modelPolicy(promptExtra: string | null = null) {
  const policy = defaultPolicy();
  policy.labeler = {
    ...policy.labeler,
    model: "deepseek-flash",
    prompt_extra: promptExtra,
  };
  return policy;
}

test("labelTask uses the heuristic label and time bucket without a model", async () => {
  const policy = defaultPolicy();
  policy.labeler = { ...policy.labeler, model: null };

  const labelled = await labelTask(
    "Fix the crash on startup",
    policy,
    {},
    { description_chars: 200, files_mentioned: 1 },
  );

  assert.deepEqual(labelled, {
    label: "bugfix",
    labeler_model: "heuristic",
    time_bucket: "lt15m",
    has_repro: null,
    labeler_cost_usd: null,
    labeler_latency_ms: null,
    warning: null,
  });
});

test("the model path parses all three fields, prices usage and sends request_extra", async (t) => {
  const policy = modelPolicy("Prefer the narrowest plausible estimate.");
  let userPrompt = "";
  let seenBody: Record<string, unknown> = {};
  let authorization = "";

  const previous = process.env["DEEPSEEK_API_KEY"];
  process.env["DEEPSEEK_API_KEY"] = "process-secret";
  t.after(() => {
    if (previous === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = previous;
  });

  const labelled = await labelTask(
    "Update the docs",
    policy,
    {
      env: { DEEPSEEK_API_KEY: "env-secret" },
      fetchImpl: stubFetch((_url, init) => {
        authorization = String(
          (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? "",
        );
        const raw = typeof init?.body === "string" ? init.body : "";
        seenBody = JSON.parse(raw) as Record<string, unknown>;
        userPrompt =
          (
            seenBody["messages"] as { role: string; content: string }[] | undefined
          )?.find((message) => message.role === "user")?.content ?? "";
        return chatResponse('{"label":"bugfix","time_bucket":"1h_4h","has_repro":false}', {
          prompt_tokens: 176,
          completion_tokens: 23,
        });
      }),
    },
    { description_chars: 40, files_mentioned: 1 },
  );

  assert.equal(labelled.label, "bugfix");
  assert.equal(labelled.labeler_model, "deepseek-flash");
  assert.equal(labelled.time_bucket, "1h_4h");
  assert.equal(labelled.has_repro, false);
  assert.equal(labelled.warning, null);
  // 176/1e6 * 0.15 + 23/1e6 * 0.60
  assert.ok(Math.abs((labelled.labeler_cost_usd ?? -1) - 0.0000402) < 1e-12);
  assert.ok((labelled.labeler_latency_ms ?? -1) >= 0);

  assert.equal(authorization, "Bearer env-secret");
  assert.deepEqual(seenBody["thinking"], { type: "disabled" });
  assert.deepEqual(seenBody["response_format"], { type: "json_object" });
  assert.equal(seenBody["model"], "deepseek-flash");
  assert.match(userPrompt, /"label"/);
  assert.match(userPrompt, /"time_bucket"/);
  assert.match(userPrompt, /"has_repro"/);
  assert.match(userPrompt, /<15 min/);
  assert.match(userPrompt, /15 min-1 h/);
  assert.match(userPrompt, /1-4 h/);
  assert.match(userPrompt, />4 h/);
  assert.match(userPrompt, /Prefer the narrowest plausible estimate\./);
});

test("a missing key falls back to the heuristic with a no_key warning", async () => {
  const labelled = await labelTask(
    "Fix the crash on startup",
    modelPolicy(),
    { env: {} },
    { description_chars: 20, files_mentioned: 1 },
  );

  assert.equal(labelled.label, "bugfix");
  assert.equal(labelled.labeler_model, "heuristic");
  assert.equal(labelled.time_bucket, "lt15m");
  assert.equal(labelled.has_repro, null);
  assert.equal(labelled.labeler_cost_usd, null);
  assert.match(labelled.warning ?? "", /^labeler: no_key: .*; fell back to heuristic$/);
});

test("an HTTP error falls back to the heuristic with an http warning", async () => {
  const labelled = await labelTask(
    "Fix the crash on startup",
    modelPolicy(),
    {
      env: { DEEPSEEK_API_KEY: "secret" },
      fetchImpl: stubFetch(() => new Response("unauthorized", { status: 401 })),
    },
    { description_chars: 20, files_mentioned: 1 },
  );

  assert.equal(labelled.label, "bugfix");
  assert.equal(labelled.labeler_model, "heuristic");
  assert.match(labelled.warning ?? "", /^labeler: http: .*; fell back to heuristic$/);
});

test("a non-boolean has_repro becomes null while the model label is kept", async () => {
  const labelled = await labelTask(
    "Update the docs",
    modelPolicy(),
    {
      env: { DEEPSEEK_API_KEY: "secret" },
      fetchImpl: stubFetch(() =>
        chatResponse('{"label":"docs","time_bucket":"15m_1h","has_repro":"yes"}'),
      ),
    },
    { description_chars: 40, files_mentioned: 1 },
  );

  assert.equal(labelled.label, "docs");
  assert.equal(labelled.labeler_model, "deepseek-flash");
  assert.equal(labelled.time_bucket, "15m_1h");
  assert.equal(labelled.has_repro, null);
  assert.equal(labelled.warning, null);
});

test("an invalid model time bucket falls back to the heuristic bucket", async () => {
  const policy = modelPolicy();
  const labelled = await labelTask(
    "Refactor the parser",
    policy,
    {
      env: { DEEPSEEK_API_KEY: "secret" },
      fetchImpl: stubFetch(() =>
        chatResponse('{"label":"refactor","time_bucket":"about an hour"}'),
      ),
    },
    { description_chars: 2000, files_mentioned: 4 },
  );

  assert.equal(labelled.label, "refactor");
  assert.equal(labelled.labeler_model, "deepseek-flash");
  assert.equal(labelled.time_bucket, "1h_4h");
  assert.equal(labelled.warning, null);
});

test("an invalid model label falls back to the heuristic label and bucket", async () => {
  const policy = modelPolicy();
  const labelled = await labelTask(
    "Fix the crash on startup",
    policy,
    {
      env: { DEEPSEEK_API_KEY: "secret" },
      fetchImpl: stubFetch(() =>
        chatResponse('{"label":"not-a-label","time_bucket":"lt15m"}'),
      ),
    },
    { description_chars: 20, files_mentioned: 1 },
  );

  assert.equal(labelled.label, "bugfix");
  assert.equal(labelled.labeler_model, "heuristic");
  assert.equal(labelled.time_bucket, "lt15m");
  assert.equal(labelled.has_repro, null);
  assert.match(labelled.warning ?? "", /^labeler: parse: .*; fell back to heuristic$/);
});
