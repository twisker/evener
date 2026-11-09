import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/cli.js";
import { openStore } from "../src/store.js";
import type { Store } from "../src/store.js";
import type {
  AcceptanceFinishedPayload,
  DispatchFinishedPayload,
  DispatchStartedPayload,
  EvenerEvent,
  EventType,
  PayloadByType,
  RouteDecidedPayload,
  TaskClosedPayload,
  TaskCreatedPayload,
} from "../src/types.js";
import { startUiServer } from "../src/ui/server.js";
import type { UiServer } from "../src/ui/server.js";
import { uuid } from "../src/util.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function cliIo(): CliIO {
  return {
    stdout: () => {
      // init output is not interesting here
    },
    stderr: () => {
      // no warnings expected
    },
    env: {},
    cwd: process.cwd(),
  };
}

async function tempHome(t: TestContext): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "evener-ui-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const code = await runCli(["init", "--home", home], cliIo());
  assert.equal(code, 0);
  return home;
}

function makeEvent<T extends EventType>(
  taskId: string,
  type: T,
  round: number,
  ts: string,
  data: PayloadByType[T],
  hostSessionId: string | null = "sess-1",
): EvenerEvent {
  return {
    event_id: uuid(),
    task_id: taskId,
    round,
    ts,
    type,
    host: "claude-code",
    host_session_id: hostSessionId,
    policy_version: "abcdef123456",
    schema_version: 1,
    data,
  } as unknown as EvenerEvent;
}

interface SeedIds {
  taskId: string;
}

function seedClosedTask(store: Store, home: string, baseMs: number): SeedIds {
  const taskId = uuid();
  const ts = (offset: number): string => new Date(baseMs + offset).toISOString();

  const created: TaskCreatedPayload & { arm: string | null } = {
    description_hash: "a".repeat(64),
    description_excerpt: "Panel smoke task",
    repo_fingerprint: null,
    pre_features: {
      description_chars: 20,
      files_mentioned: 2,
      repo_files: null,
      language: "ts",
      has_repro: true,
      cross_file: false,
      time_bucket: "lt15m",
    },
    analysis_label: "bugfix",
    labeler_model: "heuristic",
    labeler_cost_usd: 0,
    labeler_latency_ms: null,
    constraints: [],
    arm: null,
  };

  const routed: RouteDecidedPayload = {
    target: "codex",
    candidates: [{ target: "codex", score: 1 }],
    rationale: "test route",
    decided_by: "classifier",
    rule_id: null,
    classifier_model: null,
    classifier_latency_ms: 12,
    classifier_cost_usd: 0.003,
    arm: null,
    escalated_from: null,
  };

  const started: DispatchStartedPayload = {
    target: "codex",
    target_version: null,
    model: "gpt-test",
    context_bytes: 100,
    command: "fake-target --json",
  };

  const outputPath = `runs/${taskId}/1.out.md`;
  const finished: DispatchFinishedPayload = {
    status: "success",
    wall_ms: 1000,
    usage: { input: 100, cached_input: 20, output: 30, reasoning: 5 },
    usage_raw: {},
    cost_usd: 0.1,
    price_table_version: "price0000001",
    diff_stats: null,
    tool_calls: 2,
    exit_code: 0,
    target_session_id: null,
    output_path: outputPath,
    model_ms: 700,
    tool_ms: 300,
    pricing_period: "peak",
  };

  const acceptance: AcceptanceFinishedPayload = {
    verdict: "accepted",
    checks: [{ name: "tests", result: "pass" }],
    review_verdict: "pass",
    reject_reason: null,
    reviewer_cost_usd: 0.01,
    reviewer_wall_ms: 100,
    reviewer_usage: { input: 10, cached_input: 5, output: 3 },
    self_accepted: false,
  };

  const closed: TaskClosedPayload = {
    outcome: "accepted",
    total_rounds: 1,
    total_cost_usd: 0.113,
    total_wall_ms: 1100,
  };

  store.appendEvent(
    makeEvent(taskId, "task.created", 1, ts(0), created),
  );
  store.appendEvent(
    makeEvent(taskId, "route.decided", 1, ts(1), routed),
  );
  store.appendEvent(
    makeEvent(taskId, "dispatch.started", 1, ts(2), started),
  );
  store.appendEvent(
    makeEvent(taskId, "dispatch.finished", 1, ts(3), finished),
  );
  store.appendEvent(
    makeEvent(taskId, "acceptance.finished", 1, ts(4), acceptance),
  );
  store.appendEvent(
    makeEvent(taskId, "task.closed", 1, ts(5), closed),
  );

  mkdirSync(join(home, "runs", taskId), { recursive: true });
  writeFileSync(join(home, "runs", taskId, "1.out.md"), "0123456789", "utf8");

  return { taskId };
}

interface OverviewBody {
  home: string;
  policy_name: string;
  open_tasks: number;
  tasks_7d: number;
  accepted_7d: number;
  cost_7d_usd: number;
}

interface TaskSummaryBody {
  task_id: string;
  current_model: string | null;
  last_event_type: string;
  description_excerpt: string | null;
}

interface TaskDetailBody {
  task: { task_id: string; state: string };
  rounds: {
    round: number;
    target: string | null;
    dispatch_status: string | null;
    model_ms: number | null;
    tool_ms: number | null;
    pricing_period: string | null;
    output_path: string | null;
    stderr_path: string | null;
    checks: Record<string, string>;
  }[];
  events: { type: string }[];
}

interface ReportBody {
  header: { total_tasks: number; saved_to: string | null };
}

interface SessionsBody {
  sessions: {
    host_session_id: string;
    tasks: number;
    delegated_cost_usd: number;
    host_round_cost_usd: number;
    reviewer_cost_usd: number;
    overhead_cost_usd: number;
    reviewer_tokens: { input: number; cached_input: number; output: number } | null;
    targets: Record<string, number>;
  }[];
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), remaining);
    });
    const result = await Promise.race([reader.read(), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === "timeout") break;
    if (result.done) break;
    if (result.value !== undefined) {
      text += decoder.decode(result.value, { stream: true });
    }
    if (predicate(text)) return text;
  }

  throw new Error(`SSE stream did not match within ${timeoutMs} ms: ${text}`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test("ui server serves the read-only JSON routes", async (t) => {
  const home = await tempHome(t);
  const store = openStore(join(home, "evener.sqlite"));
  t.after(() => store.close());
  const { taskId } = seedClosedTask(store, home, Date.now() - 5000);

  const server: UiServer = await startUiServer({
    home,
    port: 0,
    openBrowser: false,
    io: cliIo(),
  });
  t.after(async () => {
    await server.close();
  });

  assert.equal(server.port > 0, true);
  assert.equal(server.url.startsWith("http://127.0.0.1:"), true);

  const root = await fetch(new URL("/", server.url));
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(root.headers.get("cache-control"), "no-store");
  const html = await root.text();
  assert.equal(html.includes("Evener"), true);

  const overviewResponse = await fetch(new URL("/api/overview", server.url));
  assert.equal(overviewResponse.status, 200);
  const overviewBody = (await overviewResponse.json()) as unknown as OverviewBody;
  assert.equal(overviewBody.home, home);
  assert.equal(overviewBody.open_tasks, 0);
  assert.equal(overviewBody.tasks_7d, 1);
  assert.equal(overviewBody.accepted_7d, 1);
  assert.equal(overviewBody.cost_7d_usd > 0, true);

  const tasksResponse = await fetch(new URL("/api/tasks?state=all", server.url));
  assert.equal(tasksResponse.status, 200);
  const tasksBody = (await tasksResponse.json()) as unknown as {
    tasks: TaskSummaryBody[];
  };
  assert.equal(tasksBody.tasks.length, 1);
  const summary = tasksBody.tasks[0];
  assert.ok(summary !== undefined);
  assert.equal(summary.task_id, taskId);
  assert.equal(summary.last_event_type, "task.closed");
  assert.equal(summary.description_excerpt, "Panel smoke task");

  const openResponse = await fetch(new URL("/api/tasks?state=open", server.url));
  const openBody = (await openResponse.json()) as unknown as {
    tasks: TaskSummaryBody[];
  };
  assert.equal(openBody.tasks.length, 0);

  const detailResponse = await fetch(new URL(`/api/task/${taskId}`, server.url));
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()) as unknown as TaskDetailBody;
  assert.equal(detail.task.task_id, taskId);
  assert.equal(detail.task.state, "closed");
  assert.equal(detail.rounds.length, 1);
  assert.equal(detail.events.length, 6);
  const round = detail.rounds[0];
  assert.ok(round !== undefined);
  assert.equal(round.target, "codex");
  assert.equal(round.dispatch_status, "success");
  assert.equal(round.model_ms, 700);
  assert.equal(round.tool_ms, 300);
  assert.equal(round.pricing_period, "peak");
  assert.equal(round.output_path, `runs/${taskId}/1.out.md`);
  assert.equal(round.stderr_path, `runs/${taskId}/1.stderr`);
  assert.deepEqual(round.checks, { tests: "pass" });

  const outputResponse = await fetch(
    new URL(`/api/task/${taskId}/output?round=1&tail=5`, server.url),
  );
  assert.equal(outputResponse.status, 200);
  assert.match(outputResponse.headers.get("content-type") ?? "", /text\/plain/);
  assert.equal(await outputResponse.text(), "56789");

  const stderrResponse = await fetch(
    new URL(`/api/task/${taskId}/output?round=1&stream=stderr`, server.url),
  );
  assert.equal(stderrResponse.status, 404);

  const reportResponse = await fetch(new URL("/api/report?since=7d", server.url));
  assert.equal(reportResponse.status, 200);
  const report = (await reportResponse.json()) as unknown as ReportBody;
  assert.equal(report.header.total_tasks, 1);
  assert.equal(report.header.saved_to, null);

  const sessionsResponse = await fetch(new URL("/api/sessions?since=7d", server.url));
  assert.equal(sessionsResponse.status, 200);
  const sessions = (await sessionsResponse.json()) as unknown as SessionsBody;
  const session = sessions.sessions[0];
  assert.ok(session !== undefined);
  assert.equal(session.host_session_id, "sess-1");
  assert.equal(session.tasks, 1);
  assert.ok(Math.abs(session.delegated_cost_usd - 0.1) < 1e-9);
  assert.ok(Math.abs(session.host_round_cost_usd) < 1e-9);
  assert.ok(Math.abs(session.reviewer_cost_usd - 0.01) < 1e-9);
  assert.ok(Math.abs(session.overhead_cost_usd - 0.003) < 1e-9);
  assert.deepEqual(session.reviewer_tokens, {
    input: 10,
    cached_input: 5,
    output: 3,
  });
  assert.deepEqual(session.targets, { codex: 1 });

  const headResponse = await fetch(new URL("/api/overview", server.url), {
    method: "HEAD",
  });
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), "");

  const missingResponse = await fetch(new URL("/api/nope", server.url));
  assert.equal(missingResponse.status, 404);
  const missingBody = (await missingResponse.json()) as unknown as {
    error: { code: string };
  };
  assert.equal(missingBody.error.code, "not_found");

  const traversalResponse = await fetch(
    new URL("/api/task/..%2F..%2Fetc", server.url),
  );
  assert.equal(traversalResponse.status, 404);

  const postResponse = await fetch(new URL("/api/overview", server.url), {
    method: "POST",
  });
  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get("allow"), "GET, HEAD");
  const postBody = (await postResponse.json()) as unknown as {
    error: { code: string };
  };
  assert.equal(postBody.error.code, "method_not_allowed");
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test("api stream sends one change event when the max seq grows and ends on close", async (t) => {
  const home = await tempHome(t);
  const store = openStore(join(home, "evener.sqlite"));
  t.after(() => store.close());

  const server = await startUiServer({
    home,
    port: 0,
    openBrowser: false,
    io: cliIo(),
  });
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(new URL("/api/stream", server.url));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body?.getReader();
  assert.ok(reader !== undefined && reader !== null);

  const taskId = uuid();
  const created: TaskCreatedPayload & { arm: string | null } = {
    description_hash: "b".repeat(64),
    description_excerpt: null,
    repo_fingerprint: null,
    pre_features: {
      description_chars: 5,
      files_mentioned: 0,
      repo_files: null,
      language: null,
      has_repro: false,
      cross_file: false,
      time_bucket: "unknown",
    },
    analysis_label: "unknown",
    labeler_model: "heuristic",
    constraints: [],
    arm: null,
  };
  store.appendEvent(
    makeEvent(taskId, "task.created", 1, new Date().toISOString(), created),
  );

  const text = await readUntil(reader, (chunk) => chunk.includes("event: change"), 3000);
  assert.match(text, /event: change\ndata: \{"seq":\d+\}\n\n/);

  await server.close();

  let ended = false;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !ended) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), 500);
    });
    const result = await Promise.race([reader.read(), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === "timeout") break;
    ended = result.done;
  }
  assert.equal(ended, true);
});
