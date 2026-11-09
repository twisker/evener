import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    pre_features: {
      description_chars: 20,
      files_mentioned: 2,
      repo_files: null,
      language: "ts",
      has_repro: false,
      cross_file: true,
      time_bucket: "lt15m",
    },
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

test("older dispatch and acceptance payloads without new accounting fields still validate", (t) => {
  const { store } = tempStore(t);
  const taskId = uuid();

  store.appendEvent(created(taskId));
  store.appendEvent(routed(taskId, 1, "codex", null));
  store.appendEvent(started(taskId, 1, "codex"));
  store.appendEvent(finished(taskId, 1, 0.1, 100));
  store.appendEvent(acceptance(taskId, 1, "accepted", 0.01, 10));

  const events = store.getEvents(taskId);
  const dispatchEvent = events.find((event) => event.type === "dispatch.finished");
  assert.ok(dispatchEvent !== undefined && dispatchEvent.type === "dispatch.finished");
  assert.equal(dispatchEvent.data.model_ms, undefined);
  assert.equal(dispatchEvent.data.tool_ms, undefined);
  assert.equal(dispatchEvent.data.pricing_period, undefined);

  const acceptanceEvent = events.find((event) => event.type === "acceptance.finished");
  assert.ok(acceptanceEvent !== undefined && acceptanceEvent.type === "acceptance.finished");
  assert.equal(acceptanceEvent.data.reviewer_usage, undefined);
  assert.equal(acceptanceEvent.data.self_accepted, undefined);
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

const MIGRATION_1_DDL = `
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, round INTEGER NOT NULL,
  ts TEXT NOT NULL, type TEXT NOT NULL, host TEXT NOT NULL, host_session_id TEXT,
  policy_version TEXT NOT NULL, schema_version INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX events_task ON events(task_id, seq);
CREATE INDEX events_type_ts ON events(type, ts);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, created_ts TEXT NOT NULL, closed_ts TEXT,
  host TEXT NOT NULL, host_session_id TEXT, analysis_label TEXT NOT NULL,
  arm TEXT, policy_version TEXT NOT NULL,
  current_round INTEGER NOT NULL DEFAULT 1, current_target TEXT,
  state TEXT NOT NULL, outcome TEXT, first_pass INTEGER,
  total_cost_usd REAL NOT NULL DEFAULT 0, total_wall_ms INTEGER NOT NULL DEFAULT 0,
  rating TEXT, overridden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

test("new task.created stratification fields project and survive rebuild", (t) => {
  const { store } = tempStore(t);
  const taskId = uuid();

  store.appendEvent(created(taskId, "bugfix"));

  const task = store.getTask(taskId);
  assert.ok(task !== null);
  assert.equal(task.language, "ts");
  assert.equal(task.has_repro, false);
  assert.equal(task.cross_file, true);
  assert.equal(task.time_bucket, "lt15m");

  assert.equal(store.rebuildTasks(), 1);
  assert.deepEqual(store.getTask(taskId), task);
});

test("old task.created payloads without labeler cost fields still validate", (t) => {
  const { store } = tempStore(t);
  const taskId = uuid();

  store.appendEvent(created(taskId));

  const task = store.getTask(taskId);
  assert.ok(task !== null);
  assert.equal(task.total_cost_usd, 0);
  assert.equal(store.getEvents(taskId).length, 1);
});

test("labeler cost is added to the task total and survives rebuildTasks", (t) => {
  const { store } = tempStore(t);
  const taskId = uuid();

  const legacy = created(taskId);
  const data = {
    ...legacy.data,
    labeler_cost_usd: 0.0001,
    labeler_latency_ms: 12,
  };
  store.appendEvent({ ...legacy, data } as unknown as EvenerEvent);
  store.appendEvent(routed(taskId, 1, "codex", 0.01));
  store.appendEvent(finished(taskId, 1, 0.02, 10));

  const task = store.getTask(taskId);
  assert.ok(task !== null);
  assert.ok(
    Math.abs(task.total_cost_usd - 0.0301) < 1e-12,
    `cost was ${task.total_cost_usd}`,
  );

  assert.equal(store.rebuildTasks(), 1);
  const rebuilt = store.getTask(taskId);
  assert.ok(rebuilt !== null);
  assert.ok(Math.abs(rebuilt.total_cost_usd - 0.0301) < 1e-12);
  assert.deepEqual(rebuilt, task);
});

test("an old-style task.created without the new fields still projects defaults", (t) => {
  const { store } = tempStore(t);
  const taskId = uuid();
  const legacy = created(taskId);
  const data = {
    ...legacy.data,
    pre_features: { description_chars: 12, files_mentioned: 1, repo_files: null },
  };
  store.appendEvent({ ...legacy, data } as unknown as EvenerEvent);

  const task = store.getTask(taskId);
  assert.ok(task !== null);
  assert.equal(task.language, null);
  assert.equal(task.has_repro, false);
  assert.equal(task.cross_file, false);
  assert.equal(task.time_bucket, "unknown");
});

test("opening a migration-1 database upgrades it to schema 2 and keeps rows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "evener-store-migrate-"));
  const dbPath = join(dir, "v1.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const legacy = new DatabaseSync(dbPath);
  legacy.exec(MIGRATION_1_DDL);
  legacy
    .prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')")
    .run();
  legacy
    .prepare(
      "INSERT INTO tasks (task_id, created_ts, host, analysis_label, policy_version, state) " +
        "VALUES ('legacy-task', '2026-01-01T00:00:00.000Z', 'claude-code', 'bugfix', 'oldpolicy000', 'created')",
    )
    .run();
  legacy.close();

  const store = openStore(dbPath);
  const task = store.getTask("legacy-task");
  assert.ok(task !== null);
  assert.equal(task.language, null);
  assert.equal(task.has_repro, false);
  assert.equal(task.cross_file, false);
  assert.equal(task.time_bucket, "unknown");
  store.close();

  const upgraded = new DatabaseSync(dbPath);
  const meta = upgraded
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  assert.equal(Number(meta?.["value"]), 2);
  const row = upgraded
    .prepare(
      "SELECT language, has_repro, cross_file, time_bucket FROM tasks WHERE task_id = 'legacy-task'",
    )
    .get();
  assert.equal(row?.["language"], null);
  assert.equal(row?.["has_repro"], 0);
  assert.equal(row?.["cross_file"], 0);
  assert.equal(row?.["time_bucket"], "unknown");
  upgraded.close();
});
