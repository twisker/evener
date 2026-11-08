import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { applyProjection, openStore, StoreError } from "../src/store.js";
import type { Store } from "../src/store.js";
import type {
  AcceptanceFinishedPayload,
  DispatchFinishedPayload,
  DispatchStartedPayload,
  EvenerEvent,
  EventType,
  Label,
  PayloadByType,
  RouteDecidedPayload,
  TaskClosedPayload,
  TaskCreatedPayload,
  TaskRedispatchPayload,
} from "../src/types.js";
import { nowIso, uuid } from "../src/util.js";

const POLICY_VERSION = "abcdef123456";

interface StoreHarness {
  store: Store;
  dir: string;
}

function tempStore(t: TestContext): StoreHarness {
  const dir = mkdtempSync(join(tmpdir(), "evener-store-"));
  const store = openStore(join(dir, "evener.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

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
    ts: nowIso(),
    type,
    host: "claude-code",
    host_session_id: "session-1",
    policy_version: POLICY_VERSION,
    schema_version: 1,
    data,
  } as unknown as EvenerEvent;
}

function created(
  taskId: string,
  label: Label = "bugfix",
  arm: string | null = null,
): EvenerEvent {
  const data: TaskCreatedPayload & { arm: string | null } = {
    description_hash: "a".repeat(64),
    description_excerpt: null,
    repo_fingerprint: null,
    pre_features: { description_chars: 20, files_mentioned: 2, repo_files: null },
    analysis_label: label,
    labeler_model: "heuristic",
    constraints: [],
    arm,
  };
  return makeEvent(taskId, "task.created", 1, data);
}

function routed(
  taskId: string,
  round: number,
  target: string,
  classifierCost: number | null,
  arm: string | null = null,
): EvenerEvent {
  const data: RouteDecidedPayload = {
    target,
    candidates: [{ target, score: 1 }],
    rationale: "test route",
    decided_by: "classifier",
    rule_id: null,
    classifier_model: null,
    classifier_latency_ms: null,
    classifier_cost_usd: classifierCost,
    arm,
    escalated_from: null,
  };
  return makeEvent(taskId, "route.decided", round, data);
}

function started(taskId: string, round: number, target: string): EvenerEvent {
  const data: DispatchStartedPayload = {
    target,
    target_version: null,
    model: null,
    context_bytes: 100,
    command: "fake-target --json",
  };
  return makeEvent(taskId, "dispatch.started", round, data);
}

function finished(taskId: string, round: number, cost: number, wall: number): EvenerEvent {
  const data: DispatchFinishedPayload = {
    status: "success",
    wall_ms: wall,
    usage: { input: 10, cached_input: 0, output: 5, reasoning: 1 },
    usage_raw: {},
    cost_usd: cost,
    price_table_version: "price0000001",
    diff_stats: null,
    tool_calls: 1,
    exit_code: 0,
    target_session_id: null,
    output_path: null,
  };
  return makeEvent(taskId, "dispatch.finished", round, data);
}

function acceptance(
  taskId: string,
  round: number,
  verdict: "accepted" | "rejected",
  reviewerCost: number,
  reviewerWall: number,
): EvenerEvent {
  const data: AcceptanceFinishedPayload = {
    verdict,
    checks: [{ name: "tests", result: verdict === "accepted" ? "pass" : "fail" }],
    review_verdict: verdict === "accepted" ? "pass" : "fail",
    reject_reason: verdict === "accepted" ? null : "tests_failed",
    reviewer_cost_usd: reviewerCost,
    reviewer_wall_ms: reviewerWall,
  };
  return makeEvent(taskId, "acceptance.finished", round, data);
}

function redispatch(taskId: string, round: number, nextTarget: string): EvenerEvent {
  const data: TaskRedispatchPayload = {
    reason: "tests_failed",
    context_delta: "unchanged",
    next_target: nextTarget,
    kind: "escalate",
  };
  return makeEvent(taskId, "task.redispatch", round, data);
}

function closed(taskId: string): EvenerEvent {
  const data: TaskClosedPayload = {
    outcome: "accepted",
    total_rounds: 1,
    total_cost_usd: 0,
    total_wall_ms: 0,
  };
  return makeEvent(taskId, "task.closed", 1, data);
}

test("happy path projection accumulates cost, wall time and first pass", (t) => {
  const { store } = tempStore(t);
  const taskId = uuid();

  store.appendEvent(created(taskId));
  store.appendEvent(routed(taskId, 1, "codex", 0.01));
  store.appendEvent(started(taskId, 1, "codex"));
  store.appendEvent(finished(taskId, 1, 0.25, 1000));
  store.appendEvent(acceptance(taskId, 1, "accepted", 0.05, 200));
  store.appendEvent(closed(taskId));

  const task = store.getTask(taskId);
  assert.ok(task !== null);
  assert.equal(task.state, "closed");
  assert.equal(task.outcome, "accepted");
  assert.equal(task.first_pass, 1);
  assert.equal(task.current_round, 1);
  assert.equal(task.current_target, "codex");
  assert.equal(task.overridden, 0);
  assert.equal(task.closed_ts !== null, true);
  assert.ok(Math.abs(task.total_cost_usd - 0.31) < 1e-9, `cost was ${task.total_cost_usd}`);
  assert.equal(task.total_wall_ms, 1200);
  assert.equal(store.getEvents(taskId).length, 6);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listTasks({ open: true }).length, 0);
  assert.equal(store.listEvents({ types: ["dispatch.finished", "acceptance.finished"] }).length, 2);
});

test("rejected round 1 then redispatch yields round 2 and first_pass 0", (t) => {
  const { store } = tempStore(t);
  const taskId = uuid();

  store.appendEvent(created(taskId, "test"));
  store.appendEvent(routed(taskId, 1, "dsh", 0.01));
  store.appendEvent(started(taskId, 1, "dsh"));
  store.appendEvent(finished(taskId, 1, 0.02, 50));
  store.appendEvent(acceptance(taskId, 1, "rejected", 0.005, 10));
  store.appendEvent(redispatch(taskId, 2, "codex"));

  const task = store.getTask(taskId);
  assert.ok(task !== null);
  assert.equal(task.current_round, 2);
  assert.equal(task.current_target, "codex");
  assert.equal(task.state, "routed");
  assert.equal(task.first_pass, 0);
  assert.ok(Math.abs(task.total_cost_usd - 0.035) < 1e-9);
  assert.equal(task.total_wall_ms, 60);
  assert.equal(store.nextRound(taskId), 3);
});

test("rebuildTasks reproduces identical task rows from events", (t) => {
  const { store } = tempStore(t);
  const taskId = uuid();

  store.appendEvent(created(taskId, "mechanical"));
  store.appendEvent(routed(taskId, 1, "dsh", 0.002));
  store.appendEvent(started(taskId, 1, "dsh"));
  store.appendEvent(finished(taskId, 1, 0.04, 300));
  store.appendEvent(acceptance(taskId, 1, "accepted", 0.01, 40));

  const before = store.getTask(taskId);
  assert.ok(before !== null);

  assert.equal(store.rebuildTasks(), 1);
  assert.deepEqual(store.getTask(taskId), before);
  assert.equal(store.rebuildTasks(), 1);
  assert.deepEqual(store.getTask(taskId), before);
});

test("invalid event type and missing required payload fields throw invalid_event", (t) => {
  const { store } = tempStore(t);
  const taskId = uuid();

  const badType = {
    ...created(taskId),
    type: "not.an.event",
  } as unknown as EvenerEvent;
  assert.throws(
    () => store.appendEvent(badType),
    (err: unknown) => err instanceof StoreError && err.code === "invalid_event",
  );

  const missingField = {
    ...created(taskId),
    data: {},
  } as unknown as EvenerEvent;
  assert.throws(
    () => store.appendEvent(missingField),
    (err: unknown) => err instanceof StoreError && err.code === "invalid_event",
  );

  assert.equal(store.getTask(taskId), null);
});

test("applyProjection is pure and leaves unrelated events alone", () => {
  const taskId = uuid();
  const createdRow = applyProjection(null, created(taskId));
  assert.ok(createdRow !== null);
  assert.equal(createdRow.state, "created");

  const routedRow = applyProjection(createdRow, routed(taskId, 1, "dsh", 0.02, "A"));
  assert.ok(routedRow !== null);
  assert.equal(routedRow.state, "routed");
  assert.equal(routedRow.current_target, "dsh");
  assert.equal(routedRow.arm, "A");
  assert.equal(createdRow.state, "created");
  assert.equal(createdRow.current_target, null);

  const circuit = makeEvent(taskId, "target.circuit", 1, {
    target: "dsh",
    state: "open",
    until: null,
  });
  assert.deepEqual(applyProjection(routedRow, circuit), routedRow);
});
