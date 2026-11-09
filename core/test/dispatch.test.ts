import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcess, spawn } from "node:child_process";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/cli.js";
import { defaultPolicy, defaultPricing } from "../src/config.js";
import { createCodexParser } from "../src/dispatch/codex.js";
import { createDshParser } from "../src/dispatch/dsh.js";
import { runDispatch } from "../src/dispatch/index.js";
import type { RunDispatchOptions } from "../src/dispatch/index.js";
import { runJsonlProcess } from "../src/dispatch/process.js";
import { openStore } from "../src/store.js";
import type { Store } from "../src/store.js";
import type {
  EvenerEvent,
  EventType,
  PayloadByType,
  TaskRow,
} from "../src/types.js";
import { uuid } from "../src/util.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES_DIR = fileURLToPath(new URL("../../test/fixtures/", import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

function parserLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

const CODEX_FINAL_TEXT = "Implemented the change and ran the tests.";
const CODEX_USAGE = { input_tokens: 13239, cached_input_tokens: 0, cache_write_input_tokens: 13236, output_tokens: 5, reasoning_output_tokens: 0 };

// ---------------------------------------------------------------------------
// Fake child process
// ---------------------------------------------------------------------------

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string | undefined;
}

interface FakeBehavior {
  stdoutText?: string;
  stderrText?: string;
  exitCode?: number | null;
  /** Never exits on its own; only the timeout kill removes it. */
  hang?: boolean;
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  exitCode: number | null = null;
  #finished = false;

  finish(code: number | null): void {
    if (this.#finished) return;
    this.#finished = true;
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.#finished) return false;
    this.stdout.end();
    this.stderr.end();
    this.#finished = true;
    this.exitCode = null;
    this.emit("exit", null, signal ?? "SIGTERM");
    this.emit("close", null, signal ?? "SIGTERM");
    return true;
  }
}

function fakeSpawn(behavior: FakeBehavior, calls: SpawnCall[]): typeof spawn {
  const impl = (
    command: string,
    args?: readonly string[],
    options?: { cwd?: string | URL },
  ): ChildProcess => {
    calls.push({
      command,
      args: [...(args ?? [])],
      cwd: typeof options?.cwd === "string" ? options.cwd : undefined,
    });

    const child = new FakeChild();
    if (behavior.hang === true) return child as unknown as ChildProcess;

    setImmediate(() => {
      child.stdout.end(behavior.stdoutText ?? "", () => {
        child.stderr.end(behavior.stderrText ?? "", () => {
          child.finish(behavior.exitCode === undefined ? 0 : behavior.exitCode);
        });
      });
    });
    return child as unknown as ChildProcess;
  };

  return impl as unknown as typeof spawn;
}

// ---------------------------------------------------------------------------
// Store harness
// ---------------------------------------------------------------------------

interface Harness {
  dir: string;
  store: Store;
}

function harness(t: TestContext): Harness {
  const dir = mkdtempSync(join(tmpdir(), "evener-dispatch-"));
  const store = openStore(join(dir, "evener.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

const POLICY_VERSION = "abcdef123456";
const EVENT_TS = "2026-11-09T00:00:00.000Z";

function makeEvent<T extends EventType>(
  taskId: string,
  type: T,
  round: number,
  data: PayloadByType[T],
): EvenerEvent {
  return {
    event_id: uuid(),
    task_id: taskId,
    round,
    ts: EVENT_TS,
    type,
    host: "claude-code",
    host_session_id: "host-session-1",
    policy_version: POLICY_VERSION,
    schema_version: 1,
    data,
  } as EvenerEvent;
}

function seedRoutedTask(store: Store, target: string, classifierCost = 0): TaskRow {
  const taskId = uuid();
  const createdData: PayloadByType["task.created"] & { arm: string | null } = {
    description_hash: "a".repeat(64),
    description_excerpt: null,
    repo_fingerprint: null,
    pre_features: {
      description_chars: 20,
      files_mentioned: 1,
      repo_files: null,
      language: null,
      has_repro: false,
      cross_file: false,
      time_bucket: "lt15m",
    },
    analysis_label: "bugfix",
    labeler_model: "heuristic",
    constraints: [],
    arm: null,
  };
  store.appendEvent(makeEvent(taskId, "task.created", 1, createdData));
  store.appendEvent(
    makeEvent(taskId, "route.decided", 1, {
      target,
      candidates: [{ target, score: 1 }],
      rationale: "test route",
      decided_by: "fallback",
      rule_id: null,
      classifier_model: null,
      classifier_latency_ms: null,
      classifier_cost_usd: classifierCost,
      arm: null,
      escalated_from: null,
    }),
  );
  const task = store.getTask(taskId);
  assert.ok(task !== null);
  return task;
}

function promptFile(dir: string, text: string): string {
  const path = join(dir, "prompt.txt");
  writeFileSync(path, text, "utf8");
  return path;
}

interface DispatchOverrides {
  policy?: RunDispatchOptions["policy"];
  target?: string;
  env?: RunDispatchOptions["env"];
  timeoutS?: number;
  spawnImpl?: typeof spawn;
}

function dispatchOptions(
  h: Harness,
  task: TaskRow,
  overrides: DispatchOverrides = {},
): RunDispatchOptions {
  return {
    store: h.store,
    policy: overrides.policy ?? defaultPolicy(),
    pricing: defaultPricing(),
    pricingVersion: "fedcba123456",
    task,
    target: overrides.target ?? "codex",
    promptPath: promptFile(h.dir, "Please fix the failing test."),
    cwd: h.dir,
    env: overrides.env ?? { OPENAI_API_KEY: "test-key" },
    now: () => EVENT_TS,
    home: h.dir,
    ...(overrides.timeoutS === undefined ? {} : { timeoutS: overrides.timeoutS }),
    ...(overrides.spawnImpl === undefined ? {} : { spawnImpl: overrides.spawnImpl }),
  };
}

// ---------------------------------------------------------------------------
// Adapter parsers
// ---------------------------------------------------------------------------

test("codex parser normalises usage, tool calls, session and completion", () => {
  const parser = createCodexParser();
  for (const line of parserLines(fixture("codex-run.jsonl"))) {
    parser.onLine(JSON.parse(line), line);
  }
  const parsed = parser.result();

  assert.deepEqual(parsed.usage, { input: 13239, cached_input: 0, output: 5, reasoning: 0 });
  assert.equal(parsed.tool_calls, 1);
  assert.equal(parsed.target_session_id, "thread-codex-1");
  assert.equal(parsed.completed, true);
  assert.equal(parsed.final_text, CODEX_FINAL_TEXT);
  assert.deepEqual(parsed.usage_raw, CODEX_USAGE);
  assert.equal(parsed.model, null);
  assert.equal(parsed.model_ms, null);
  assert.equal(parsed.tool_ms, null);
});

test("dsh parser sums step usage and keeps cache-write in usage_raw", () => {
  const parser = createDshParser();
  for (const line of parserLines(fixture("dsh-run.jsonl"))) {
    parser.onLine(JSON.parse(line), line);
  }
  const parsed = parser.result();

  assert.deepEqual(parsed.usage, {
    input: 1399,
    cached_input: 5248,
    output: 52,
    reasoning: 0,
  });
  assert.equal(parsed.tool_calls, 1);
  assert.equal(parsed.target_session_id, "session-dsh-1");
  assert.equal(parsed.completed, true);
  assert.equal(parsed.final_text, "Done: updated src/main.ts.");

  const raw = parsed.usage_raw as { steps: Record<string, unknown>[] };
  assert.equal(raw.steps.length, 2);
  assert.equal(raw.steps[0]?.["cacheWriteTokens"], 0);
  assert.equal(JSON.stringify(raw).includes("cacheWriteTokens"), true);
  assert.equal(parsed.model_ms, null);
  assert.equal(parsed.tool_ms, null);
});

test("codex parser splits wall time into model and tool time from item timestamps", () => {
  const parser = createCodexParser();
  for (const line of parserLines(fixture("codex-timed.jsonl"))) {
    parser.onLine(JSON.parse(line), line);
  }

  const parsed = parser.result(5000);
  assert.equal(parsed.tool_ms, 2000);
  assert.equal(parsed.model_ms, 3000);
  assert.equal((parsed.model_ms ?? 0) + (parsed.tool_ms ?? 0), 5000);
});

test("dsh parser splits step and tool time from timestamps", () => {
  const parser = createDshParser();
  for (const line of parserLines(fixture("dsh-timed.jsonl"))) {
    parser.onLine(JSON.parse(line), line);
  }

  const parsed = parser.result(5000);
  assert.equal(parsed.tool_ms, 1000);
  assert.equal(parsed.model_ms, 3000);
  assert.equal((parsed.model_ms ?? 0) + (parsed.tool_ms ?? 0), 4000);
});

test("runJsonlProcess passes non-JSON lines as null and captures stderr", async (t) => {
  const h = harness(t);
  const seen: unknown[] = [];
  const calls: SpawnCall[] = [];
  const result = await runJsonlProcess({
    argv: ["fake", "--json"],
    cwd: h.dir,
    stdinText: "prompt",
    timeoutMs: 1000,
    env: {},
    onLine: (obj, _raw) => {
      seen.push(obj);
    },
    spawnImpl: fakeSpawn(
      {
        stdoutText: '{"a":1}\nnot json\n{"b":2}\n',
        stderrText: "warning: something\n",
      },
      calls,
    ),
  });

  assert.deepEqual(seen, [{ a: 1 }, null, { b: 2 }]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stderr, "warning: something\n");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, ["--json"]);
});

test("runJsonlProcess caps captured stderr at 1 MiB", async (t) => {
  const h = harness(t);
  const calls: SpawnCall[] = [];
  const result = await runJsonlProcess({
    argv: ["fake"],
    cwd: h.dir,
    stdinText: "",
    timeoutMs: 1000,
    env: {},
    onLine: () => undefined,
    spawnImpl: fakeSpawn(
      { stdoutText: "", stderrText: "x".repeat(1024 * 1024 + 1024), exitCode: 0 },
      calls,
    ),
  });

  assert.equal(Buffer.byteLength(result.stderr, "utf8"), 1024 * 1024);
});

// ---------------------------------------------------------------------------
// runDispatch
// ---------------------------------------------------------------------------

test("runDispatch codex success records events, cost and awaiting_acceptance", async (t) => {
  const h = harness(t);
  const task = seedRoutedTask(h.store, "codex");
  const calls: SpawnCall[] = [];
  const prompt = "Please fix the failing test.";

  const result = await runDispatch(
    dispatchOptions(h, task, {
      spawnImpl: fakeSpawn({ stdoutText: fixture("codex-run.jsonl"), exitCode: 0 }, calls),
    }),
  );

  assert.equal(result.status, "success");
  assert.equal(result.exit_code, 0);
  assert.equal(result.target_session_id, "thread-codex-1");
  assert.deepEqual(result.usage, { input: 13239, cached_input: 0, output: 5, reasoning: 0 });
  assert.ok(result.cost_usd > 0);
  assert.notEqual(result.output_path, null);

  assert.equal(calls.length, 1);
  const argv = calls[0]?.args ?? [];
  assert.equal(argv.includes("--json"), true);
  assert.equal(argv.some((arg) => arg.includes("{output_file}")), false);
  assert.equal(argv.includes(result.output_path ?? ""), true);

  const events = h.store.getEvents(task.task_id);
  assert.deepEqual(
    events.map((event) => event.type),
    ["task.created", "route.decided", "dispatch.started", "dispatch.finished"],
  );

  const started = events[2];
  assert.ok(started !== undefined && started.type === "dispatch.started");
  assert.equal(started.data.context_bytes, Buffer.byteLength(prompt, "utf8"));
  assert.equal(started.data.target, "codex");
  assert.equal(started.data.model, "gpt-5.1-codex");
  assert.equal(started.data.command.includes("codex exec --json"), true);

  const finished = events[3];
  assert.ok(finished !== undefined && finished.type === "dispatch.finished");
  assert.equal(finished.data.status, "success");
  assert.equal(finished.data.price_table_version, "fedcba123456");
  assert.equal(finished.data.diff_stats, null);
  assert.equal(finished.data.tool_calls, 1);
  assert.equal(finished.data.exit_code, 0);
  assert.equal(finished.data.target_session_id, "thread-codex-1");
  assert.equal(finished.data.model_ms, null);
  assert.equal(finished.data.tool_ms, null);
  assert.equal(finished.data.pricing_period, "flat");
  const finishedData = finished.data as typeof finished.data & { cost_unknown: boolean };
  assert.equal(finishedData.cost_unknown, false);

  const updated = h.store.getTask(task.task_id);
  assert.ok(updated !== null);
  assert.equal(updated.state, "awaiting_acceptance");
  assert.ok(updated.total_cost_usd > 0);

  assert.equal(readFileSync(result.output_path ?? "", "utf8"), CODEX_FINAL_TEXT);
  assert.equal(existsSync(join(h.dir, "runs", task.task_id, "1.stderr")), true);
});

test("runDispatch selects the dsh adapter and prices summed step usage", async (t) => {
  const h = harness(t);
  const task = seedRoutedTask(h.store, "dsh");
  const calls: SpawnCall[] = [];

  const result = await runDispatch(
    dispatchOptions(h, task, {
      target: "dsh",
      env: { DEEPSEEK_API_KEY: "test-key" },
      spawnImpl: fakeSpawn({ stdoutText: fixture("dsh-run.jsonl"), exitCode: 0 }, calls),
    }),
  );

  assert.equal(result.status, "success");
  assert.deepEqual(result.usage, {
    input: 1399,
    cached_input: 5248,
    output: 52,
    reasoning: 0,
  });
  assert.ok(result.cost_usd > 0);
  assert.equal(result.target_session_id, "session-dsh-1");
  assert.equal(readFileSync(result.output_path ?? "", "utf8"), "Done: updated src/main.ts.");
});

test("runDispatch records a timing split that never exceeds wall time", async (t) => {
  const h = harness(t);
  const task = seedRoutedTask(h.store, "codex");
  const calls: SpawnCall[] = [];

  await runDispatch(
    dispatchOptions(h, task, {
      spawnImpl: fakeSpawn({ stdoutText: fixture("codex-timed.jsonl"), exitCode: 0 }, calls),
    }),
  );

  const finished = h.store
    .getEvents(task.task_id)
    .find((event) => event.type === "dispatch.finished");
  assert.ok(finished !== undefined && finished.type === "dispatch.finished");
  assert.equal(typeof finished.data.model_ms, "number");
  assert.equal(typeof finished.data.tool_ms, "number");
  assert.ok(
    (finished.data.model_ms ?? 0) + (finished.data.tool_ms ?? 0) <= finished.data.wall_ms,
    `model ${String(finished.data.model_ms)} + tool ${String(finished.data.tool_ms)} > wall ${finished.data.wall_ms}`,
  );
});

test("runDispatch maps a non-zero exit code to error", async (t) => {
  const h = harness(t);
  const task = seedRoutedTask(h.store, "codex");
  const calls: SpawnCall[] = [];

  const result = await runDispatch(
    dispatchOptions(h, task, {
      spawnImpl: fakeSpawn({ stdoutText: fixture("codex-run.jsonl"), exitCode: 1 }, calls),
    }),
  );

  assert.equal(result.status, "error");
  assert.equal(result.exit_code, 1);

  const events = h.store.getEvents(task.task_id);
  const finished = events.find((event) => event.type === "dispatch.finished");
  assert.ok(finished !== undefined && finished.type === "dispatch.finished");
  assert.equal(finished.data.status, "error");

  const updated = h.store.getTask(task.task_id);
  assert.ok(updated !== null);
  assert.equal(updated.state, "awaiting_acceptance");
});

test("runDispatch times out a process that never exits", async (t) => {
  const h = harness(t);
  const task = seedRoutedTask(h.store, "codex");
  const calls: SpawnCall[] = [];
  const startedAt = Date.now();

  const result = await runDispatch(
    dispatchOptions(h, task, {
      timeoutS: 0.05,
      spawnImpl: fakeSpawn({ hang: true }, calls),
    }),
  );

  assert.equal(result.status, "timeout");
  assert.equal(result.exit_code, null);
  assert.equal(result.output_path, null);
  assert.ok(Date.now() - startedAt < 3000, "timeout should not wait for the SIGKILL grace period");

  const finished = h.store
    .getEvents(task.task_id)
    .find((event) => event.type === "dispatch.finished");
  assert.ok(finished !== undefined && finished.type === "dispatch.finished");
  assert.equal(finished.data.status, "timeout");
});

test("runDispatch fails before spawning when the API key is missing", async (t) => {
  const h = harness(t);
  const task = seedRoutedTask(h.store, "codex");
  const calls: SpawnCall[] = [];

  const result = await runDispatch(
    dispatchOptions(h, task, {
      env: {},
      spawnImpl: fakeSpawn({ stdoutText: fixture("codex-run.jsonl"), exitCode: 0 }, calls),
    }),
  );

  assert.equal(result.status, "error");
  assert.equal(calls.length, 0);
  assert.equal(result.output_path, null);

  const events = h.store.getEvents(task.task_id);
  assert.equal(events.some((event) => event.type === "dispatch.started"), false);
  assert.equal(events.some((event) => event.type === "target.circuit"), false);
  const finished = events.find((event) => event.type === "dispatch.finished");
  assert.ok(finished !== undefined && finished.type === "dispatch.finished");
  assert.equal(finished.data.status, "error");
});

test("three consecutive target errors open the circuit", async (t) => {
  const h = harness(t);
  const calls: SpawnCall[] = [];

  for (let round = 1; round <= 3; round += 1) {
    const task = seedRoutedTask(h.store, "codex");
    const result = await runDispatch(
      dispatchOptions(h, task, {
        spawnImpl: fakeSpawn({ stdoutText: fixture("codex-run.jsonl"), exitCode: 1 }, calls),
      }),
    );
    assert.equal(result.status, "error");

    const circuits = h.store.listEvents({ types: ["target.circuit"] });
    if (round < 3) {
      assert.equal(circuits.length, 0, `circuit opened too early at round ${round}`);
    } else {
      assert.equal(circuits.length, 1);
      const circuit = circuits[0];
      assert.ok(circuit !== undefined && circuit.type === "target.circuit");
      assert.equal(circuit.data.target, "codex");
      assert.equal(circuit.data.state, "open");
      assert.ok(circuit.data.until !== null);
      assert.ok(Date.parse(circuit.data.until) > Date.parse(EVENT_TS));
    }
  }
});

test("runDispatch returns budget_exceeded without spawning", async (t) => {
  const h = harness(t);
  const policy = defaultPolicy();
  policy.limits.max_cost_per_task_usd = 0.001;
  const task = seedRoutedTask(h.store, "codex", 0.01);
  const calls: SpawnCall[] = [];

  const result = await runDispatch(
    dispatchOptions(h, task, {
      policy,
      spawnImpl: fakeSpawn({ stdoutText: fixture("codex-run.jsonl"), exitCode: 0 }, calls),
    }),
  );

  assert.equal(result.status, "budget_exceeded");
  assert.equal(calls.length, 0);

  const events = h.store.getEvents(task.task_id);
  assert.equal(events.some((event) => event.type === "dispatch.started"), false);
  const finished = events.find((event) => event.type === "dispatch.finished");
  assert.ok(finished !== undefined && finished.type === "dispatch.finished");
  assert.equal(finished.data.status, "budget_exceeded");
});

// ---------------------------------------------------------------------------
// CLI command guards
// ---------------------------------------------------------------------------

interface CliHarness {
  io: CliIO;
  stdout(): string;
}

function cliHarness(env: Readonly<Record<string, string | undefined>> = {}): CliHarness {
  const out: string[] = [];
  return {
    io: {
      stdout: (text) => {
        out.push(text);
      },
      stderr: () => undefined,
      env,
      cwd: process.cwd(),
    },
    stdout: () => out.join(""),
  };
}

async function runJson<T>(argv: string[], env: Readonly<Record<string, string | undefined>> = {}): Promise<{ code: number; payload: T }> {
  const h = cliHarness(env);
  const code = await runCli(argv, h.io);
  return { code, payload: JSON.parse(h.stdout()) as T };
}

test("dispatch CLI rejects a task that is not routed and refuses host", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "evener-dispatch-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.equal((await runJson<{ db_path: string }>(["init", "--home", home])).code, 0);
  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Fix the crash", "utf8");
  const promptPath = promptFile(home, "Fix the crash in src/a.ts");

  const created = await runJson<{ task_id: string }>([
    "task",
    "create",
    "--home",
    home,
    "--description-file",
    descriptionFile,
    "--cwd",
    home,
  ]);
  assert.equal(created.code, 0);

  const invalid = await runJson<{ error: { code: string } }>([
    "dispatch",
    "--home",
    home,
    "--task",
    created.payload.task_id,
    "--prompt-file",
    promptPath,
  ]);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.payload.error.code, "invalid_state");

  const route = {
    target: "host",
    candidates: [{ target: "host", score: 1 }],
    rationale: "questions stay on the host",
    decided_by: "rule",
    rule_id: "question",
    classifier_model: null,
    classifier_latency_ms: null,
    classifier_cost_usd: null,
    arm: null,
    escalated_from: null,
  };
  const routed = await runJson<{ event_id: string }>([
    "event",
    "--home",
    home,
    "--type",
    "route.decided",
    "--task",
    created.payload.task_id,
    "--data",
    JSON.stringify(route),
  ]);
  assert.equal(routed.code, 0);

  const host = await runJson<{ error: { code: string } }>([
    "dispatch",
    "--home",
    home,
    "--task",
    created.payload.task_id,
    "--prompt-file",
    promptPath,
    "--target",
    "host",
  ]);
  assert.equal(host.code, 1);
  assert.equal(host.payload.error.code, "host_not_dispatchable");
});

test("dispatch CLI records an error for a missing API key without spawning", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "evener-dispatch-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.equal((await runJson<{ db_path: string }>(["init", "--home", home])).code, 0);
  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Fix the crash", "utf8");
  const promptPath = promptFile(home, "Fix the crash in src/a.ts");

  const created = await runJson<{ task_id: string }>([
    "task",
    "create",
    "--home",
    home,
    "--description-file",
    descriptionFile,
    "--cwd",
    home,
  ]);
  assert.equal(created.code, 0);

  const route = {
    target: "codex",
    candidates: [{ target: "codex", score: 1 }],
    rationale: "bugfix goes to codex",
    decided_by: "fallback",
    rule_id: null,
    classifier_model: null,
    classifier_latency_ms: null,
    classifier_cost_usd: null,
    arm: null,
    escalated_from: null,
  };
  assert.equal(
    (
      await runJson<{ event_id: string }>([
        "event",
        "--home",
        home,
        "--type",
        "route.decided",
        "--task",
        created.payload.task_id,
        "--data",
        JSON.stringify(route),
      ])
    ).code,
    0,
  );

  const dispatched = await runJson<{ status: string; task_id: string }>(
    [
      "dispatch",
      "--home",
      home,
      "--task",
      created.payload.task_id,
      "--prompt-file",
      promptPath,
      "--cwd",
      home,
    ],
    {},
  );
  assert.equal(dispatched.code, 0);
  assert.equal(dispatched.payload.task_id, created.payload.task_id);
  assert.equal(dispatched.payload.status, "error");

  const status = await runJson<{ task: { state: string } }>([
    "status",
    "--home",
    home,
    "--task",
    created.payload.task_id,
  ]);
  assert.equal(status.payload.task.state, "awaiting_acceptance");
});

// ---------------------------------------------------------------------------
// `evener done` CLI
// ---------------------------------------------------------------------------

async function createCliTask(home: string): Promise<string> {
  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Fix the crash", "utf8");
  const created = await runJson<{ task_id: string }>([
    "task",
    "create",
    "--home",
    home,
    "--description-file",
    descriptionFile,
    "--host-session",
    "session-1",
    "--cwd",
    home,
  ]);
  assert.equal(created.code, 0);
  return created.payload.task_id;
}

async function routeCliTask(home: string, taskId: string, target: string): Promise<void> {
  const route = {
    target,
    candidates: [{ target, score: 1 }],
    rationale: `test route to ${target}`,
    decided_by: "fallback",
    rule_id: null,
    classifier_model: null,
    classifier_latency_ms: null,
    classifier_cost_usd: null,
    arm: null,
    escalated_from: null,
  };
  const routed = await runJson<{ event_id: string }>([
    "event",
    "--home",
    home,
    "--type",
    "route.decided",
    "--task",
    taskId,
    "--data",
    JSON.stringify(route),
  ]);
  assert.equal(routed.code, 0);
}

test("done records a host round with zero usage and unknown cost", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "evener-done-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.equal((await runJson<{ db_path: string }>(["init", "--home", home])).code, 0);
  const taskId = await createCliTask(home);
  await routeCliTask(home, taskId, "host");

  const done = await runJson<{
    task_id: string;
    round: number;
    target: string;
    status: string;
    wall_ms: number;
    cost_usd: number;
  }>(["done", "--home", home, "--task", taskId, "--cwd", home]);

  assert.equal(done.code, 0);
  assert.deepEqual(done.payload, {
    task_id: taskId,
    round: 1,
    target: "host",
    status: "success",
    wall_ms: 0,
    cost_usd: 0,
  });

  const status = await runJson<{ task: TaskRow; events: EvenerEvent[] }>([
    "status",
    "--home",
    home,
    "--task",
    taskId,
  ]);
  assert.equal(status.payload.task.state, "awaiting_acceptance");
  assert.equal(status.payload.task.total_cost_usd, 0);
  assert.equal(status.payload.task.total_wall_ms, 0);

  const started = status.payload.events.find((event) => event.type === "dispatch.started");
  assert.ok(started !== undefined && started.type === "dispatch.started");
  assert.equal(started.data.target, "host");
  assert.equal(started.data.target_version, null);
  assert.equal(started.data.model, null);
  assert.equal(started.data.context_bytes, 0);
  assert.equal(started.data.command, "host");

  const finished = status.payload.events.find((event) => event.type === "dispatch.finished");
  assert.ok(finished !== undefined && finished.type === "dispatch.finished");
  assert.deepEqual(finished.data.usage, { input: 0, cached_input: 0, output: 0, reasoning: 0 });
  assert.deepEqual(finished.data.usage_raw, {});
  assert.equal(finished.data.cost_usd, 0);
  assert.equal(
    (finished.data as typeof finished.data & { cost_unknown: boolean }).cost_unknown,
    true,
  );
  assert.equal(finished.data.tool_calls, null);
  assert.equal(finished.data.exit_code, null);
  assert.equal(finished.data.target_session_id, null);
  assert.equal(finished.data.output_path, null);
  assert.equal(finished.data.model_ms, null);
  assert.equal(finished.data.tool_ms, null);
  assert.equal(finished.data.pricing_period, "flat");

  const accepted = await runJson<{ verdict: string }>([
    "accept",
    "--home",
    home,
    "--task",
    taskId,
    "--verdict",
    "accepted",
  ]);
  assert.equal(accepted.code, 0);
  assert.equal(accepted.payload.verdict, "accepted");
});

test("done records a supplied cost and marks it known", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "evener-done-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.equal((await runJson<{ db_path: string }>(["init", "--home", home])).code, 0);
  const taskId = await createCliTask(home);
  await routeCliTask(home, taskId, "host");

  const done = await runJson<{ cost_usd: number; wall_ms: number; status: string }>([
    "done",
    "--home",
    home,
    "--task",
    taskId,
    "--wall-ms",
    "1234",
    "--cost-usd",
    "0.25",
    "--model",
    "claude-sonnet",
    "--status",
    "error",
    "--cwd",
    home,
  ]);
  assert.equal(done.code, 0);
  assert.equal(done.payload.cost_usd, 0.25);
  assert.equal(done.payload.wall_ms, 1234);
  assert.equal(done.payload.status, "error");

  const status = await runJson<{ events: EvenerEvent[] }>([
    "status",
    "--home",
    home,
    "--task",
    taskId,
  ]);
  const finished = status.payload.events.find((event) => event.type === "dispatch.finished");
  assert.ok(finished !== undefined && finished.type === "dispatch.finished");
  assert.equal(
    (finished.data as typeof finished.data & { cost_unknown: boolean }).cost_unknown,
    false,
  );
  assert.equal(status.payload.events.some((event) => event.type === "target.circuit"), false);
});

test("done rejects a codex-routed task with not_host_round", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "evener-done-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.equal((await runJson<{ db_path: string }>(["init", "--home", home])).code, 0);
  const taskId = await createCliTask(home);
  await routeCliTask(home, taskId, "codex");

  const done = await runJson<{ error: { code: string } }>([
    "done",
    "--home",
    home,
    "--task",
    taskId,
    "--cwd",
    home,
  ]);
  assert.equal(done.code, 1);
  assert.equal(done.payload.error.code, "not_host_round");
});
