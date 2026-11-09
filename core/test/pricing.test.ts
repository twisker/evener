import assert from "node:assert/strict";
import test from "node:test";
import { defaultPricing } from "../src/config.js";
import { priceUsage, pricingPeriod } from "../src/pricing.js";
import type { PeakSchedule } from "../src/types.js";

function close(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `expected ${expected}, got ${actual} (difference ${Math.abs(actual - expected)})`,
  );
}

// 2026-11-10 is a Tuesday; 2026-11-14 is a Saturday. Asia/Shanghai is UTC+8
// year-round, so these instants are machine-independent.
const TUESDAY_PEAK = new Date("2026-11-10T02:30:00.000Z"); // 10:30 Shanghai
const TUESDAY_OFF = new Date("2026-11-10T05:00:00.000Z"); // 13:00 Shanghai
const SATURDAY = new Date("2026-11-14T02:30:00.000Z"); // 10:30 Shanghai
const MONDAY_EARLY = new Date("2026-11-09T00:00:00.000Z"); // 08:00 Shanghai

const DEEPSEEK: PeakSchedule = {
  tz: "Asia/Shanghai",
  windows: ["09:00-12:00", "14:00-18:00"],
  weekdays_only: true,
  factor: 2,
};

test("pricingPeriod classifies local weekday windows", () => {
  assert.equal(pricingPeriod(DEEPSEEK, TUESDAY_PEAK), "peak");
  assert.equal(pricingPeriod(DEEPSEEK, TUESDAY_OFF), "off");
  assert.equal(pricingPeriod(DEEPSEEK, SATURDAY), "off");
  assert.equal(pricingPeriod(DEEPSEEK, MONDAY_EARLY), "off");
});

test("pricingPeriod is flat without a schedule", () => {
  assert.equal(pricingPeriod(null, TUESDAY_PEAK), "flat");
});

test("a schedule with weekdays_only false also peaks at the weekend", () => {
  assert.equal(pricingPeriod({ ...DEEPSEEK, weekdays_only: false }, SATURDAY), "peak");
});

test("priceUsage prices normalised codex usage with the default table", () => {
  const priced = priceUsage(
    { input: 13239, cached_input: 0, output: 5, reasoning: 0 },
    "gpt-5.1-codex",
    defaultPricing(),
    TUESDAY_PEAK,
  );
  // 13239 * 1.25 + 0 * 0.125 + 5 * 10, per million tokens.
  close(priced.cost_usd, 0.01659875);
  assert.equal(priced.cost_unknown, false);
  assert.equal(priced.pricing_period, "flat");
});

test("priceUsage prices normalised dsh usage at the off-peak list price", () => {
  const priced = priceUsage(
    { input: 1399, cached_input: 5248, output: 52, reasoning: 0 },
    "deepseek-flash",
    defaultPricing(),
    MONDAY_EARLY,
  );
  // 1399 * 0.15 + 5248 * 0.003 + 52 * 0.60, per million tokens.
  close(priced.cost_usd, 0.000256794);
  assert.equal(priced.cost_unknown, false);
  assert.equal(priced.pricing_period, "off");
});

test("priceUsage doubles the cost inside a peak window and leaves it alone outside", () => {
  const usage = { input: 1399, cached_input: 5248, output: 52, reasoning: 0 };
  const peak = priceUsage(usage, "deepseek-flash", defaultPricing(), TUESDAY_PEAK);
  const off = priceUsage(usage, "deepseek-flash", defaultPricing(), TUESDAY_OFF);

  assert.equal(peak.pricing_period, "peak");
  assert.equal(off.pricing_period, "off");
  close(peak.cost_usd, off.cost_usd * 2);
  close(peak.cost_usd, 0.000513588);
});

test("gpt-5.1-codex has no peak schedule and is always flat", () => {
  const usage = { input: 1000, cached_input: 0, output: 10, reasoning: 0 };
  const priced = priceUsage(usage, "gpt-5.1-codex", defaultPricing(), TUESDAY_PEAK);
  assert.equal(priced.pricing_period, "flat");
  close(priced.cost_usd, (1000 * 1.25 + 10 * 10) / 1_000_000);
});

test("priceUsage returns zero and cost_unknown for a missing model", () => {
  const priced = priceUsage(
    { input: 1000, cached_input: 0, output: 10, reasoning: 0 },
    null,
    defaultPricing(),
    TUESDAY_PEAK,
  );
  assert.equal(priced.cost_usd, 0);
  assert.equal(priced.cost_unknown, true);
  assert.equal(priced.pricing_period, "flat");
});

test("priceUsage returns zero and cost_unknown for an unpriced model", () => {
  const priced = priceUsage(
    { input: 1000, cached_input: 0, output: 10, reasoning: 0 },
    "not-in-the-table",
    defaultPricing(),
    TUESDAY_PEAK,
  );
  assert.equal(priced.cost_usd, 0);
  assert.equal(priced.cost_unknown, true);
});

test("priceUsage returns a known zero for empty usage", () => {
  const priced = priceUsage(
    { input: 0, cached_input: 0, output: 0, reasoning: 0 },
    "deepseek-flash",
    defaultPricing(),
    MONDAY_EARLY,
  );
  assert.equal(priced.cost_usd, 0);
  assert.equal(priced.cost_unknown, false);
  assert.equal(priced.pricing_period, "off");
});
