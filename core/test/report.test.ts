import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ApplyError, applySuggestion } from "../src/apply.js";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/cli.js";
import { defaultPolicy, defaultPricing, policyTemplatePath } from "../src/config.js";
import { buildReport, renderMarkdown } from "../src/report.js";
import { openStore } from "../src/store.js";
import type { Store } from "../src/store.js";
import type {
  EventType,
  EvenerEvent,
  Label,
  PayloadByType,
  Pricing,
  TaskRow,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse("2020-01-01T00:00:00.000Z");
const TASK_SPACING_MS = 60_000;

interface Fixture {
  store: Store;
  dir: string;
  dbPath: string;
}

function tempStore(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "evener-report-"));
  const dbPath = join(dir, "evener.sqlite");
  const store = openStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir, dbPath };
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "evener-report-home-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Deterministic synthetic dataset
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SeededTaskInfo {
  task_id: string;
  arm: string;
  label: Label;
  target: string;
  first_pass: boolean;
  accepted: boolean;
  total_cost_usd: number;
  rounds: number;
}

interface SeedResult {
  tasks: SeededTaskInfo[];
  total_tasks: number;
}

interface SeedOptions {
  tasksPerCell?: number;
  seed?: number;
  testCell?: boolean;
  reviewerCost?: number;
}

/** Two arms × three labels × N tasks, plus an n=5 `test` cell. */
function seed(store: Store, options: SeedOptions = {}): SeedResult {
  const tasksPerCell = options.tasksPerCell ?? 12;
  const reviewerCost = options.reviewerCost ?? 0;
  const random = mulberry32(options.seed ?? 42);
  const arms = ["A", "B"] as const;
  const labels: Label[] = ["mechanical", "bugfix", "docs"];
  const tasks: SeededTaskInfo[] = [];
  let eventSeq = 0;
  let taskIndex = 0;

  const makeEvent = <K extends EventType>(
    task: TaskRow,
    type: K,
    round: number,
    ts: string,
    data: PayloadByType[K],
  ): EvenerEvent => {
    eventSeq += 1;
    const event = {
      event_id: `seed-event-${eventSeq}`,
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
  };

  const mustTask = (taskId: string): TaskRow => {
    const row = store.getTask(taskId);
    assert.ok(row !== null, `seeded task ${taskId} missing`);
    return row;
  };

  const seedOne = (
    taskId: string,
    arm: string,
    label: Label,
    target: string,
    cost: number,
    firstAccepted: boolean,
    rejectReason: "tests_failed" | "style",
  ): void => {
    const start = T0 + taskIndex * TASK_SPACING_MS;
    taskIndex += 1;
    const ts = (offsetSeconds = 0): string =>
      new Date(start + offsetSeconds * 1000).toISOString();

    store.appendEvent({
      event_id: `seed-created-${taskId}`,
      task_id: taskId,
      round: 1,
      ts: ts(),
      type: "task.created",
      host: "claude-code",
      host_session_id: null,
      policy_version: "seedpolicy000",
      schema_version: 1,
      data: {
        description_hash: `hash-${taskId}`,
        description_excerpt: null,
        repo_fingerprint: null,
        pre_features: { description_chars: 20, files_mentioned: 1, repo_files: null },
        analysis_label: label,
        labeler_model: "heuristic",
        constraints: [],
        arm,
      },
    } as unknown as EvenerEvent);

    let task = mustTask(taskId);
    let wall = 100 + Math.floor(random() * 40);
    let totalCost = 0;
    let rounds = 1;

    const route = (round: number): void => {
      store.appendEvent(
        makeEvent(task, "route.decided", round, ts(round), {
          target,
          candidates: [{ target, score: 1 }],
          rationale: "seed",
          decided_by: "fallback",
          rule_id: null,
          classifier_model: null,
          classifier_latency_ms: 50 + Math.floor(random() * 20),
          classifier_cost_usd: 0,
          arm,
          escalated_from: null,
        }),
      );
    };
    const dispatch = (round: number): void => {
      wall = 100 + Math.floor(random() * 40);
      totalCost += cost;
      store.appendEvent(
        makeEvent(task, "dispatch.finished", round, ts(round), {
          status: "success",
          wall_ms: wall,
          usage: { input: 10, cached_input: 0, output: 5, reasoning: 0 },
          usage_raw: {},
          cost_usd: cost,
          price_table_version: "seedpricing0",
          diff_stats: null,
          tool_calls: null,
          exit_code: 0,
          target_session_id: null,
          output_path: null,
        }),
      );
    };
    const acceptance = (
      round: number,
      verdict: "accepted" | "rejected",
      reason: "tests_failed" | "style" | null,
    ): void => {
      store.appendEvent(
        makeEvent(task, "acceptance.finished", round, ts(round), {
          verdict,
          checks: [],
          review_verdict: "skipped",
          reject_reason: reason,
          reviewer_cost_usd: reviewerCost,
          reviewer_wall_ms: 0,
        }),
      );
    };

    route(1);
    dispatch(1);
    if (firstAccepted) {
      acceptance(1, "accepted", null);
    } else {
      acceptance(1, "rejected", rejectReason);
      rounds = 2;
      store.appendEvent(
        makeEvent(task, "task.redispatch", 2, ts(2), {
          reason: rejectReason,
          context_delta: "unchanged",
          next_target: target,
          kind: "retry",
        }),
      );
      route(2);
      dispatch(2);
      acceptance(2, "accepted", null);
    }

    store.appendEvent(
      makeEvent(task, "task.closed", rounds, ts(rounds), {
        outcome: "accepted",
        total_rounds: rounds,
        total_cost_usd: totalCost,
        total_wall_ms: wall * rounds,
      }),
    );

    tasks.push({
      task_id: taskId,
      arm,
      label,
      target,
      first_pass: firstAccepted,
      accepted: true,
      total_cost_usd: totalCost,
      rounds,
    });
  };

  for (const label of labels) {
    for (const arm of arms) {
      for (let index = 0; index < tasksPerCell; index += 1) {
        const target =
          label === "mechanical"
            ? arm === "A"
              ? "dsh"
              : "codex"
            : label === "bugfix"
              ? "codex"
              : "dsh";
        const cost =
          label === "mechanical" ? (arm === "A" ? 0.1 : 0.5) : label === "bugfix" ? 0.3 : 0.2;
        const firstAccepted =
          label === "bugfix" ? index < 4 : !(label === "mechanical" && arm === "B" && index >= 4);
        const reason: "tests_failed" | "style" =
          label === "bugfix" ? "style" : "tests_failed";
        seedOne(
          `task-${label}-${arm}-${index}`,
          arm,
          label,
          target,
          cost,
          firstAccepted,
          reason,
        );
      }
    }
  }

  if (options.testCell !== false) {
    for (let index = 0; index < 5; index += 1) {
      seedOne(`task-test-A-${index}`, "A", "test", "dsh", 0.05, true, "tests_failed");
    }
  }

  return { tasks, total_tasks: tasks.length };
}

function experimentPolicy() {
  const policy = defaultPolicy();
  policy.experiment.mode = "interleave";
  policy.experiment.arms = { A: "policy-a.yaml", B: "policy-b.yaml" };
  return policy;
}

function reportFor(store: Store, policy = experimentPolicy(), pricing: Pricing = defaultPricing()) {
  return buildReport(store, policy, pricing, {
    since: new Date(T0 - 1000),
    now: new Date(T0 + 400 * TASK_SPACING_MS),
    by: "label",
  });
}

let attributionEventSeq = 0;

function appendTaskEvent<K extends EventType>(
  store: Store,
  task: TaskRow,
  type: K,
  round: number,
  ts: string,
  data: PayloadByType[K],
): void {
  attributionEventSeq += 1;
  store.appendEvent({
    event_id: `attribution-event-${attributionEventSeq}`,
    task_id: task.task_id,
    round,
    ts,
    type,
    host: task.host,
    host_session_id: task.host_session_id,
    policy_version: task.policy_version,
    schema_version: 1,
    data,
  } as unknown as EvenerEvent);
}

function createAttributionTask(store: Store, taskId: string, label: Label): TaskRow {
  store.appendEvent({
    event_id: `attribution-created-${taskId}`,
    task_id: taskId,
    round: 1,
    ts: new Date(T0).toISOString(),
    type: "task.created",
    host: "claude-code",
    host_session_id: null,
    policy_version: "attribution00",
    schema_version: 1,
    data: {
      description_hash: `hash-${taskId}`,
      description_excerpt: null,
      repo_fingerprint: null,
      pre_features: { description_chars: 20, files_mentioned: 1, repo_files: null },
      analysis_label: label,
      labeler_model: "heuristic",
      constraints: [],
      arm: "A",
    },
  } as unknown as EvenerEvent);
  const task = store.getTask(taskId);
  assert.ok(task !== null, `created task ${taskId} missing`);
  return task;
}

function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Report structure and metrics
// ---------------------------------------------------------------------------

test("report exposes the frozen section order and header counts", (t) => {
  const { store } = tempStore(t);
  const seeded = seed(store);
  const report = reportFor(store);

  assert.deepEqual(Object.keys(report), [
    "header",
    "arms",
    "strata",
    "targets",
    "detectability",
    "alerts",
    "suggestions",
  ]);
  assert.equal(report.header.total_tasks, seeded.total_tasks);
  assert.equal(report.header.closed_tasks, seeded.total_tasks);
  assert.equal(report.header.accepted_tasks, seeded.total_tasks);
  assert.equal(report.arms.length, 2);
  assert.deepEqual(
    report.arms.map((arm) => arm.arm),
    ["A", "B"],
  );
  assert.ok(report.header.saved_to === null);
});

test("experiment off produces a single all arm", (t) => {
  const { store } = tempStore(t);
  const seeded = seed(store);
  const report = buildReport(store, defaultPolicy(), defaultPricing(), {
    since: new Date(T0 - 1000),
    now: new Date(T0 + 400 * TASK_SPACING_MS),
  });

  assert.deepEqual(
    report.arms.map((arm) => arm.arm),
    ["all"],
  );
  assert.equal(report.header.arms["all"], seeded.total_tasks);
  assert.equal(report.header.experiment_mode, "off");
});

test("CPAT for one cell equals the hand-computed value", (t) => {
  const { store } = tempStore(t);
  seed(store);
  const report = reportFor(store);

  const cell = report.strata.find(
    (row) => row.analysis_label === "mechanical" && row.arm === "A",
  );
  assert.ok(cell !== undefined, "mechanical/A stratum missing");
  assert.equal(cell.n, 12);
  assert.equal(cell.accepted, 12);
  assert.ok(Math.abs((cell.cpat ?? 0) - 0.1) < 1e-12); // 12 tasks × $0.10 / 12 accepted
  assert.equal(cell.insufficient, false);
});

test("a cell with n = 5 is marked insufficient", (t) => {
  const { store } = tempStore(t);
  seed(store);
  const report = reportFor(store);

  const cell = report.strata.find(
    (row) => row.analysis_label === "test" && row.arm === "A",
  );
  assert.ok(cell !== undefined, "test/A stratum missing");
  assert.equal(cell.n, 5);
  assert.equal(cell.insufficient, true);
});

test("quality weights redistribute when there is no feedback or revert data", (t) => {
  const { store } = tempStore(t);
  seed(store);
  const report = reportFor(store);

  const arm = report.arms.find((entry) => entry.arm === "A");
  assert.ok(arm !== undefined);
  assert.ok(Math.abs(arm.weights.first_pass - 2 / 3) < 1e-12);
  assert.ok(Math.abs(arm.weights.final_pass - 1 / 3) < 1e-12);
  assert.equal(arm.weights.feedback, 0);
  assert.equal(arm.weights.revert, 0);

  const mechanical = report.strata.find(
    (row) => row.analysis_label === "mechanical" && row.arm === "A",
  );
  assert.ok(mechanical !== undefined);
  assert.ok(Math.abs((mechanical.quality_score ?? 0) - 1) < 1e-12);

  const b = report.strata.find(
    (row) => row.analysis_label === "mechanical" && row.arm === "B",
  );
  assert.ok(b !== undefined);
  const expected = (4 / 12) * (2 / 3) + 1 * (1 / 3);
  assert.ok(Math.abs((b.quality_score ?? 0) - expected) < 1e-12);
});

test("style suspicion triggers when style is at least half of a target's rejections", (t) => {
  const { store } = tempStore(t);
  seed(store);
  const report = reportFor(store);

  const codex = report.targets.find((target) => target.target === "codex");
  assert.ok(codex !== undefined);
  assert.equal(codex.style_suspected, true);
  assert.ok((codex.style_ratio ?? 0) >= 0.5);
  assert.ok(report.alerts.some((alert) => alert.code === "style_suspicion"));
});

test("override before dispatch attributes the round to the dispatched target", (t) => {
  const { store } = tempStore(t);
  const task = createAttributionTask(store, "task-overridden", "mechanical");

  appendTaskEvent(store, task, "route.decided", 1, at(1), {
    target: "codex",
    candidates: [{ target: "codex", score: 1 }],
    rationale: "test",
    decided_by: "fallback",
    rule_id: null,
    classifier_model: null,
    classifier_latency_ms: 10,
    classifier_cost_usd: 0,
    arm: "A",
    escalated_from: null,
  });
  appendTaskEvent(store, task, "user.override", 1, at(2), {
    from: "codex",
    to: "dsh",
  });
  appendTaskEvent(store, task, "dispatch.started", 1, at(3), {
    target: "dsh",
    target_version: null,
    model: null,
    context_bytes: 10,
    command: "dsh --profile headless --json",
  });
  appendTaskEvent(store, task, "dispatch.finished", 1, at(4), {
    status: "success",
    wall_ms: 1234,
    usage: { input: 10, cached_input: 0, output: 5, reasoning: 0 },
    usage_raw: {},
    cost_usd: 0.25,
    price_table_version: "testpricing",
    diff_stats: null,
    tool_calls: null,
    exit_code: 0,
    target_session_id: null,
    output_path: null,
  });
  appendTaskEvent(store, task, "acceptance.finished", 1, at(5), {
    verdict: "accepted",
    checks: [],
    review_verdict: "skipped",
    reject_reason: null,
    reviewer_cost_usd: 0.05,
    reviewer_wall_ms: 10,
  });
  appendTaskEvent(store, task, "task.closed", 1, at(6), {
    outcome: "accepted",
    total_rounds: 1,
    total_cost_usd: 0.3,
    total_wall_ms: 1244,
  });

  const report = reportFor(store);
  const dsh = report.targets.find((target) => target.target === "dsh");
  const codex = report.targets.find((target) => target.target === "codex");
  assert.ok(dsh !== undefined);
  assert.ok(codex !== undefined);

  assert.equal(dsh.n, 1);
  assert.equal(dsh.dispatches, 1);
  assert.equal(dsh.accepted, 1);
  assert.equal(dsh.first_pass_rate, 1);
  assert.equal(dsh.final_pass_rate, 1);
  assert.ok(Math.abs((dsh.mean_cost_usd ?? 0) - 0.3) < 1e-12);
  assert.equal(dsh.mean_wall_ms, 1234);

  assert.equal(codex.n, 0);
  assert.equal(codex.dispatches, 0);
  assert.equal(codex.accepted, 0);
  assert.equal(codex.mean_cost_usd, null);
  assert.equal(codex.first_pass_rate, null);
  assert.equal(codex.final_pass_rate, null);
});

test("multi-round task attributes each round to its dispatched target", (t) => {
  const { store } = tempStore(t);
  const task = createAttributionTask(store, "task-escalated", "bugfix");

  appendTaskEvent(store, task, "route.decided", 1, at(1), {
    target: "dsh",
    candidates: [{ target: "dsh", score: 1 }],
    rationale: "test",
    decided_by: "fallback",
    rule_id: null,
    classifier_model: null,
    classifier_latency_ms: 10,
    classifier_cost_usd: 0,
    arm: "A",
    escalated_from: null,
  });
  appendTaskEvent(store, task, "dispatch.started", 1, at(2), {
    target: "dsh",
    target_version: null,
    model: null,
    context_bytes: 10,
    command: "dsh --profile headless --json",
  });
  appendTaskEvent(store, task, "dispatch.finished", 1, at(3), {
    status: "success",
    wall_ms: 100,
    usage: { input: 10, cached_input: 0, output: 5, reasoning: 0 },
    usage_raw: {},
    cost_usd: 0.1,
    price_table_version: "testpricing",
    diff_stats: null,
    tool_calls: null,
    exit_code: 0,
    target_session_id: null,
    output_path: null,
  });
  appendTaskEvent(store, task, "acceptance.finished", 1, at(4), {
    verdict: "rejected",
    checks: [],
    review_verdict: "skipped",
    reject_reason: "tests_failed",
    reviewer_cost_usd: 0.01,
    reviewer_wall_ms: 5,
  });
  appendTaskEvent(store, task, "task.redispatch", 2, at(5), {
    reason: "tests_failed",
    context_delta: "unchanged",
    next_target: "codex",
    kind: "escalate",
  });
  appendTaskEvent(store, task, "route.decided", 2, at(6), {
    target: "codex",
    candidates: [{ target: "codex", score: 1 }],
    rationale: "test",
    decided_by: "fallback",
    rule_id: null,
    classifier_model: null,
    classifier_latency_ms: 20,
    classifier_cost_usd: 0,
    arm: "A",
    escalated_from: "dsh",
  });
  appendTaskEvent(store, task, "dispatch.started", 2, at(7), {
    target: "codex",
    target_version: null,
    model: null,
    context_bytes: 10,
    command: "codex exec --json",
  });
  appendTaskEvent(store, task, "dispatch.finished", 2, at(8), {
    status: "success",
    wall_ms: 200,
    usage: { input: 10, cached_input: 0, output: 5, reasoning: 0 },
    usage_raw: {},
    cost_usd: 0.2,
    price_table_version: "testpricing",
    diff_stats: null,
    tool_calls: null,
    exit_code: 0,
    target_session_id: null,
    output_path: null,
  });
  appendTaskEvent(store, task, "acceptance.finished", 2, at(9), {
    verdict: "accepted",
    checks: [],
    review_verdict: "skipped",
    reject_reason: null,
    reviewer_cost_usd: 0.02,
    reviewer_wall_ms: 5,
  });
  appendTaskEvent(store, task, "task.closed", 2, at(10), {
    outcome: "accepted",
    total_rounds: 2,
    total_cost_usd: 0.33,
    total_wall_ms: 310,
  });

  const report = reportFor(store);
  const dsh = report.targets.find((target) => target.target === "dsh");
  const codex = report.targets.find((target) => target.target === "codex");
  assert.ok(dsh !== undefined);
  assert.ok(codex !== undefined);

  assert.equal(dsh.n, 1);
  assert.equal(dsh.dispatches, 1);
  assert.equal(dsh.accepted, 0);
  assert.equal(dsh.first_pass_rate, 0);
  assert.equal(dsh.final_pass_rate, null);
  assert.equal(dsh.reject_reasons.tests_failed, 1);
  assert.ok(Math.abs((dsh.mean_cost_usd ?? 0) - 0.11) < 1e-12);

  assert.equal(codex.n, 1);
  assert.equal(codex.dispatches, 1);
  assert.equal(codex.accepted, 1);
  assert.equal(codex.first_pass_rate, null);
  assert.equal(codex.final_pass_rate, 1);
  assert.equal(codex.rejections, 0);
  assert.ok(Math.abs((codex.mean_cost_usd ?? 0) - 0.22) < 1e-12);
  assert.ok(Math.abs((codex.cpat ?? 0) - 0.22) < 1e-12);
});

test("acceptance overhead alerts fire for expensive reviews", (t) => {
  const { store } = tempStore(t);
  seed(store, { reviewerCost: 0.5 });
  const report = reportFor(store);

  assert.ok(
    report.alerts.some((alert) => alert.code === "acceptance_overhead_task"),
  );
  assert.ok(
    report.alerts.some((alert) => alert.code === "acceptance_overhead_window"),
  );
});

test("suggestion rule 1 fires for a label first-pass / CPAT gap", (t) => {
  const { store } = tempStore(t);
  seed(store);
  const report = reportFor(store);

  const suggestion = report.suggestions[0];
  assert.ok(suggestion !== undefined, "expected at least one suggestion");
  assert.equal(suggestion.field, "preferences.per_label_bias.mechanical.dsh");
  assert.equal(suggestion.from, 0.8);
  assert.equal(suggestion.to, 1);
  assert.ok(suggestion.evidence.includes("mechanical"));
  assert.ok(report.suggestions.length <= 3);
});

test("detectability includes an MDD and per-label MDD values", (t) => {
  const { store } = tempStore(t);
  seed(store);
  const report = reportFor(store);

  assert.equal(report.detectability.alpha, 0.1);
  assert.equal(report.detectability.power, 0.8);
  assert.equal(report.detectability.comparisons.length, 1);
  assert.ok((report.detectability.mdd ?? 0) > 0);
  assert.ok(report.detectability.by_label.length >= 3);
});

test("markdown rendering uses bilingual headers and the MDD explanation", (t) => {
  const { store } = tempStore(t);
  seed(store);
  const markdown = renderMarkdown(reportFor(store));

  assert.ok(markdown.includes("总表 / Summary"));
  assert.ok(markdown.includes("分层 / Strata by analysis label"));
  assert.ok(markdown.includes("目标画像 / Targets"));
  assert.ok(markdown.includes("可检出差异 / Detectability"));
  assert.ok(markdown.includes("MDD"));
  assert.ok(markdown.includes("建议 / Suggestions"));
});

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function writeHomePolicy(home: string, bias: number): string {
  const text = readFileSync(policyTemplatePath(), "utf8").replace(
    "    mechanical: {dsh: 0.8, codex: 0.2}",
    `    mechanical: {dsh: ${bias}, codex: 0.2} # keep-this-comment`,
  );
  writeFileSync(join(home, "policy.yaml"), text, "utf8");
  return text;
}

function writeReport(home: string, suggestions: unknown[]): string {
  const dir = join(home, "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "test-report.json");
  writeFileSync(file, JSON.stringify({ header: {}, suggestions }, null, 2), "utf8");
  return file;
}

function deletePath(value: unknown, path: readonly string[]): void {
  if (path.length === 0) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (path.length === 1) {
    delete record[path[0] ?? ""];
    return;
  }
  deletePath(record[path[0] ?? ""], path.slice(1));
}

test("apply changes only the suggested key and preserves comments", (t) => {
  const home = tempDir(t);
  const beforeText = writeHomePolicy(home, 0.2);
  const reportFile = writeReport(home, [
    {
      n: 1,
      field: "preferences.per_label_bias.mechanical.dsh",
      from: 0.2,
      to: 0.4,
      evidence: "test",
    },
  ]);

  const result = applySuggestion(home, reportFile, 1);
  assert.equal(result.field, "preferences.per_label_bias.mechanical.dsh");
  assert.equal(result.from, 0.2);
  assert.equal(result.to, 0.4);
  assert.equal(result.policy_version.length, 12);

  const afterText = readFileSync(join(home, "policy.yaml"), "utf8");
  assert.ok(afterText.includes("# keep-this-comment"));
  assert.ok(afterText.includes("# top") || beforeText.includes("# top") === false);

  const before = parseYaml(beforeText) as Record<string, unknown>;
  const after = parseYaml(afterText) as Record<string, unknown>;
  const path = ["preferences", "per_label_bias", "mechanical", "dsh"] as const;
  assert.equal(
    (after["preferences"] as Record<string, unknown> | undefined)?.["per_label_bias"] !== undefined,
    true,
  );
  const afterBias = (
    (after["preferences"] as Record<string, unknown>)["per_label_bias"] as Record<
      string,
      Record<string, number>
    >
  )["mechanical"]?.["dsh"];
  assert.equal(afterBias, 0.4);

  deletePath(before, path);
  deletePath(after, path);
  assert.deepEqual(after, before);
});

test("apply refuses to overwrite a changed policy value (stale)", (t) => {
  const home = tempDir(t);
  writeHomePolicy(home, 0.2);
  const reportFile = writeReport(home, [
    {
      n: 1,
      field: "preferences.per_label_bias.mechanical.dsh",
      from: 0.2,
      to: 0.4,
      evidence: "test",
    },
  ]);

  writeHomePolicy(home, 0.3);
  const before = readFileSync(join(home, "policy.yaml"), "utf8");
  assert.throws(
    () => applySuggestion(home, reportFile, 1),
    (err: unknown) => err instanceof ApplyError && err.code === "stale",
  );
  assert.equal(readFileSync(join(home, "policy.yaml"), "utf8"), before);
});

test("apply can target an experiment arm file", (t) => {
  const home = tempDir(t);
  const top = parseYaml(readFileSync(policyTemplatePath(), "utf8")) as Record<string, unknown>;
  const experiment = top["experiment"] as Record<string, unknown>;
  experiment["mode"] = "interleave";
  experiment["arms"] = { A: "policy-a.yaml" };
  writeFileSync(join(home, "policy.yaml"), stringifyYaml(top), "utf8");

  const armText = [
    "# arm comment",
    "preferences:",
    "  per_label_bias:",
    "    mechanical: {dsh: 0.2} # keep-arm-comment",
    "",
  ].join("\n");
  writeFileSync(join(home, "policy-a.yaml"), armText, "utf8");

  const reportFile = writeReport(home, [
    {
      n: 1,
      field: "preferences.per_label_bias.mechanical.dsh",
      from: 0.2,
      to: 0.4,
      evidence: "test",
    },
  ]);

  const result = applySuggestion(home, reportFile, 1, "A");
  assert.equal(result.to, 0.4);
  const updated = readFileSync(join(home, "policy-a.yaml"), "utf8");
  assert.ok(updated.includes("# keep-arm-comment"));
  const parsed = parseYaml(updated) as {
    preferences: { per_label_bias: { mechanical: { dsh: number } } };
  };
  assert.equal(parsed.preferences.per_label_bias.mechanical.dsh, 0.4);
  assert.equal(readFileSync(join(home, "policy-a.yaml"), "utf8").includes("codex"), false);
});

// ---------------------------------------------------------------------------
// CLI integration
// ---------------------------------------------------------------------------

interface CliResult {
  code: number;
  text: string;
}

async function runCliText(argv: string[]): Promise<CliResult> {
  const chunks: string[] = [];
  const io: CliIO = {
    stdout: (text) => {
      chunks.push(text);
    },
    stderr: () => undefined,
    env: {},
    cwd: process.cwd(),
  };
  const code = await runCli(argv, io);
  return { code, text: chunks.join("") };
}

test("report/apply/export commands integrate with the CLI", async (t) => {
  const home = tempDir(t);
  assert.equal((await runCliText(["init", "--home", home])).code, 0);

  const store = openStore(join(home, "evener.sqlite"));
  const seeded = seed(store);
  const eventCount = store.listEvents().length;
  store.close();

  const json = await runCliText([
    "report",
    "--home",
    home,
    "--since",
    "2019-01-01T00:00:00.000Z",
  ]);
  assert.equal(json.code, 0);
  const report = JSON.parse(json.text) as {
    header: { saved_to: string | null; total_tasks: number };
    suggestions: { field: string }[];
  };
  assert.equal(report.header.total_tasks, seeded.total_tasks);
  assert.ok(report.header.saved_to !== null);
  assert.equal(existsSync(report.header.saved_to ?? ""), true);

  const markdown = await runCliText([
    "report",
    "--home",
    home,
    "--since",
    "2019-01-01T00:00:00.000Z",
    "--format",
    "md",
  ]);
  assert.equal(markdown.code, 0);
  assert.ok(markdown.text.includes("总表 / Summary"));
  assert.ok(markdown.text.includes("可检出差异 / Detectability"));

  const jsonl = await runCliText([
    "export",
    "--home",
    home,
    "--since",
    "2019-01-01T00:00:00.000Z",
    "--format",
    "jsonl",
  ]);
  assert.equal(jsonl.code, 0);
  assert.equal(jsonl.text.split("\n").filter((line) => line.length > 0).length, eventCount);

  const otel = await runCliText([
    "export",
    "--home",
    home,
    "--since",
    "2019-01-01T00:00:00.000Z",
    "--format",
    "otel",
  ]);
  assert.equal(otel.code, 0);
  const otelPayload = JSON.parse(otel.text) as {
    resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[];
  };
  assert.equal(otelPayload.resourceLogs[0]?.scopeLogs[0]?.logRecords.length, eventCount);

  const apply = await runCliText(["apply", "1", "--home", home]);
  assert.equal(apply.code, 0);
  const applied = JSON.parse(apply.text) as { field: string; policy_version: string };
  assert.equal(applied.field, report.suggestions[0]?.field);
  assert.equal(applied.policy_version.length, 12);
});
