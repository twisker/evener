import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  computePreFeatures,
  DEFAULT_TIME_BUCKET_HEURISTIC,
  detectLanguage,
  hasRepro,
  HAS_REPRO_PATTERNS,
  timeBucketHeuristic,
} from "../src/features.js";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "evener-features-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("language is the most frequent extension across files and description tokens", (t) => {
  const dir = tempDir(t);
  const description = "Fix src/a.ts and src/b.py; compare with lib/helper.ts";
  const features = computePreFeatures(description, ["src/c.ts", "src/d.py"], dir);

  assert.equal(features.language, "ts");
  assert.equal(detectLanguage("see src/b.py and README.md", []), "py");
  // A tie keeps the first path seen: explicit files are considered before tokens.
  assert.equal(detectLanguage("see src/b.py", ["src/a.ts"]), "ts");
  assert.equal(detectLanguage("no paths here", []), null);
  assert.equal(detectLanguage("open config/.env.production", []), "other");
});

test("has_repro enumerates every signal, including Chinese and fenced errors", () => {
  const samples = [
    "This is reproducible on main",
    "repro steps are below",
    "the failing test is in store.test.ts",
    "here is the stack trace",
    "Traceback (most recent call last)",
    "steps to trigger the bug",
    "expected 3 but got 4",
    "复现方式如下",
    "运行时报错",
    "堆栈信息如下",
    "```\nError: boom\n```",
  ];

  assert.equal(samples.length, HAS_REPRO_PATTERNS.length);
  HAS_REPRO_PATTERNS.forEach((pattern, index) => {
    const sample = samples[index] ?? "";
    assert.equal(pattern.test(sample), true, `pattern ${index} did not match ${sample}`);
  });

  assert.equal(hasRepro("reproducible"), true);
  assert.equal(hasRepro("这里可以复现"), true);
  assert.equal(hasRepro("```\nException: nope\n```"), true);
  assert.equal(hasRepro("Add a new feature flag"), false);
  assert.equal(hasRepro("```\nconsole.log(1)\n```"), false);
  assert.equal(hasRepro("Error: no fence"), false);
});

test("cross_file follows files_mentioned", (t) => {
  const dir = tempDir(t);
  const single = computePreFeatures("Update src/a.ts", [], dir);
  assert.equal(single.files_mentioned, 1);
  assert.equal(single.cross_file, false);

  const multi = computePreFeatures("Update src/a.ts and src/b.ts", [], dir);
  assert.equal(multi.files_mentioned, 2);
  assert.equal(multi.cross_file, true);

  const explicit = computePreFeatures("Update the module", ["src/a.ts", "src/b.ts"], dir);
  assert.equal(explicit.cross_file, true);
});

test("timeBucketHeuristic picks the first bucket whose file and char limits both hold", () => {
  const thresholds = DEFAULT_TIME_BUCKET_HEURISTIC;
  const cases: [number, number, string][] = [
    [1, 400, "lt15m"],
    [1, 401, "15m_1h"],
    [2, 400, "15m_1h"],
    [3, 1500, "15m_1h"],
    [3, 1501, "1h_4h"],
    [4, 1500, "1h_4h"],
    [8, 5000, "1h_4h"],
    [8, 5001, "gt4h"],
    [9, 100, "gt4h"],
  ];

  for (const [files, chars, expected] of cases) {
    assert.equal(
      timeBucketHeuristic({ files_mentioned: files, description_chars: chars }, thresholds),
      expected,
      `files=${files} chars=${chars}`,
    );
  }
});

test("computePreFeatures records the policy heuristic on the feature bundle", (t) => {
  const dir = tempDir(t);
  const thresholds = {
    lt15m: { max_files: 2, max_chars: 20 },
    "15m_1h": { max_files: 3, max_chars: 100 },
    "1h_4h": { max_files: 8, max_chars: 500 },
  };
  const features = computePreFeatures("Fix a.ts", ["a.ts"], dir, thresholds);

  assert.equal(features.time_bucket, "lt15m");
  assert.equal(features.language, "ts");
  assert.equal(features.has_repro, false);
  assert.equal(features.cross_file, true);
});
