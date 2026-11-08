import assert from "node:assert/strict";
import test from "node:test";
import {
  logCostCI,
  mdd,
  mean,
  normalQuantile,
  pooledSd,
  quantile,
  studentTCdf,
  studentTQuantile,
  variance,
  welchT,
} from "../src/stats.js";

test("normalQuantile matches textbook critical values", () => {
  assert.ok(Math.abs(normalQuantile(0.975) - 1.95996) < 1e-5);
  assert.ok(Math.abs(normalQuantile(0.95) - 1.64485) < 1e-4);
  assert.ok(Math.abs(normalQuantile(0.5)) < 1e-12);
  assert.equal(normalQuantile(0), Number.NEGATIVE_INFINITY);
  assert.equal(normalQuantile(1), Number.POSITIVE_INFINITY);
});

test("mean, sample variance and interpolated quantiles", () => {
  const xs = [1, 2, 3, 4, 5];
  assert.equal(mean(xs), 3);
  assert.equal(variance(xs), 2.5);
  assert.equal(variance([7]), 0);
  assert.equal(quantile(xs, 0.5), 3);
  assert.equal(quantile(xs, 0), 1);
  assert.equal(quantile(xs, 1), 5);
  assert.equal(quantile([1, 10], 0.25), 3.25);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test("welchT on a known sample matches the reference two-sided p", () => {
  // Reference p computed independently by numerical integration of the
  // Student-t density: 0.107531...
  const result = welchT([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.ok(Math.abs(result.t - -1.8973665961) < 1e-9);
  assert.ok(Math.abs(result.df - 5.8823529412) < 1e-9);
  assert.ok(Math.abs(result.p - 0.107531) < 1e-3);
});

test("welchT handles equal samples and insufficient samples", () => {
  const equal = welchT([1, 2, 3], [1, 2, 3]);
  assert.equal(equal.t, 0);
  assert.equal(equal.p, 1);

  const insufficient = welchT([1], [2, 3, 4]);
  assert.equal(insufficient.p, 1);
});

test("Student-t CDF and inverse are consistent", () => {
  for (const df of [1, 3, 5.5, 30]) {
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const x = studentTQuantile(p, df);
      assert.ok(Math.abs(studentTCdf(x, df) - p) < 1e-8, `df=${df} p=${p}`);
    }
  }
});

test("logCostCI reports the geometric-mean ratio and a bracketing 90% CI", () => {
  const result = logCostCI([1, 2, 3], [2, 4, 6], 0.1);
  assert.ok(Math.abs(result.ratio - 0.5) < 1e-12);
  assert.ok(result.lo < result.ratio);
  assert.ok(result.hi > result.ratio);
});

test("MDD follows the normal approximation and shrinks with sample size", () => {
  const small = mdd(12, 12, 0.8, 0.1, 0.8);
  const doubled = mdd(24, 24, 0.8, 0.1, 0.8);
  assert.ok(small > doubled);
  assert.ok(doubled > 0);

  const expected =
    Math.exp((normalQuantile(0.95) + normalQuantile(0.8)) * 0.8 * Math.sqrt(2 / 12)) - 1;
  assert.ok(Math.abs(small - expected) < 1e-12);
  assert.equal(mdd(10, 10, 0, 0.1, 0.8), 0);
});

test("pooledSd combines two samples", () => {
  const sd = pooledSd([1, 2, 3], [3, 4, 5]);
  assert.ok(Math.abs(sd - 1) < 1e-9);
});
