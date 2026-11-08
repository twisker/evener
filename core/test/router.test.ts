import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/cli.js";
import { defaultPolicy } from "../src/config.js";
import {
  decide,
  evaluateRules,
  fallbackTarget,
  firstEnabledInChain,
  openCircuits,
} from "../src/router.js";
import type { DecideInput } from "../src/router.js";
import { openStore } from "../src/store.js";
import type { Store } from "../src/store.js";
import type {
  EvenerEvent,
  Label,
  Policy,
  TaskCreatedPayload,
  TaskRow,
} from "../src/types.js";
import { uuid } from "../src/util.js";

const NOW = "2026-11-09T12:00:00.000Z";
const POLICY_VERSION = "abcdef123456";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempStore(t: TestContext): Store {
  const store = openStore(":memory:");
  t.after(() => store.close());
  return store;
}

interface SeededTask {
  taskId: string;
  task: TaskRow;
  created: TaskCreatedPayload;
}

function seedTask(
  store: Store,
  label: Label,
  options: {
    constraints?: string[];
    excerpt?: string | null;
    descriptionHash?: string;
    hostSessionId?: string | null;
  } = {},
): SeededTask {
  const taskId = uuid();
  const created: TaskCreatedPayload = {
    description_hash: options.descriptionHash ?? "a".repeat(64),
    description_excerpt: options.excerpt ?? null,
    repo_fingerprint: null,
    pre_features: {
      description_chars: 120,
      files_mentioned: 2,
      repo_files: 10,
      language: "ts",
      has_repro: false,
      cross_file: true,
      time_bucket: "1h_4h",
    },
    analysis_label: label,
    labeler_model: "heuristic",
    constraints: options.constraints ?? [],
  };
  const event: EvenerEvent = {
    event_id: uuid(),
    task_id: taskId,
    round: 1,
    ts: NOW,
    type: "task.created",
    host: "claude-code",
    host_session_id: options.hostSessionId ?? null,
    policy_version: POLICY_VERSION,
    schema_version: 1,
    data: created,
  };
  store.appendEvent(event);
  const task = store.getTask(taskId);
  assert.ok(task !== null, "task projection must exist");
  return { taskId, task, created };
}

function circuit(
  store: Store,
  taskId: string,
  target: string,
  state: "open" | "closed",
  until: string | null,
): void {
  store.appendEvent({
    event_id: uuid(),
    task_id: taskId,
    round: 1,
    ts: NOW,
    type: "target.circuit",
    host: "claude-code",
    host_session_id: null,
    policy_version: POLICY_VERSION,
    schema_version: 1,
    data: { target, state, until },
  });
}

function basePolicy(): Policy {
  const policy = defaultPolicy();
  policy.rules = [];
  policy.classifier.model = null;
  return policy;
}

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

function abortingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        reject(new Error("missing abort signal"));
        return;
      }
      if (signal.aborted) {
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        reject(aborted);
        return;
      }
      signal.addEventListener("abort", () => {
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        reject(aborted);
      });
    });
}

function inputFor(
  store: Store,
  policy: Policy,
  seeded: SeededTask,
  overrides: Partial<DecideInput> = {},
): DecideInput {
  return {
    store,
    policy,
    arm: null,
    task: seeded.task,
    created: seeded.created,
    env: {},
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

test("evaluateRules applies the first matching condition", () => {
  const features = {
    label: "bugfix" as const,
    pre_features: {
      description_chars: 10,
      files_mentioned: 2,
      repo_files: null,
      language: "ts" as const,
      has_repro: false,
      cross_file: true,
      time_bucket: "lt15m" as const,
    },
    constraints: [],
    excerpt: null,
  };

  const wide = evaluateRules(
    [{ id: "wide", if: { files_mentioned_gte: 8 }, then: "host" }],
    features,
  );
  assert.equal(wide, null);

  const match = evaluateRules(
    [
      { id: "wide", if: { files_mentioned_gte: 8 }, then: "host" },
      { id: "bug", if: { label: "bugfix" }, then: "codex" },
      { id: "second", if: { label: "bugfix" }, then: "dsh" },
    ],
    features,
  );
  assert.ok(match !== null);
  assert.equal(match.rule.id, "bug");
  assert.equal(match.target, "codex");
});

test("an AND rule matches only when every condition holds", () => {
  const features = {
    label: "bugfix" as const,
    pre_features: {
      description_chars: 500,
      files_mentioned: 3,
      repo_files: null,
      language: "ts" as const,
      has_repro: false,
      cross_file: true,
      time_bucket: "1h_4h" as const,
    },
    constraints: [],
    excerpt: null,
  };

  const rule = {
    id: "bugfix_no_repro_cross_file",
    if: { label: "bugfix" as const, has_repro: false, cross_file: true },
    then: "host",
  };

  const match = evaluateRules([rule], features);
  assert.equal(match?.rule.id, "bugfix_no_repro_cross_file");

  const withRepro = {
    ...features,
    pre_features: { ...features.pre_features, has_repro: true },
  };
  assert.equal(evaluateRules([rule], withRepro), null);

  const singleFile = {
    ...features,
    pre_features: { ...features.pre_features, cross_file: false },
  };
  assert.equal(evaluateRules([rule], singleFile), null);

  const wrongLabel = { ...features, label: "feature" as const };
  assert.equal(evaluateRules([rule], wrongLabel), null);

  assert.equal(
    evaluateRules(
      [{ id: "long", if: { time_bucket: "gt4h" }, then: "host" }],
      features,
    ),
    null,
  );
  assert.equal(
    evaluateRules(
      [{ id: "ts", if: { language: "ts", time_bucket: "1h_4h" }, then: "host" }],
      features,
    )?.rule.id,
    "ts",
  );
});

// ---------------------------------------------------------------------------
// Circuits / chain helpers
// ---------------------------------------------------------------------------

test("openCircuits uses the latest event per target and only future deadlines", (t) => {
  const store = tempStore(t);
  const seeded = seedTask(store, "mechanical");

  circuit(store, seeded.taskId, "dsh", "open", "2026-11-09T12:30:00.000Z");
  assert.deepEqual([...openCircuits(store, NOW)], ["dsh"]);

  circuit(store, seeded.taskId, "dsh", "closed", null);
  assert.deepEqual([...openCircuits(store, NOW)], []);

  circuit(store, seeded.taskId, "codex", "open", "2026-11-09T11:00:00.000Z");
  assert.deepEqual([...openCircuits(store, NOW)], []);
});

test("firstEnabledInChain and fallbackTarget skip disabled and open targets", () => {
  const policy = basePolicy();
  const dsh = policy.targets["dsh"];
  assert.ok(dsh !== undefined);
  dsh.enabled = false;

  assert.equal(firstEnabledInChain(policy, new Set()), "codex");
  assert.equal(firstEnabledInChain(policy, new Set(), "codex"), "host");
  assert.equal(fallbackTarget(policy, "mechanical", new Set()), "codex");

  assert.equal(fallbackTarget(policy, "mechanical", new Set(["codex"])), "host");
});

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

test("rules win over the classifier without calling it", async (t) => {
  const store = tempStore(t);
  const seeded = seedTask(store, "bugfix");
  const policy = basePolicy();
  policy.rules = [{ id: "bugfix-host", if: { label: "bugfix" }, then: "host" }];
  policy.classifier.model = "classifier-1";

  let calls = 0;
  const decision = await decide(
    inputFor(store, policy, seeded, {
      fetchImpl: stubFetch(() => {
        calls += 1;
        return chatResponse('{"target":"codex","scores":{"codex":1},"rationale":"x"}');
      }),
    }),
  );

  assert.equal(calls, 0);
  assert.equal(decision.target, "host");
  assert.equal(decision.decided_by, "rule");
  assert.equal(decision.rule_id, "bugfix-host");
  assert.equal(decision.locked, false);
  assert.deepEqual(decision.candidates, [{ target: "host", score: 1 }]);
});

test("private_path locks the decision to host", async (t) => {
  const store = tempStore(t);
  const seeded = seedTask(store, "feature", { constraints: ["private_path"] });
  const policy = basePolicy();
  policy.rules = [
    { id: "private", if: { constraint: "private_path" }, then: "host", locked: true },
  ];
  policy.classifier.model = "classifier-1";

  const decision = await decide(inputFor(store, policy, seeded));

  assert.equal(decision.target, "host");
  assert.equal(decision.decided_by, "rule");
  assert.equal(decision.rule_id, "private");
  assert.equal(decision.locked, true);
});

test("a disabled fallback target walks the escalation chain", async (t) => {
  const store = tempStore(t);
  const seeded = seedTask(store, "mechanical");
  const policy = basePolicy();
  const dsh = policy.targets["dsh"];
  assert.ok(dsh !== undefined);
  dsh.enabled = false;

  const decision = await decide(inputFor(store, policy, seeded));

  assert.equal(decision.target, "codex");
  assert.equal(decision.decided_by, "fallback");
  assert.deepEqual(decision.candidates, [{ target: "codex", score: 1 }]);
});

test("a classifier timeout falls back", async (t) => {
  const store = tempStore(t);
  const seeded = seedTask(store, "bugfix");
  const policy = basePolicy();
  policy.classifier.model = "classifier-1";
  policy.classifier.timeout_ms = 10;

  const decision = await decide(
    inputFor(store, policy, seeded, {
      env: { EVENER_CLASSIFIER_API_KEY: "secret" },
      fetchImpl: abortingFetch(),
    }),
  );

  assert.equal(decision.target, "codex");
  assert.equal(decision.decided_by, "fallback");
  assert.equal(decision.classifier_model, null);
});

test("classifier answers wrapped in fences are parsed", async (t) => {
  const store = tempStore(t);
  const seeded = seedTask(store, "bugfix");
  const policy = basePolicy();
  policy.classifier.model = "classifier-1";

  const decision = await decide(
    inputFor(store, policy, seeded, {
      env: { EVENER_CLASSIFIER_API_KEY: "secret" },
      fetchImpl: stubFetch(() =>
        chatResponse(
          '```json\n{"target":"dsh","scores":{"dsh":0.9,"codex":0.1},"rationale":"cheapest"}\n```',
        ),
      ),
    }),
  );

  assert.equal(decision.target, "dsh");
  assert.equal(decision.decided_by, "classifier");
  assert.equal(decision.classifier_model, "classifier-1");
  assert.equal(decision.rationale, "cheapest");
  assert.deepEqual(decision.candidates, [
    { target: "dsh", score: 0.9 },
    { target: "codex", score: 0.1 },
  ]);
  assert.ok(decision.classifier_cost_usd !== null);
});

test("a classifier choice of a disabled target falls back", async (t) => {
  const store = tempStore(t);
  const seeded = seedTask(store, "bugfix");
  const policy = basePolicy();
  policy.classifier.model = "classifier-1";
  const dsh = policy.targets["dsh"];
  assert.ok(dsh !== undefined);
  dsh.enabled = false;

  const decision = await decide(
    inputFor(store, policy, seeded, {
      env: { EVENER_CLASSIFIER_API_KEY: "secret" },
      fetchImpl: stubFetch(() =>
        chatResponse('{"target":"dsh","scores":{"dsh":1},"rationale":"x"}'),
      ),
    }),
  );

  assert.equal(decision.target, "codex");
  assert.equal(decision.decided_by, "fallback");
});

test("an open circuit excludes a fallback target", async (t) => {
  const store = tempStore(t);
  const seeded = seedTask(store, "mechanical");
  circuit(store, seeded.taskId, "dsh", "open", "2026-11-09T12:30:00.000Z");

  const policy = basePolicy();
  policy.fallback_table.mechanical = "dsh";

  const decision = await decide(inputFor(store, policy, seeded));

  assert.equal(decision.target, "codex");
  assert.equal(decision.decided_by, "fallback");
});

test("the prompt omits the description hash and the excerpt when privacy is off", async (t) => {
  const store = tempStore(t);
  const hash = "f".repeat(64);
  const seeded = seedTask(store, "bugfix", {
    constraints: ["from-host"],
    excerpt: "TOP SECRET EXCERPT",
    descriptionHash: hash,
  });
  const policy = basePolicy();
  policy.privacy.store_description_excerpt = false;
  policy.classifier.model = "classifier-1";

  let userPrompt = "";
  const decision = await decide(
    inputFor(store, policy, seeded, {
      env: { EVENER_CLASSIFIER_API_KEY: "secret" },
      fetchImpl: stubFetch((_url, init) => {
        const raw = typeof init?.body === "string" ? init.body : "";
        const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
        userPrompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
        return chatResponse('{"target":"codex","scores":{"codex":1},"rationale":"x"}');
      }),
    }),
  );

  assert.equal(decision.target, "codex");
  assert.equal(decision.decided_by, "classifier");
  assert.equal(userPrompt.includes(hash), false);
  assert.equal(userPrompt.includes("TOP SECRET EXCERPT"), false);
  assert.equal(userPrompt.includes("description_hash"), false);
  assert.equal(userPrompt.includes("from-host"), true);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Harness {
  io: CliIO;
  stdout(): string;
}

function harness(): Harness {
  const out: string[] = [];
  const io: CliIO = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: () => undefined,
    env: {},
    cwd: process.cwd(),
  };
  return { io, stdout: () => out.join("") };
}

async function run<T>(argv: string[]): Promise<{ code: number; payload: T }> {
  const h = harness();
  const code = await runCli(argv, h.io);
  const text = h.stdout();
  assert.ok(text.length > 0, `no output for ${argv.join(" ")}`);
  return { code, payload: JSON.parse(text) as T };
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "evener-router-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function createTask(
  home: string,
  t: TestContext,
  description: string,
  extraArgs: string[] = [],
): Promise<string> {
  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, description, "utf8");
  const created = await run<{ task_id: string }>([
    "task",
    "create",
    "--home",
    home,
    "--description-file",
    descriptionFile,
    "--cwd",
    home,
    ...extraArgs,
  ]);
  assert.equal(created.code, 0);
  return created.payload.task_id;
}

interface DecideOutput {
  task_id: string;
  round: number;
  target: string;
  decided_by: string;
  rule_id: string | null;
  rationale: string;
  candidates: { target: string; score: number }[];
  arm: string | null;
  locked: boolean;
}

test("decide CLI routes once, persists route.decided and refuses a routed task", async (t) => {
  const home = tempDir(t);
  assert.equal((await run<{ home: string }>(["init", "--home", home])).code, 0);
  const taskId = await createTask(home, t, "Fix the startup crash");

  const decided = await run<DecideOutput>([
    "decide",
    "--home",
    home,
    "--task",
    taskId,
  ]);
  assert.equal(decided.code, 0);
  assert.equal(decided.payload.task_id, taskId);
  assert.equal(decided.payload.round, 1);
  assert.equal(decided.payload.target, "codex");
  assert.equal(decided.payload.decided_by, "fallback");
  assert.equal(decided.payload.rule_id, null);
  assert.equal(decided.payload.arm, null);
  assert.equal(decided.payload.locked, false);
  assert.deepEqual(decided.payload.candidates, [{ target: "codex", score: 1 }]);

  const status = await run<{ task: { state: string }; events: { type: string }[] }>([
    "status",
    "--home",
    home,
    "--task",
    taskId,
  ]);
  assert.equal(status.payload.task.state, "routed");
  assert.deepEqual(
    status.payload.events.map((event) => event.type),
    ["task.created", "route.decided"],
  );

  const again = await run<{ error: { code: string } }>([
    "decide",
    "--home",
    home,
    "--task",
    taskId,
  ]);
  assert.equal(again.code, 1);
  assert.equal(again.payload.error.code, "invalid_state");
});

test("decide --dry-run prints without appending and private_path locks to host", async (t) => {
  const home = tempDir(t);
  assert.equal((await run<{ home: string }>(["init", "--home", home])).code, 0);

  const privateTask = await createTask(home, t, "Change the deployment settings", [
    "--files",
    "config/.env.production",
  ]);

  const decided = await run<DecideOutput>([
    "decide",
    "--home",
    home,
    "--task",
    privateTask,
    "--dry-run",
  ]);
  assert.equal(decided.code, 0);
  assert.equal(decided.payload.target, "host");
  assert.equal(decided.payload.rule_id, "private");
  assert.equal(decided.payload.locked, true);

  const status = await run<{ task: { state: string }; events: { type: string }[] }>([
    "status",
    "--home",
    home,
    "--task",
    privateTask,
  ]);
  assert.equal(status.payload.task.state, "created");
  assert.equal(status.payload.events.length, 1);
});
