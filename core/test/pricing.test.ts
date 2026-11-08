import assert from "node:assert/strict";
import test from "node:test";
import { defaultPricing } from "../src/config.js";
import { priceUsage } from "../src/pricing.js";

function close(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `expected ${expected}, got ${actual} (difference ${Math.abs(actual - expected)})`,
  );
}

test("priceUsage prices normalised codex usage with the default table", () => {
  const priced = priceUsage(
    { input: 13239, cached_input: 0, output: 5, reasoning: 0 },
    "gpt-5.1-codex",
    defaultPricing(),
  );
  // 13239 * 1.25 + 0 * 0.125 + 5 * 10, per million tokens.
  close(priced.cost_usd, 0.01659875);
  assert.equal(priced.cost_unknown, false);
});

test("priceUsage prices normalised dsh usage with the default table", () => {
  const priced = priceUsage(
    { input: 1399, cached_input: 5248, output: 52, reasoning: 0 },
    "deepseek-v3.2",
    defaultPricing(),
  );
  // 1399 * 0.28 + 5248 * 0.028 + 52 * 0.42, per million tokens.
  close(priced.cost_usd, 0.000560504);
  assert.equal(priced.cost_unknown, false);
});

test("priceUsage returns zero and cost_unknown for a missing model", () => {
  const priced = priceUsage(
    { input: 1000, cached_input: 0, output: 10, reasoning: 0 },
    null,
    defaultPricing(),
  );
  assert.equal(priced.cost_usd, 0);
  assert.equal(priced.cost_unknown, true);
});

test("priceUsage returns zero and cost_unknown for an unpriced model", () => {
  const priced = priceUsage(
    { input: 1000, cached_input: 0, output: 10, reasoning: 0 },
    "not-in-the-table",
    defaultPricing(),
  );
  assert.equal(priced.cost_usd, 0);
  assert.equal(priced.cost_unknown, true);
});

test("priceUsage returns a known zero for empty usage", () => {
  const priced = priceUsage(
    { input: 0, cached_input: 0, output: 0, reasoning: 0 },
    "deepseek-v3.2",
    defaultPricing(),
  );
  assert.equal(priced.cost_usd, 0);
  assert.equal(priced.cost_unknown, false);
});
