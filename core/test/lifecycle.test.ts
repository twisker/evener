import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/cli.js";
import { defaultPolicy } from "../src/config.js";
import {
  accept,
  applyRedispatch,
  close,
  computeTotals,
  decideNext,
  feedback,
  LifecycleError,
  nextInChain,
  openCircuits,
  override,
  parseChecks,
  sweep,
} from "../src/lifecycle.js";
import { openStore } from "../src/store.js";
import type { Store } from "../src/store.js";
import { OUTCOMES, REJECT_REASONS, REVIEW_VERDICTS, VERDICTS } from "../src/types.js";
import type {
  AcceptanceCheck,
  AcceptanceFinishedPayload,
  CheckName,
  CheckResult,
  ContextDelta,
  DispatchFinishedPayload,
  EvenerEvent,
  EventType,
  Label,
  Outcome,
  PayloadByType,
  Policy,
  RejectReason,
  RouteDecidedPayload,
  TaskRedispatchPayload,
  TaskRow,
  Verdict,
} from "../src/types.js";
import { uuid } from "../src/util.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2026-11-09T00:00:00.000Z";
const NOW = "2026-11-09T01:00:00.000Z";

interface Fixture {
  store: Store;
  dir: string;
  dbPath: string;
}

function tempStore(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "evener-lifecycle-"));
  const dbPath = join(dir, "evener.sqlite");
  const store = openStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir, dbPath };
}

function mustTask(store: Store, taskId: string): TaskRow {
  const task = store.getTask(taskId);
  assert.ok(task !== null, `task ${taskId} missing`);
  return task;
}

function makeEvent<K extends EventType>(
  task: TaskRow,
  type: K,
  round: number,
  data: PayloadByType[K],
  ts = T0,
): EvenerEvent {
  const event = {
    event_id: uuid(),
    task_id: task.task_id,
    round,
    ts,
    type,
    host: task.host,
    host_session_id: task.host_session_id,
    policy_version: task.policy_version,
    schema_version: 1,
    data,
  };
  return event as EvenerEvent;
}

function newTask(
  store: Store,
  opts: {
    session?: string | null;
    label?: Label;
    taskId?: string;
    ts?: string;
    labelerCost?: number | null;
    labelerLatency?: number | null;
  } = {},
): TaskRow {
  const taskId = opts.taskId ?? uuid();
  const event = {
    event_id: uuid(),
    task_id: taskId,
    round: 1,
    ts: opts.ts ?? T0,
    type: "task.created",
    host: "claude-code",
    host_session_id: opts.session === undefined ? "session-1" : opts.session,
    policy_version: "policyversion",
    schema_version: 1,
    data: {
      description_hash: "hash",
      description_excerpt: null,
      repo_fingerprint: null,
      pre_features: {
        description_chars: 10,
        files_mentioned: 1,
        repo_files: null,
        language: null,
        has_repro: false,
        cross_file: false,
        time_bucket: "lt15m",
      },
      analysis_label: opts.label ?? "bugfix",
      labeler_model: "heuristic",
      labeler_cost_usd: opts.labelerCost ?? null,
      labeler_latency_ms: opts.labelerLatency ?? null,
      constraints: [],
    },
  } as unknown as EvenerEvent;
  store.appendEvent(event);
  return mustTask(store, taskId);
}

function route(
  store: Store,
  task: TaskRow,
  target: string,
  round: number,
  opts: {
    ruleId?: string | null;
    decidedBy?: "rule" | "classifier" | "fallback" | "override";
    classifierCost?: number | null;
    escalatedFrom?: string | null;
  } = {},
): void {
  const data: RouteDecidedPayload = {
    target,
    candidates: [{ target, score: 1 }],
    rationale: "fixture",
    decided_by: opts.decidedBy ?? (opts.ruleId === undefined ? "fallback" : "rule"),
    rule_id: opts.ruleId ?? null,
    classifier_model: null,
    classifier_latency_ms: null,
    classifier_cost_usd: opts.classifierCost ?? null,
    arm: task.arm,
    escalated_from: opts.escalatedFrom ?? null,
  };
  store.appendEvent(makeEvent(task, "route.decided", round, data));
}

function dispatchFinished(
  store: Store,
  task: TaskRow,
  round: number,
  opts: { cost?: number; wall?: number; status?: "success" | "error" | "timeout" } = {},
): void {
  const data: DispatchFinishedPayload = {
    status: opts.status ?? "success",
    wall_ms: opts.wall ?? 10,
    usage: { input: 10, cached_input: 0, output: 5, reasoning: 0 },
    usage_raw: {},
    cost_usd: opts.cost ?? 0.1,
    price_table_version: "pricingversion",
    diff_stats: null,
    tool_calls: null,
    exit_code: 0,
    target_session_id: null,
    output_path: null,
  };
  store.appendEvent(makeEvent(task, "dispatch.finished", round, data));
}

function acceptance(
  store: Store,
  task: TaskRow,
  round: number,
  verdict: Verdict,
  reason: RejectReason | null,
  opts: { reviewerCost?: number; reviewerWall?: number; review?: "pass" | "fail" | "skipped" } = {},
): void {
  const data: AcceptanceFinishedPayload = {
    verdict,
    checks: [],
    review_verdict: opts.review ?? "skipped",
    reject_reason: verdict === "rejected" ? reason : null,
    reviewer_cost_usd: opts.reviewerCost ?? 0,
    reviewer_wall_ms: opts.reviewerWall ?? 0,
  };
  store.appendEvent(makeEvent(task, "acceptance.finished", round, data));
}

function rejectedRound(
  store: Store,
  task: TaskRow,
  target: string,
  round: number,
  reason: RejectReason,
  opts: { cost?: number; wall?: number; reviewerCost?: number } = {},
): void {
  route(store, task, target, round);
  dispatchFinished(store, task, round, opts);
  acceptance(store, task, round, "rejected", reason, opts);
}

function acceptedRound(
  store: Store,
  task: TaskRow,
  target: string,
  round: number,
  opts: { cost?: number; wall?: number; reviewerCost?: number } = {},
): void {
  route(store, task, target, round);
  dispatchFinished(store, task, round, opts);
  acceptance(store, task, round, "accepted", null, opts);
}

function redispatch(
  store: Store,
  task: TaskRow,
  round: number,
  nextTarget: string,
  kind: "retry" | "escalate",
  reason = "style",
): void {
  const data: TaskRedispatchPayload = {
    reason,
    context_delta: "unchanged",
    next_target: nextTarget,
    kind,
  };
  store.appendEvent(makeEvent(task, "task.redispatch", round, data));
}

function isLifecycleError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof LifecycleError && err.code === code;
}

// ---------------------------------------------------------------------------
// CLI fixture
// ---------------------------------------------------------------------------

interface CliResult<T> {
  code: number;
  payload: T;
}

async function run<T>(argv: string[]): Promise<CliResult<T>> {
  const out: string[] = [];
  const io: CliIO = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: () => undefined,
    env: {},
    cwd: process.cwd(),
  };
  const code = await runCli(argv, io);
  const text = out.join("");
  assert.ok(text.length > 0, `no output for ${argv.join(" ")}`);
  return { code, payload: JSON.parse(text) as T };
}

async function initHome(home: string): Promise<void> {
  const result = await run<{ db_path: string }>(["init", "--home", home]);
  assert.equal(result.code, 0);
}

async function withStore<T>(dbPath: string, fn: (store: Store) => T): Promise<T> {
  const store = openStore(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------

test("accept requires a reason when rejected and defaults review/costs", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);
  route(store, task, "dsh", 1);
  dispatchFinished(store, task, 1);
  const awaiting = mustTask(store, task.task_id);

  assert.throws(
    () => accept(store, policy, awaiting, NOW, { verdict: "rejected" }),
    isLifecycleError("reason_required"),
  );

  const rejected = accept(store, policy, awaiting, NOW, {
    verdict: "rejected",
    reason: "style",
    checks: parseChecks(["tests=pass", "lint=fail"]),
  });
  store.appendEvent(rejected.events[0] as EvenerEvent);

  assert.equal(rejected.output.verdict, "rejected");
  const event = store.getEvents(task.task_id).at(-1);
  assert.equal(event?.type, "acceptance.finished");
  assert.deepEqual(event?.data, {
    verdict: "rejected",
    checks: [
      { name: "tests", result: "pass" },
      { name: "lint", result: "fail" },
    ],
    review_verdict: "skipped",
    reject_reason: "style",
    reviewer_cost_usd: 0,
    reviewer_wall_ms: 0,
  });
});

test("accept refuses a task that is not awaiting acceptance", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);
  assert.throws(
    () => accept(store, policy, task, NOW, { verdict: "accepted" }),
    isLifecycleError("invalid_state"),
  );
});

test("parseChecks rejects unknown names and results", () => {
  assert.deepEqual(parseChecks(["build=pass"]), [{ name: "build", result: "pass" }]);
  assert.throws(() => parseChecks(["unknown=pass"]), isLifecycleError("invalid_arguments"));
  assert.throws(() => parseChecks(["tests=bad"]), isLifecycleError("invalid_arguments"));
  assert.throws(() => parseChecks(["tests"]), isLifecycleError("invalid_arguments"));
});

// ---------------------------------------------------------------------------
// next / decideNext
// ---------------------------------------------------------------------------

test("an accepted acceptance leads to close", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);
  acceptedRound(store, task, "dsh", 1, { cost: 0.2, reviewerCost: 0.01 });

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.deepEqual(decision, { action: "close", outcome: "accepted" });
});

test("a style rejection retries the same target once", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);
  rejectedRound(store, task, "dsh", 1, "style");

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.equal(decision.action, "redispatch");
  if (decision.action !== "redispatch") return;
  assert.equal(decision.kind, "retry");
  assert.equal(decision.next_target, "dsh");
  assert.equal(decision.round, 2);
});

test("a misunderstood rejection escalates to the next chain target", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);
  rejectedRound(store, task, "dsh", 1, "misunderstood");

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.equal(decision.action, "redispatch");
  if (decision.action !== "redispatch") return;
  assert.equal(decision.kind, "escalate");
  assert.equal(decision.next_target, "codex");
  assert.equal(decision.round, 2);
});

test("an exhausted retry escalates instead of retrying again", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);

  rejectedRound(store, task, "dsh", 1, "tests_failed");
  redispatch(store, task, 2, "dsh", "retry", "tests_failed");
  rejectedRound(store, mustTask(store, task.task_id), "dsh", 2, "other");

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.equal(decision.action, "redispatch");
  if (decision.action !== "redispatch") return;
  assert.equal(decision.kind, "escalate");
  assert.equal(decision.next_target, "codex");
});

test("the same reason twice forces escalation even for never_escalate_on", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);

  rejectedRound(store, task, "dsh", 1, "style");
  redispatch(store, task, 2, "dsh", "retry", "style");
  rejectedRound(store, mustTask(store, task.task_id), "dsh", 2, "style");

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.equal(decision.action, "redispatch");
  if (decision.action !== "redispatch") return;
  assert.equal(decision.kind, "escalate");
  assert.equal(decision.next_target, "codex");
  assert.match(decision.why, /force escalate/);
});

test("the same reason on a previous target does not force escalation of the current target", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  // Isolate the repeated-same-reason guard: `incomplete` is not an immediate
  // escalation reason for this test.
  policy.escalation.escalate_on_reasons = policy.escalation.escalate_on_reasons.filter(
    (candidate) => candidate !== "incomplete",
  );
  const task = newTask(store);

  rejectedRound(store, task, "dsh", 1, "incomplete");
  // Round 2 was escalated from dsh to codex; the counter must not combine
  // dsh's rejection with codex's.
  redispatch(store, task, 2, "codex", "escalate", "incomplete");
  route(store, mustTask(store, task.task_id), "codex", 2);
  dispatchFinished(store, mustTask(store, task.task_id), 2);
  acceptance(store, mustTask(store, task.task_id), 2, "rejected", "incomplete");

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.equal(decision.action, "redispatch");
  if (decision.action !== "redispatch") return;
  assert.equal(decision.kind, "retry");
  assert.equal(decision.next_target, "codex");
  assert.equal(decision.round, 3);
  assert.doesNotMatch(decision.why, /force escalate/);
});

test("max_rounds_per_task hands the task to a human", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  policy.limits.max_rounds_per_task = 2;
  const task = newTask(store);

  rejectedRound(store, task, "dsh", 1, "style");
  redispatch(store, task, 2, "dsh", "retry");
  rejectedRound(store, mustTask(store, task.task_id), "dsh", 2, "style");

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.equal(decision.action, "hand_to_human");
  if (decision.action !== "hand_to_human") return;
  assert.match(decision.why, /max_rounds_per_task/);
});

test("the cost budget hands the task to a human", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  policy.limits.max_cost_per_task_usd = 1;
  const task = newTask(store);

  rejectedRound(store, task, "dsh", 1, "style", { cost: 1 });

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.equal(decision.action, "hand_to_human");
  if (decision.action !== "hand_to_human") return;
  assert.match(decision.why, /max_cost_per_task_usd/);
});

test("host as the current target hands the task to a human", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);

  rejectedRound(store, task, "host", 1, "style");

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.deepEqual(decision, { action: "hand_to_human", why: "current target is host" });
});

test("an exhausted escalation chain hands the task to a human", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  policy.escalation.chain = ["dsh"];
  const task = newTask(store);

  rejectedRound(store, task, "dsh", 1, "misunderstood");

  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.deepEqual(decision, { action: "hand_to_human", why: "escalation chain exhausted" });
});

test("open circuits remove a target from retry and escalation", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);

  rejectedRound(store, task, "dsh", 1, "style");
  store.appendEvent(
    makeEvent(task, "target.circuit", 1, {
      target: "dsh",
      state: "open",
      until: "2026-11-10T00:00:00.000Z",
    }),
  );
  store.appendEvent(
    makeEvent(task, "target.circuit", 1, {
      target: "codex",
      state: "open",
      until: "2026-11-10T00:00:00.000Z",
    }),
  );

  assert.deepEqual(openCircuits(store, NOW), new Set(["dsh", "codex"]));
  const decision = decideNext(store, policy, mustTask(store, task.task_id), NOW);
  assert.equal(decision.action, "redispatch");
  if (decision.action !== "redispatch") return;
  assert.equal(decision.kind, "escalate");
  assert.equal(decision.next_target, "host");
});

test("nextInChain skips disabled targets and handles unknown positions", () => {
  const chain = ["dsh", "codex", "host"];
  assert.equal(nextInChain(chain, "dsh", new Set(["dsh", "host"])), "host");
  assert.equal(nextInChain(chain, "codex", new Set(["dsh"])), null);
  assert.equal(nextInChain(chain, "not-in-chain", new Set(["codex", "host"])), "codex");
  assert.equal(nextInChain(chain, "host", new Set(chain)), null);
});

// ---------------------------------------------------------------------------
// applyRedispatch / CLI next
// ---------------------------------------------------------------------------

test("applyRedispatch emits redispatch and route events in the new round", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);
  rejectedRound(store, task, "dsh", 1, "misunderstood");
  const current = mustTask(store, task.task_id);

  const decision = decideNext(store, policy, current, NOW);
  assert.equal(decision.action, "redispatch");
  if (decision.action !== "redispatch") return;

  const applied = applyRedispatch(store, policy, current, NOW, decision);
  assert.equal(applied.events.length, 2);
  const [redispatchEvent, routeEvent] = applied.events;
  assert.equal(redispatchEvent?.type, "task.redispatch");
  assert.equal(redispatchEvent?.round, 2);
  assert.equal(routeEvent?.type, "route.decided");
  assert.equal(routeEvent?.round, 2);
  if (routeEvent?.type === "route.decided") {
    assert.equal(routeEvent.data.decided_by, "rule");
    assert.equal(routeEvent.data.rule_id, "escalation");
    assert.equal(routeEvent.data.escalated_from, "dsh");
    assert.deepEqual(routeEvent.data.candidates, [{ target: "codex", score: 1 }]);
  }
});

test("next appends redispatch events, updates the task, and dry-run only prints", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "evener-lifecycle-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await initHome(home);

  const dbPath = join(home, "evener.sqlite");
  const taskId = await withStore(dbPath, (store) => {
    const task = newTask(store, { session: "session-a" });
    rejectedRound(store, task, "dsh", 1, "style");
    return task.task_id;
  });

  const dry = await run<{ action: string; next_target: string; round: number }>([
    "next",
    "--home",
    home,
    "--task",
    taskId,
    "--dry-run",
  ]);
  assert.equal(dry.code, 0);
  assert.equal(dry.payload.action, "redispatch");
  assert.equal(dry.payload.next_target, "dsh");
  assert.equal(dry.payload.round, 2);

  const afterDry = await run<{ task: TaskRow; events: EvenerEvent[] }>([
    "status",
    "--home",
    home,
    "--task",
    taskId,
  ]);
  assert.equal(afterDry.payload.task.current_round, 1);
  assert.equal(
    afterDry.payload.events.filter((event) => event.type === "task.redispatch").length,
    0,
  );

  const real = await run<{
    task_id: string;
    action: string;
    kind: string;
    next_target: string;
    round: number;
  }>(["next", "--home", home, "--task", taskId]);
  assert.equal(real.code, 0);
  assert.equal(real.payload.action, "redispatch");
  assert.equal(real.payload.kind, "retry");
  assert.equal(real.payload.next_target, "dsh");
  assert.equal(real.payload.round, 2);

  const after = await run<{ task: TaskRow; events: EvenerEvent[] }>([
    "status",
    "--home",
    home,
    "--task",
    taskId,
  ]);
  assert.equal(after.payload.task.current_round, 2);
  assert.equal(after.payload.task.current_target, "dsh");
  assert.equal(after.payload.task.state, "routed");
  const redispatches = after.payload.events.filter((event) => event.type === "task.redispatch");
  assert.equal(redispatches.length, 1);
  assert.equal(redispatches[0]?.round, 2);
  const routes = after.payload.events.filter(
    (event) => event.type === "route.decided" && event.round === 2,
  );
  assert.equal(routes.length, 1);
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

test("close and the budget check include the labeler cost", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store, { labelerCost: 0.0001, labelerLatency: 12 });

  route(store, task, "dsh", 1, { classifierCost: 0.01 });
  dispatchFinished(store, mustTask(store, task.task_id), 1, { cost: 0.1, wall: 10 });
  acceptance(store, mustTask(store, task.task_id), 1, "accepted", null, {
    reviewerCost: 0.02,
    reviewerWall: 5,
  });

  const totals = computeTotals(store.getEvents(task.task_id));
  assert.ok(Math.abs(totals.total_cost_usd - 0.1301) < 1e-12);

  const result = close(store, policy, mustTask(store, task.task_id), NOW, "accepted");
  assert.ok(Math.abs(result.output.total_cost_usd - 0.1301) < 1e-12);
  store.appendEvent(result.events[0] as EvenerEvent);
  assert.ok(Math.abs(mustTask(store, task.task_id).total_cost_usd - 0.1301) < 1e-12);

  const budgetTask = newTask(store, { labelerCost: 2 });
  route(store, budgetTask, "dsh", 1, { classifierCost: 0 });
  dispatchFinished(store, mustTask(store, budgetTask.task_id), 1, { cost: 0.1 });
  acceptance(store, mustTask(store, budgetTask.task_id), 1, "rejected", "tests_failed");
  const next = decideNext(store, policy, mustTask(store, budgetTask.task_id), NOW);
  assert.equal(next.action, "hand_to_human");
  assert.match(next.why ?? "", /max_cost_per_task_usd/);
});

test("close totals are the sum of dispatch, reviewer and classifier costs", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);

  route(store, task, "dsh", 1, { classifierCost: 0.05 });
  dispatchFinished(store, task, 1, { cost: 0.5, wall: 100 });
  acceptance(store, task, 1, "rejected", "tests_failed", {
    reviewerCost: 0.1,
    reviewerWall: 50,
  });
  redispatch(store, task, 2, "codex", "escalate", "tests_failed");
  route(store, mustTask(store, task.task_id), "codex", 2, { classifierCost: 0.02 });
  dispatchFinished(store, mustTask(store, task.task_id), 2, { cost: 0.25, wall: 70 });
  acceptance(store, mustTask(store, task.task_id), 2, "accepted", null, {
    reviewerCost: 0.03,
    reviewerWall: 20,
  });

  const events = store.getEvents(task.task_id);
  const totals = computeTotals(events);
  assert.equal(totals.total_rounds, 2);
  assert.ok(Math.abs(totals.total_cost_usd - 0.95) < 1e-12);
  assert.equal(totals.total_wall_ms, 240);

  const current = mustTask(store, task.task_id);
  const result = close(store, policy, current, NOW, "accepted");
  assert.equal(result.output.task_id, task.task_id);
  assert.equal(result.output.outcome, "accepted");
  assert.equal(result.output.total_rounds, 2);
  assert.ok(Math.abs(result.output.total_cost_usd - 0.95) < 1e-12);
  assert.equal(result.output.total_wall_ms, 240);
  store.appendEvent(result.events[0] as EvenerEvent);

  const closed = mustTask(store, task.task_id);
  assert.equal(closed.state, "closed");
  assert.equal(closed.outcome, "accepted");
  assert.equal(closed.closed_ts, NOW);

  assert.throws(
    () => close(store, policy, closed, NOW, "accepted"),
    isLifecycleError("already_closed"),
  );
});

test("close CLI prints the totals and refuses a second close", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "evener-lifecycle-close-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await initHome(home);

  const taskId = await withStore(join(home, "evener.sqlite"), (store) => {
    const task = newTask(store);
    acceptedRound(store, task, "dsh", 1, { cost: 0.4, wall: 30, reviewerCost: 0.02 });
    return task.task_id;
  });

  const first = await run<{
    task_id: string;
    outcome: string;
    total_rounds: number;
    total_cost_usd: number;
    total_wall_ms: number;
  }>(["close", "--home", home, "--task", taskId, "--outcome", "accepted"]);
  assert.equal(first.code, 0);
  assert.equal(first.payload.task_id, taskId);
  assert.equal(first.payload.outcome, "accepted");
  assert.equal(first.payload.total_rounds, 1);
  assert.ok(Math.abs(first.payload.total_cost_usd - 0.42) < 1e-12);
  assert.equal(first.payload.total_wall_ms, 30);

  const second = await run<{ error: { code: string } }>([
    "close",
    "--home",
    home,
    "--task",
    taskId,
    "--outcome",
    "accepted",
  ]);
  assert.equal(second.code, 1);
  assert.equal(second.payload.error.code, "already_closed");
});

// ---------------------------------------------------------------------------
// feedback / override
// ---------------------------------------------------------------------------

test("feedback records the rating and comment", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);

  const result = feedback(store, policy, task, NOW, { rating: "down", comment: "too slow" });
  store.appendEvent(result.events[0] as EvenerEvent);
  assert.deepEqual(result.output, { task_id: task.task_id });
  const saved = mustTask(store, task.task_id);
  assert.equal(saved.rating, "down");
  const event = store.getEvents(task.task_id).at(-1);
  assert.equal(event?.type, "user.feedback");
  assert.deepEqual(event?.data, { rating: "down", comment: "too slow" });
});

test("override is refused for a locked rule unless the target is host", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);
  route(store, task, "host", 1, { ruleId: "private", decidedBy: "rule" });
  const routed = mustTask(store, task.task_id);

  assert.throws(
    () => override(store, policy, routed, NOW, { to: "codex" }),
    isLifecycleError("locked"),
  );

  const allowed = override(store, policy, routed, NOW, { to: "host" });
  assert.deepEqual(allowed.output, { task_id: task.task_id, from: "host", to: "host" });
  store.appendEvent(allowed.events[0] as EvenerEvent);
  assert.equal(mustTask(store, task.task_id).overridden, 1);
});

test("override succeeds when the round was not decided by a locked rule", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();
  const task = newTask(store);
  route(store, task, "dsh", 1, { decidedBy: "fallback" });
  const routed = mustTask(store, task.task_id);

  const allowed = override(store, policy, routed, NOW, { to: "codex" });
  store.appendEvent(allowed.events[0] as EvenerEvent);
  assert.equal(mustTask(store, task.task_id).current_target, "codex");
});

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

test("sweep closes only open tasks of the given host session", (t) => {
  const { store } = tempStore(t);
  const policy = defaultPolicy();

  const first = newTask(store, { session: "session-a", ts: "2026-11-09T00:00:01.000Z" });
  const second = newTask(store, { session: "session-a", ts: "2026-11-09T00:00:02.000Z" });
  const other = newTask(store, { session: "session-b", ts: "2026-11-09T00:00:03.000Z" });
  const alreadyClosed = newTask(store, {
    session: "session-a",
    ts: "2026-11-09T00:00:04.000Z",
  });
  const closedResult = close(store, policy, alreadyClosed, NOW, "abandoned");
  store.appendEvent(closedResult.events[0] as EvenerEvent);

  const swept = sweep(store, policy, "session-a", NOW);
  assert.deepEqual(new Set(swept.output.closed), new Set([first.task_id, second.task_id]));
  assert.equal(swept.events.length, 2);
  for (const event of swept.events) store.appendEvent(event);

  assert.equal(mustTask(store, first.task_id).state, "closed");
  assert.equal(mustTask(store, first.task_id).outcome, "abandoned");
  assert.equal(mustTask(store, second.task_id).state, "closed");
  assert.equal(mustTask(store, other.task_id).state, "created");
  assert.equal(mustTask(store, alreadyClosed.task_id).state, "closed");

  const closedEvents = store
    .getEvents(alreadyClosed.task_id)
    .filter((event) => event.type === "task.closed");
  assert.equal(closedEvents.length, 1);
});

test("sweep CLI returns the closed ids", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "evener-lifecycle-sweep-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await initHome(home);

  const ids = await withStore(join(home, "evener.sqlite"), (store) => {
    const one = newTask(store, { session: "sweep-session" });
    const two = newTask(store, { session: "sweep-session" });
    newTask(store, { session: "kept-session" });
    return [one.task_id, two.task_id];
  });

  const result = await run<{ closed: string[] }>([
    "sweep",
    "--home",
    home,
    "--host-session",
    "sweep-session",
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(new Set(result.payload.closed), new Set(ids));

  const status = await run<{ tasks: TaskRow[] }>(["tasks", "--home", home]);
  const byId = new Map(status.payload.tasks.map((task) => [task.task_id, task]));
  for (const id of ids) assert.equal(byId.get(id)?.state, "closed");
});

// ---------------------------------------------------------------------------
// CLI accept output / defaults
// ---------------------------------------------------------------------------

test("accept CLI requires a reason for rejection and records check defaults", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "evener-lifecycle-accept-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await initHome(home);

  const taskId = await withStore(join(home, "evener.sqlite"), (store) => {
    const task = newTask(store);
    route(store, task, "dsh", 1);
    dispatchFinished(store, task, 1);
    return task.task_id;
  });

  const missingReason = await run<{ error: { code: string } }>([
    "accept",
    "--home",
    home,
    "--task",
    taskId,
    "--verdict",
    "rejected",
  ]);
  assert.equal(missingReason.code, 1);
  assert.equal(missingReason.payload.error.code, "reason_required");

  const accepted = await run<{ task_id: string; round: number; verdict: string }>([
    "accept",
    "--home",
    home,
    "--task",
    taskId,
    "--verdict",
    "accepted",
    "--check",
    "tests=pass",
    "--check",
    "lint=skipped",
  ]);
  assert.equal(accepted.code, 0);
  assert.deepEqual(accepted.payload, { task_id: taskId, round: 1, verdict: "accepted" });

  const status = await run<{ task: TaskRow; events: EvenerEvent[] }>([
    "status",
    "--home",
    home,
    "--task",
    taskId,
  ]);
  assert.equal(status.payload.task.first_pass, 1);
  assert.equal(status.payload.task.total_cost_usd, 0.1);
  const event = status.payload.events.at(-1);
  assert.equal(event?.type, "acceptance.finished");
  if (event?.type === "acceptance.finished") {
    assert.deepEqual(event.data.checks, [
      { name: "tests", result: "pass" },
      { name: "lint", result: "skipped" },
    ]);
    assert.equal(event.data.review_verdict, "skipped");
    assert.equal(event.data.reviewer_cost_usd, 0);
    assert.equal(event.data.reviewer_wall_ms, 0);
  }
});

// Keep the imported closed enums exercised so accidental drift is caught here.
test("frozen lifecycle enums stay in sync with the fixtures", () => {
  assert.deepEqual(new Set(VERDICTS), new Set(["accepted", "rejected"]));
  assert.deepEqual(new Set(OUTCOMES), new Set(["accepted", "handed_to_human", "abandoned"]));
  assert.deepEqual(
    new Set(REVIEW_VERDICTS),
    new Set(["pass", "fail", "skipped"]),
  );
  assert.ok(REJECT_REASONS.includes("style"));
  const checks: AcceptanceCheck[] = [
    { name: "tests" as CheckName, result: "pass" as CheckResult },
  ];
  assert.equal(checks.length, 1);
  const delta: ContextDelta = "unchanged";
  const outcome: Outcome = "abandoned";
  assert.equal(delta, "unchanged");
  assert.equal(outcome, "abandoned");
});
