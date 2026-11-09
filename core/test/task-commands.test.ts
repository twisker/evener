import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runCli } from "../src/cli.js";
import type { CliIO } from "../src/cli.js";
import { defaultPolicy } from "../src/config.js";
import { assignArm } from "../src/experiment.js";
import { computePreFeatures, repoFingerprint, repoRemoteUrl } from "../src/features.js";
import { labelHeuristic } from "../src/labeler.js";
import { matchesGlob } from "../src/commands/task.js";
import type { Label } from "../src/types.js";
import { sha256 } from "../src/util.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
}

interface Harness {
  io: CliIO;
  stdout(): string;
  stderr(): string;
}

function harness(options: HarnessOptions = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO & { fetchImpl?: typeof fetch } = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    env: options.env ?? {},
    cwd: process.cwd(),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  return {
    io,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

interface CliResult<T> {
  code: number;
  payload: T;
  stderr: string;
}

async function run<T>(
  argv: string[],
  options: HarnessOptions = {},
): Promise<CliResult<T>> {
  const h = harness(options);
  const code = await runCli(argv, h.io);
  const text = h.stdout();
  assert.ok(text.length > 0, `no output for ${argv.join(" ")}`);
  return { code, payload: JSON.parse(text) as T, stderr: h.stderr() };
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "evener-task-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function initHome(home: string): Promise<void> {
  const result = await run<{ db_path: string }>(["init", "--home", home]);
  assert.equal(result.code, 0);
  assert.equal(result.payload.db_path, join(home, "evener.sqlite"));
}

interface CreateOutput {
  task_id: string;
  analysis_label: Label;
  labeler_model: string;
  warnings: string[];
  pre_features: {
    description_chars: number;
    files_mentioned: number;
    repo_files: number | null;
    language: string | null;
    has_repro: boolean;
    cross_file: boolean;
    time_bucket: string;
  };
  policy_version: string;
  arm: string | null;
}

interface StatusOutput {
  task: {
    task_id: string;
    state: string;
    analysis_label: Label;
    rating: string | null;
    first_pass: number | null;
  };
  events: { type: string; data: Record<string, unknown> }[];
}

// ---------------------------------------------------------------------------
// Labeler / experiment / features
// ---------------------------------------------------------------------------

test("labelHeuristic follows the frozen first-match order", () => {
  const cases: [string, Label][] = [
    ["Fix the crash on startup", "bugfix"],
    ["Why does the build fail?", "question"],
    ["Rename all modules to kebab-case", "mechanical"],
    ["Refactor the parser loop", "refactor"],
    ["Add unit test coverage", "test"],
    ["Update the README and comments", "docs"],
    ["Implement a new feature flag", "feature"],
    ["Investigate the strange artifact", "unknown"],
    ["How do I add tests?", "question"],
    ["format the changelog", "mechanical"],
  ];
  for (const [description, expected] of cases) {
    assert.equal(labelHeuristic(description), expected, description);
  }
});

test("assignArm is null when off, deterministic when stratified, random otherwise", () => {
  const taskId = "0b62b7b1-3f2e-4bc5-9b5d-6d8c2f9e1a77";

  const off = defaultPolicy();
  assert.equal(assignArm(off, taskId, "bugfix"), null);

  const stratified = defaultPolicy();
  stratified.experiment.mode = "interleave";
  stratified.experiment.arms = { B: "b.yaml", A: "a.yaml" };
  stratified.experiment.assignment = "by_label_stratified";

  const first = assignArm(stratified, taskId, "bugfix");
  const second = assignArm(stratified, taskId, "bugfix");
  assert.equal(first, second);
  const arms = ["A", "B"];
  const expected = arms[parseInt(sha256(taskId).slice(0, 8), 16) % arms.length];
  assert.equal(first, expected);

  const random = defaultPolicy();
  random.experiment.mode = "interleave";
  random.experiment.arms = { A: "a.yaml", B: "b.yaml" };
  random.experiment.assignment = "random";
  const picked = assignArm(random, taskId, "bugfix");
  assert.ok(picked === "A" || picked === "B");
});

test("glob matching supports ** and *", () => {
  assert.equal(matchesGlob("secrets/token.txt", "**/secrets/**"), true);
  assert.equal(matchesGlob("a/b/secrets/token.txt", "**/secrets/**"), true);
  assert.equal(matchesGlob(".env.local", "**/.env*"), true);
  assert.equal(matchesGlob("config/.env", "**/.env*"), true);
  assert.equal(matchesGlob("src/a.ts", "**/secrets/**"), false);
  assert.equal(matchesGlob("src/a.ts", "src/*.ts"), true);
  assert.equal(matchesGlob("src/deep/a.ts", "src/*.ts"), false);
});

test("computePreFeatures counts the path union and stays null outside git", (t) => {
  const dir = tempDir(t);
  const description = "Fix src/a.ts and src/a.ts plus README.md";
  const features = computePreFeatures(description, ["src/a.ts"], dir);

  assert.equal(features.description_chars, description.length);
  assert.equal(features.files_mentioned, 2);
  assert.equal(features.repo_files, null);
  assert.equal(repoFingerprint(dir), null);
  assert.equal(repoRemoteUrl(dir), null);
});

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

test("task create round-trips through status and tasks", async (t) => {
  const home = tempDir(t);
  await initHome(home);

  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Add support for YAML config files", "utf8");

  const created = await run<CreateOutput>([
    "task",
    "create",
    "--home",
    home,
    "--description-file",
    descriptionFile,
    "--files",
    "src/config.ts",
    "--cwd",
    home,
  ]);
  assert.equal(created.code, 0);
  assert.equal(created.payload.analysis_label, "feature");
  assert.equal(created.payload.arm, null);
  assert.equal(created.payload.policy_version.length, 12);
  assert.equal(created.payload.pre_features.files_mentioned, 1);
  assert.equal(created.payload.pre_features.repo_files, null);
  assert.equal(created.payload.pre_features.language, "ts");
  assert.equal(created.payload.pre_features.has_repro, false);
  assert.equal(created.payload.pre_features.cross_file, false);
  assert.equal(created.payload.pre_features.time_bucket, "lt15m");

  const status = await run<StatusOutput>([
    "status",
    "--home",
    home,
    "--task",
    created.payload.task_id,
  ]);
  assert.equal(status.code, 0);
  assert.equal(status.payload.task.task_id, created.payload.task_id);
  assert.equal(status.payload.task.state, "created");
  assert.equal(status.payload.task.analysis_label, "feature");
  assert.equal(status.payload.events.length, 1);
  assert.equal(status.payload.events[0]?.type, "task.created");

  const listed = await run<{ tasks: { task_id: string }[] }>([
    "tasks",
    "--home",
    home,
    "--open",
  ]);
  assert.equal(listed.code, 0);
  assert.deepEqual(
    listed.payload.tasks.map((task) => task.task_id),
    [created.payload.task_id],
  );
});

test("task create uses the model labeler by default and reports no warnings", async (t) => {
  const home = tempDir(t);
  await initHome(home);

  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Fix the crash in src/main.ts", "utf8");

  const created = await run<CreateOutput>(
    [
      "task",
      "create",
      "--home",
      home,
      "--description-file",
      descriptionFile,
      "--cwd",
      home,
    ],
    {
      env: { DEEPSEEK_API_KEY: "env-secret" },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"label":"bugfix","time_bucket":"1h_4h","has_repro":true}',
                },
              },
            ],
            usage: { prompt_tokens: 176, completion_tokens: 23 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
  );

  assert.equal(created.code, 0);
  assert.equal(created.payload.labeler_model, "deepseek-flash");
  assert.deepEqual(created.payload.warnings, []);
  assert.equal(created.payload.analysis_label, "bugfix");
  assert.equal(created.payload.pre_features.time_bucket, "1h_4h");
  assert.equal(created.payload.pre_features.has_repro, true);
  assert.equal(created.stderr, "");

  const status = await run<StatusOutput>([
    "status",
    "--home",
    home,
    "--task",
    created.payload.task_id,
  ]);
  const data = status.payload.events[0]?.data;
  assert.ok(data !== undefined);
  assert.equal(data["labeler_model"], "deepseek-flash");
  assert.ok(Math.abs(Number(data["labeler_cost_usd"]) - 0.0000804) < 1e-12);
  assert.ok(Number(data["labeler_latency_ms"]) >= 0);
});

test("task create warns on stderr and exits 0 when the key is missing", async (t) => {
  const home = tempDir(t);
  await initHome(home);

  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Fix the crash in src/main.ts", "utf8");

  const created = await run<CreateOutput>([
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
  assert.equal(created.payload.labeler_model, "heuristic");
  assert.equal(created.payload.warnings.length, 1);
  assert.match(created.payload.warnings[0] ?? "", /no_key/);
  assert.match(created.stderr, /warning: .*no_key.*fell back to heuristic/);
  assert.equal(created.payload.analysis_label, "bugfix");
});

test("--quiet suppresses the labeler warning on stderr", async (t) => {
  const home = tempDir(t);
  await initHome(home);

  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Fix the crash in src/main.ts", "utf8");
  const createArgs = [
    "task",
    "create",
    "--description-file",
    descriptionFile,
    "--cwd",
    home,
  ];

  const quiet = harness();
  const quietCode = await runCli(["--home", home, "--quiet", ...createArgs], quiet.io);
  assert.equal(quietCode, 0);
  assert.equal(quiet.stderr(), "");
  assert.equal(quiet.stdout(), "");

  const loud = harness();
  const loudCode = await runCli(["--home", home, ...createArgs], loud.io);
  assert.equal(loudCode, 0);
  assert.match(loud.stderr(), /warning: labeler: no_key.*fell back to heuristic/);
  const payload = JSON.parse(loud.stdout()) as CreateOutput;
  assert.equal(payload.labeler_model, "heuristic");
  assert.match(payload.warnings[0] ?? "", /no_key/);
});

test("task create falls back to the heuristic has_repro when the model value is not boolean", async (t) => {
  const home = tempDir(t);
  await initHome(home);

  const descriptionFile = join(home, "description.txt");
  writeFileSync(
    descriptionFile,
    "Fix the crash on startup; stack trace attached",
    "utf8",
  );

  const created = await run<CreateOutput>(
    [
      "task",
      "create",
      "--home",
      home,
      "--description-file",
      descriptionFile,
      "--cwd",
      home,
    ],
    {
      env: { DEEPSEEK_API_KEY: "env-secret" },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"label":"bugfix","time_bucket":"15m_1h","has_repro":"yes"}',
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
  );

  assert.equal(created.code, 0);
  assert.equal(created.payload.labeler_model, "deepseek-flash");
  assert.equal(created.payload.pre_features.has_repro, true);
  assert.deepEqual(created.payload.warnings, []);
});

test("task create applies private_path and preserves user constraints", async (t) => {
  const home = tempDir(t);
  await initHome(home);

  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Change the deployment settings", "utf8");

  const created = await run<CreateOutput>([
    "task",
    "create",
    "--home",
    home,
    "--description-file",
    descriptionFile,
    "--files",
    "config/.env.production,src/main.ts",
    "--constraint",
    "from-host",
    "--cwd",
    home,
  ]);
  assert.equal(created.code, 0);

  const status = await run<StatusOutput>([
    "status",
    "--home",
    home,
    "--task",
    created.payload.task_id,
  ]);
  const data = status.payload.events[0]?.data;
  assert.ok(data !== undefined);
  assert.deepEqual(data["constraints"], ["from-host", "private_path"]);
});

test("event appends feedback and rejects malformed JSON with exit 1", async (t) => {
  const home = tempDir(t);
  await initHome(home);

  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Refactor the parser", "utf8");
  const created = await run<CreateOutput>([
    "task",
    "create",
    "--home",
    home,
    "--description-file",
    descriptionFile,
    "--cwd",
    home,
  ]);

  const bad = await run<{ error: { code: string } }>([
    "event",
    "--home",
    home,
    "--type",
    "user.feedback",
    "--task",
    created.payload.task_id,
    "--data",
    "{bad json",
  ]);
  assert.equal(bad.code, 1);
  assert.equal(bad.payload.error.code, "invalid_json");

  const good = await run<{ event_id: string }>([
    "event",
    "--home",
    home,
    "--type",
    "user.feedback",
    "--task",
    created.payload.task_id,
    "--data",
    '{"rating":"up","comment":null}',
  ]);
  assert.equal(good.code, 0);
  assert.equal(good.payload.event_id.length > 0, true);

  const status = await run<StatusOutput>([
    "status",
    "--home",
    home,
    "--task",
    created.payload.task_id,
  ]);
  assert.equal(status.payload.task.rating, "up");
  assert.equal(status.payload.events.length, 2);

  const unknownType = await run<{ error: { code: string } }>([
    "event",
    "--home",
    home,
    "--type",
    "not.an.event",
    "--task",
    created.payload.task_id,
    "--data",
    "{}",
  ]);
  assert.equal(unknownType.code, 1);
  assert.equal(unknownType.payload.error.code, "invalid_event");
});

test("rebuild reports the number of projected tasks", async (t) => {
  const home = tempDir(t);
  await initHome(home);

  const descriptionFile = join(home, "description.txt");
  writeFileSync(descriptionFile, "Rename all files", "utf8");
  const created = await run<CreateOutput>([
    "task",
    "create",
    "--home",
    home,
    "--description-file",
    descriptionFile,
    "--cwd",
    home,
  ]);

  const rebuilt = await run<{ tasks: number }>(["rebuild", "--home", home]);
  assert.equal(rebuilt.code, 0);
  assert.equal(rebuilt.payload.tasks, 1);

  const status = await run<StatusOutput>([
    "status",
    "--home",
    home,
    "--task",
    created.payload.task_id,
  ]);
  assert.equal(status.payload.task.state, "created");
});
