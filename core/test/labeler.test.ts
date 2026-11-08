import assert from "node:assert/strict";
import test from "node:test";
import { defaultPolicy } from "../src/config.js";
import { labelTask } from "../src/labeler.js";

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
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
    model: "labeler-1",
    prompt_extra: promptExtra,
  };
  return policy;
}

test("labelTask uses the heuristic label and time bucket without a model", async () => {
  const labelled = await labelTask(
    "Fix the crash on startup",
    defaultPolicy(),
    {},
    { description_chars: 200, files_mentioned: 1 },
  );

  assert.deepEqual(labelled, {
    label: "bugfix",
    labeler_model: "heuristic",
    time_bucket: "lt15m",
  });
});

test("the model labeler asks for label and time bucket and appends prompt_extra", async () => {
  const policy = modelPolicy("Prefer the narrowest plausible estimate.");
  let userPrompt = "";

  const labelled = await labelTask(
    "Update the docs",
    policy,
    {
      env: { EVENER_CLASSIFIER_API_KEY: "secret" },
      fetchImpl: stubFetch((_url, init) => {
        const raw = typeof init?.body === "string" ? init.body : "";
        const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
        userPrompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
        return chatResponse('{"label":"docs","time_bucket":"15m_1h"}');
      }),
    },
    { description_chars: 40, files_mentioned: 1 },
  );

  assert.deepEqual(labelled, {
    label: "docs",
    labeler_model: "labeler-1",
    time_bucket: "15m_1h",
  });
  assert.match(userPrompt, /"label"/);
  assert.match(userPrompt, /"time_bucket"/);
  assert.match(userPrompt, /<15 min/);
  assert.match(userPrompt, /15 min-1 h/);
  assert.match(userPrompt, /1-4 h/);
  assert.match(userPrompt, />4 h/);
  assert.match(userPrompt, /Prefer the narrowest plausible estimate\./);
});

test("an invalid model time bucket falls back to the heuristic", async () => {
  const policy = modelPolicy();
  const labelled = await labelTask(
    "Refactor the parser",
    policy,
    {
      env: { EVENER_CLASSIFIER_API_KEY: "secret" },
      fetchImpl: stubFetch(() =>
        chatResponse('{"label":"refactor","time_bucket":"about an hour"}'),
      ),
    },
    { description_chars: 2000, files_mentioned: 4 },
  );

  assert.equal(labelled.label, "refactor");
  assert.equal(labelled.labeler_model, "labeler-1");
  assert.equal(labelled.time_bucket, "1h_4h");
});

test("an invalid model label falls back to the heuristic label and bucket", async () => {
  const policy = modelPolicy();
  const labelled = await labelTask(
    "Fix the crash on startup",
    policy,
    {
      env: { EVENER_CLASSIFIER_API_KEY: "secret" },
      fetchImpl: stubFetch(() =>
        chatResponse('{"label":"not-a-label","time_bucket":"lt15m"}'),
      ),
    },
    { description_chars: 20, files_mentioned: 1 },
  );

  assert.deepEqual(labelled, {
    label: "bugfix",
    labeler_model: "heuristic",
    time_bucket: "lt15m",
  });
});
