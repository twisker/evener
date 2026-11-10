import assert from "node:assert/strict";
import test from "node:test";
import { defaultPolicy, policyVersion } from "../src/config.js";
import type {
  AcceptanceFinishedPayload,
  DispatchFinishedPayload,
  DispatchStartedPayload,
  EvenerEvent,
  EventType,
  PayloadByType,
  RouteDecidedPayload,
  TaskCreatedPayload,
  TaskRedispatchPayload,
  TaskRow,
} from "../src/types.js";
import { uuid } from "../src/util.js";
import {
  overview,
  roundViews,
  sessionViews,
  taskSummaries,
} from "../src/ui/views.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLICY_VERSION = "abcdef123456";

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: "task-1",
    created_ts: "2026-11-09T10:00:00.000Z",
    closed_ts: null,
    host: "claude-code",
    host_session_id: "session-1",
    analysis_label: "bugfix",
    language: "ts",
    has_repro: true,
    cross_file: false,
    time_bucket: "lt15m",
    arm: "A",
    policy_version: POLICY_VERSION,
    current_round: 1,
    current_target: "codex",
    state: "dispatching",
    outcome: null,
    first_pass: null,
    total_cost_usd: 0,
    total_wall_ms: 0,
    rating: null,
    overridden: 0,
    ...overrides,
  };
}

function makeEvent<T extends EventType>(
  taskId: string,
  type: T,
  round: number,
  ts: string,
  data: PayloadByType[T],
): EvenerEvent {
  return {
    event_id: uuid(),
    task_id: taskId,
    round,
    ts,
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
  ts: string,
  overrides: Partial<TaskCreatedPayload> = {},
): EvenerEvent {
  const data: TaskCreatedPayload & { arm: string | null } = {
    description_hash: "a".repeat(64),
    description_excerpt: "Fix the retry loop",
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
    labeler_cost_usd: 0.001,
    labeler_latency_ms: 10,
    constraints: [],
    arm: "A",
    ...overrides,
  };
  return makeEvent(taskId, "task.created", 1, ts, data);
}

function routed(
  taskId: string,
  round: number,
  ts: string,
  target: string,
  overrides: Partial<RouteDecidedPayload> = {},
): EvenerEvent {
  const data: RouteDecidedPayload = {
    target,
    candidates: [{ target, score: 1 }],
    rationale: "lowest-cost capable target",
    decided_by: "rule",
    rule_id: "r-1",
    classifier_model: null,
    classifier_latency_ms: null,
    classifier_cost_usd: 0.002,
    arm: "A",
    escalated_from: null,
    ...overrides,
  };
  return makeEvent(taskId, "route.decided", round, ts, data);
}

function started(
  taskId: string,
  round: number,
  ts: string,
  target: string,
  model: string,
): EvenerEvent {
  const data: DispatchStartedPayload = {
    target,
    target_version: null,
    model,
    context_bytes: 100,
    command: "fake-target --json",
  };
  return makeEvent(taskId, "dispatch.started", round, ts, data);
}

function finished(
  taskId: string,
  round: number,
  ts: string,
  overrides: Partial<DispatchFinishedPayload> = {},
): EvenerEvent {
  const data: DispatchFinishedPayload = {
    status: "success",
    wall_ms: 1000,
    usage: { input: 100, cached_input: 20, output: 30, reasoning: 5 },
    usage_raw: {},
    cost_usd: 0.2,
    price_table_version: "price0000001",
    diff_stats: null,
    tool_calls: 2,
    exit_code: 0,
    target_session_id: null,
    output_path: `runs/${taskId}/${round}.out.md`,
    ...overrides,
  };
  return makeEvent(taskId, "dispatch.finished", round, ts, data);
}

function accepted(
  taskId: string,
  round: number,
  ts: string,
  overrides: Partial<AcceptanceFinishedPayload> = {},
): EvenerEvent {
  const data: AcceptanceFinishedPayload = {
    verdict: "accepted",
    checks: [{ name: "tests", result: "pass" }],
    review_verdict: "pass",
    reject_reason: null,
    reviewer_cost_usd: 0.01,
    reviewer_wall_ms: 100,
    reviewer_usage: { input: 10, cached_input: 5, output: 3 },
    self_accepted: false,
    ...overrides,
  };
  return makeEvent(taskId, "acceptance.finished", round, ts, data);
}

function redispatched(
  taskId: string,
  round: number,
  ts: string,
  overrides: Partial<TaskRedispatchPayload> = {},
): EvenerEvent {
  const data: TaskRedispatchPayload = {
    reason: "tests_failed",
    context_delta: "unchanged",
    next_target: "codex",
    kind: "escalate",
    ...overrides,
  };
  return makeEvent(taskId, "task.redispatch", round, ts, data);
}

// ---------------------------------------------------------------------------
// taskSummaries
// ---------------------------------------------------------------------------

test("taskSummaries reads the current round's model and running time", () => {
  const running = task({ task_id: "task-run" });
  const closed = task({
    task_id: "task-done",
    state: "closed",
    outcome: "accepted",
    closed_ts: "2026-11-09T10:00:06.000Z",
  });
  const events = new Map<string, EvenerEvent[]>([
    [
      "task-run",
      [
        created("task-run", "2026-11-09T10:00:00.000Z"),
        routed("task-run", 1, "2026-11-09T10:00:01.000Z", "codex"),
        started("task-run", 1, "2026-11-09T10:00:02.000Z", "codex", "gpt-5"),
      ],
    ],
    [
      "task-done",
      [
        created("task-done", "2026-11-09T10:00:00.000Z"),
        started("task-done", 1, "2026-11-09T10:00:02.000Z", "codex", "gpt-5"),
        finished("task-done", 1, "2026-11-09T10:00:03.000Z"),
      ],
    ],
  ]);

  const summaries = taskSummaries(
    [running, closed],
    events,
    new Date("2026-11-09T10:00:05.000Z"),
  );
  const run = summaries[0];
  const done = summaries[1];
  assert.ok(run !== undefined && done !== undefined);
  assert.equal(run.current_model, "gpt-5");
  assert.equal(run.started_ts, "2026-11-09T10:00:02.000Z");
  assert.equal(run.running_ms, 3000);
  assert.equal(run.last_event_type, "dispatch.started");
  assert.equal(run.last_event_ts, "2026-11-09T10:00:02.000Z");
  assert.equal(run.description_excerpt, "Fix the retry loop");
  assert.equal(done.running_ms, null);
  assert.equal(done.last_event_type, "dispatch.finished");
});

test("taskSummaries keeps the dispatched target when route and dispatch disagree", () => {
  const id = "task-retarget";
  const summaries = taskSummaries(
    [task({ task_id: id, current_target: "dsh" })],
    new Map<string, EvenerEvent[]>([
      [
        id,
        [
          created(id, "2026-11-09T10:00:00.000Z"),
          routed(id, 1, "2026-11-09T10:00:01.000Z", "codex"),
          started(id, 1, "2026-11-09T10:00:02.000Z", "dsh", "deepseek-flash"),
        ],
      ],
    ]),
    new Date("2026-11-09T10:00:05.000Z"),
  );
  const summary = summaries[0];
  assert.ok(summary !== undefined);
  assert.equal(summary.current_target, "dsh");
  assert.equal(summary.current_model, "deepseek-flash");
});

// ---------------------------------------------------------------------------
// roundViews
// ---------------------------------------------------------------------------

test("roundViews projects finished, running and redispatch rounds", () => {
  const id = "task-rounds";
  const events: EvenerEvent[] = [
    created(id, "2026-11-09T10:00:00.000Z"),
    routed(id, 1, "2026-11-09T10:00:01.000Z", "codex", {
      decided_by: "classifier",
      rule_id: null,
      rationale: "classifier picked codex",
      arm: "B",
      escalated_from: null,
    }),
    started(id, 1, "2026-11-09T10:00:02.000Z", "codex", "gpt-5-codex"),
    finished(id, 1, "2026-11-09T10:00:03.000Z", {
      wall_ms: 1200,
      model_ms: 800,
      tool_ms: 400,
      pricing_period: "peak",
      cost_usd: 0.25,
    }),
    accepted(id, 1, "2026-11-09T10:00:04.000Z", {
      checks: [
        { name: "tests", result: "pass" },
        { name: "lint", result: "skipped" },
      ],
      self_accepted: true,
    }),
    routed(id, 2, "2026-11-09T10:01:00.000Z", "host", {
      decided_by: "fallback",
      rule_id: null,
      rationale: "fallback to host",
      escalated_from: "codex",
    }),
    started(id, 2, "2026-11-09T10:01:01.000Z", "host", "claude-opus"),
    redispatched(id, 2, "2026-11-09T10:02:00.000Z", {
      kind: "retry",
      next_target: "dsh",
      reason: "timeout",
    }),
  ];

  const rounds = roundViews(events);
  assert.equal(rounds.length, 2);

  const first = rounds[0];
  assert.ok(first !== undefined);
  assert.equal(first.round, 1);
  assert.equal(first.target, "codex");
  assert.equal(first.model, "gpt-5-codex");
  assert.equal(first.decided_by, "classifier");
  assert.equal(first.rule_id, null);
  assert.equal(first.rationale, "classifier picked codex");
  assert.equal(first.arm, "B");
  assert.equal(first.escalated_from, null);
  assert.equal(first.dispatch_status, "success");
  assert.equal(first.wall_ms, 1200);
  assert.equal(first.model_ms, 800);
  assert.equal(first.tool_ms, 400);
  assert.equal(first.cost_usd, 0.25);
  assert.equal(first.pricing_period, "peak");
  assert.equal(first.verdict, "accepted");
  assert.equal(first.reject_reason, null);
  assert.deepEqual(first.checks, { tests: "pass", lint: "skipped" });
  assert.equal(first.review_verdict, "pass");
  assert.equal(first.reviewer_cost_usd, 0.01);
  assert.equal(first.self_accepted, true);
  assert.equal(first.output_path, `runs/${id}/1.out.md`);
  assert.equal(first.stderr_path, `runs/${id}/1.stderr`);
  assert.equal(first.redispatch, null);

  const second = rounds[1];
  assert.ok(second !== undefined);
  assert.equal(second.round, 2);
  assert.equal(second.target, "host");
  assert.equal(second.dispatch_status, "running");
  assert.equal(second.model_ms, null);
  assert.equal(second.tool_ms, null);
  assert.equal(second.pricing_period, null);
  assert.equal(second.self_accepted, false);
  assert.deepEqual(second.redispatch, {
    kind: "retry",
    next_target: "dsh",
    reason: "timeout",
  });
});

test("roundViews emits flat pricing and null timing for pre-F12 dispatches", () => {
  const id = "task-old";
  const events: EvenerEvent[] = [
    routed(id, 1, "2026-11-09T10:00:00.000Z", "codex"),
    started(id, 1, "2026-11-09T10:00:01.000Z", "codex", "gpt-5"),
    finished(id, 1, "2026-11-09T10:00:02.000Z", {
      output_path: null,
      cost_usd: 0.1,
    }),
    accepted(id, 1, "2026-11-09T10:00:03.000Z", {
      reviewer_cost_usd: 0,
      reviewer_usage: undefined,
      self_accepted: undefined,
    }),
  ];

  const round = roundViews(events)[0];
  assert.ok(round !== undefined);
  assert.equal(round.dispatch_status, "success");
  assert.equal(round.pricing_period, "flat");
  assert.equal(round.model_ms, null);
  assert.equal(round.tool_ms, null);
  assert.equal(round.output_path, null);
  assert.equal(round.stderr_path, null);
  assert.equal(round.self_accepted, false);
  assert.equal(round.reviewer_cost_usd, 0);
});

// ---------------------------------------------------------------------------
// sessionViews
// ---------------------------------------------------------------------------

test("sessionViews splits delegated, host, reviewer and overhead cost", () => {
  const sessionTask = task({
    task_id: "task-session",
    host_session_id: "session-1",
    state: "closed",
    outcome: "accepted",
    total_cost_usd: 0.383,
  });
  const orphanTask = task({
    task_id: "task-none",
    host_session_id: null,
    state: "created",
    current_target: null,
  });
  const events = new Map<string, EvenerEvent[]>([
    [
      "task-session",
      [
        created("task-session", "2026-11-09T10:00:00.000Z"),
        routed("task-session", 1, "2026-11-09T10:00:01.000Z", "dsh", {
          classifier_cost_usd: 0.002,
        }),
        started("task-session", 1, "2026-11-09T10:00:02.000Z", "dsh", "deepseek"),
        finished("task-session", 1, "2026-11-09T10:00:03.000Z", {
          cost_usd: 0.1,
          pricing_period: "peak",
        }),
        accepted("task-session", 1, "2026-11-09T10:00:04.000Z", {
          reviewer_cost_usd: 0.01,
          reviewer_usage: { input: 10, cached_input: 5, output: 3 },
        }),
        routed("task-session", 2, "2026-11-09T10:01:00.000Z", "host", {
          classifier_cost_usd: 0,
        }),
        started("task-session", 2, "2026-11-09T10:01:01.000Z", "host", "claude"),
        finished("task-session", 2, "2026-11-09T10:01:02.000Z", {
          cost_usd: 0.2,
          pricing_period: "off",
        }),
        accepted("task-session", 2, "2026-11-09T10:01:03.000Z", {
          reviewer_cost_usd: 0.02,
          reviewer_usage: undefined,
        }),
        routed("task-session", 3, "2026-11-09T10:02:00.000Z", "dsh", {
          classifier_cost_usd: 0,
        }),
        started("task-session", 3, "2026-11-09T10:02:01.000Z", "dsh", "deepseek"),
        finished("task-session", 3, "2026-11-09T10:02:02.000Z", {
          cost_usd: 0.05,
          pricing_period: "flat",
        }),
      ],
    ],
    [
      "task-none",
      [
        created("task-none", "2026-11-09T11:00:00.000Z", {
          labeler_cost_usd: 0.0005,
        }),
      ],
    ],
  ]);

  const sessions = sessionViews(
    [sessionTask, orphanTask],
    events,
    new Date("2026-11-01T00:00:00.000Z"),
  );
  assert.equal(sessions.length, 2);
  const main = sessions.find((session) => session.host_session_id === "session-1");
  const none = sessions.find((session) => session.host_session_id === "(none)");
  assert.ok(main !== undefined && none !== undefined);

  assert.equal(main.host, "claude-code");
  assert.equal(main.tasks, 1);
  assert.equal(main.accepted, 1);
  assert.equal(main.open, 0);
  assert.ok(Math.abs(main.delegated_cost_usd - 0.15) < 1e-9);
  assert.ok(Math.abs(main.host_round_cost_usd - 0.2) < 1e-9);
  assert.ok(Math.abs(main.reviewer_cost_usd - 0.03) < 1e-9);
  assert.ok(Math.abs(main.overhead_cost_usd - 0.003) < 1e-9);
  assert.ok(Math.abs(main.total_cost_usd - 0.383) < 1e-9);
  assert.ok(Math.abs(main.peak_cost_usd - 0.1) < 1e-9);
  assert.ok(Math.abs(main.off_cost_usd - 0.25) < 1e-9);
  assert.deepEqual(main.reviewer_tokens, { input: 10, cached_input: 5, output: 3 });
  assert.deepEqual(main.targets, { dsh: 2, host: 1 });

  assert.equal(none.tasks, 1);
  assert.equal(none.open, 1);
  assert.equal(none.reviewer_tokens, null);
  assert.ok(Math.abs(none.overhead_cost_usd - 0.0005) < 1e-9);
  assert.ok(Math.abs(none.total_cost_usd - 0.0005) < 1e-9);
  assert.deepEqual(none.targets, {});
});

test("sessionViews honours the since window", () => {
  const oldTask = task({
    task_id: "task-old",
    host_session_id: "session-old",
    created_ts: "2026-10-01T00:00:00.000Z",
  });
  const newTask = task({
    task_id: "task-new",
    host_session_id: "session-new",
    created_ts: "2026-11-09T00:00:00.000Z",
  });
  const sessions = sessionViews(
    [oldTask, newTask],
    new Map(),
    new Date("2026-11-01T00:00:00.000Z"),
  );
  assert.deepEqual(
    sessions.map((session) => session.host_session_id),
    ["session-new"],
  );
});

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

test("overview counts the last seven days and open tasks", () => {
  const policy = defaultPolicy();
  policy.experiment.mode = "interleave";
  policy.experiment.arms = { B: "b.yaml", A: "a.yaml" };
  const now = new Date("2026-11-09T12:00:00.000Z");

  const tasks: TaskRow[] = [
    task({
      task_id: "accepted",
      created_ts: "2026-11-08T12:00:00.000Z",
      state: "closed",
      outcome: "accepted",
      total_cost_usd: 0.5,
    }),
    task({
      task_id: "open",
      created_ts: "2026-11-07T12:00:00.000Z",
      state: "created",
      total_cost_usd: 0.1,
    }),
    task({
      task_id: "old",
      created_ts: "2026-10-20T12:00:00.000Z",
      state: "closed",
      outcome: "accepted",
      total_cost_usd: 2,
    }),
  ];

  const result = overview(tasks, [], policy, "pricing-1", now, {
    current: "0.1.0",
    latest: "0.2.0",
    available: true,
    checked_at: "2026-11-09T11:00:00.000Z",
  }, "/tmp/evener");
  assert.equal(result.now, now.toISOString());
  assert.equal(result.home, "/tmp/evener");
  assert.equal(result.policy_name, policy.policy_name);
  assert.equal(result.policy_version, policyVersion(policy));
  assert.equal(result.experiment_mode, "interleave");
  assert.deepEqual(result.arms, ["A", "B"]);
  assert.equal(result.pricing_version, "pricing-1");
  assert.equal(result.open_tasks, 1);
  assert.equal(result.tasks_7d, 2);
  assert.equal(result.accepted_7d, 1);
  assert.ok(Math.abs(result.cost_7d_usd - 0.6) < 1e-9);
  assert.deepEqual(result.update, {
    current: "0.1.0",
    latest: "0.2.0",
    available: true,
    checked_at: "2026-11-09T11:00:00.000Z",
  });
});
