/**
 * Usage pricing (spec §7).
 *
 * `input` already excludes cached tokens for both adapters: the codex adapter
 * subtracts `cached_input_tokens`, and dsh's `inputTokens` never includes cache
 * reads (S2/S6). The three components are therefore disjoint and are simply
 * summed at the model's per-million-token prices.
 *
 * A model price may name a peak schedule. Prices in `pricing.yaml` are the
 * off-peak/list price; inside a schedule window the cost is multiplied by its
 * `factor`. Public holidays are not modelled: only weekday and local clock
 * time decide the tier.
 */

import type { NormalisedUsage, PeakSchedule, Pricing, PricingPeriod } from "./types.js";

export interface UsagePrice {
  cost_usd: number;
  /** True when the model is unknown or the price table has no entry for it. */
  cost_unknown: boolean;
  /** Which tier the recorded cost used; `flat` means no peak schedule. */
  pricing_period: PricingPeriod;
}

const TOKENS_PER_MILLION = 1_000_000;

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

const TIME_WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(hour: number, minute: number): number {
  return hour * 60 + minute;
}

function parseWindow(window: string): { start: number; end: number } | null {
  const match = TIME_WINDOW.exec(window.trim());
  if (match === null) return null;
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return null;
  const start = minutes(startHour, startMinute);
  const end = minutes(endHour, endMinute);
  if (start >= end) return null;
  return { start, end };
}

/**
 * Classify an instant against a peak schedule.
 *
 * Returns `flat` when the model has no schedule. Weekdays are Monday–Friday in
 * the schedule's local time zone. Public holidays are deliberately not modelled
 * in v1 (spec §5).
 */
export function pricingPeriod(schedule: PeakSchedule | null, at: Date): PricingPeriod {
  if (schedule === null) return "flat";

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.tz,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);
  } catch {
    // An invalid time zone is rejected by config validation; a hand-built
    // Pricing object may still reach here, in which case flat is safest.
    return "flat";
  }

  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  if (schedule.weekdays_only && !WEEKDAYS.has(weekday)) return "off";

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "off";

  const local = minutes(hour, minute);
  for (const window of schedule.windows) {
    const parsed = parseWindow(window);
    if (parsed === null) continue;
    if (local >= parsed.start && local < parsed.end) return "peak";
  }
  return "off";
}

/** Schedule named by a model or inline price, or null when unavailable. */
export function peakSchedule(
  pricing: Pricing | undefined,
  name: string | undefined | null,
): PeakSchedule | null {
  if (pricing === undefined || name === undefined || name === null) return null;
  const schedules = pricing.peak_schedules;
  if (schedules === undefined) return null;
  return schedules[name] ?? null;
}

/**
 * Price normalised usage for `model` at `at`.
 *
 * A missing model or price yields `{cost_usd: 0, cost_unknown: true}` so the
 * caller can record the zero cost while flagging that it is not comparable.
 */
export function priceUsage(
  usage: NormalisedUsage,
  model: string | null,
  pricing: Pricing,
  at: Date = new Date(),
): UsagePrice {
  if (model === null) {
    return { cost_usd: 0, cost_unknown: true, pricing_period: "flat" };
  }

  const price = pricing.models[model];
  if (price === undefined) {
    return { cost_usd: 0, cost_unknown: true, pricing_period: "flat" };
  }

  const schedule = peakSchedule(pricing, price.peak);
  const period = pricingPeriod(schedule, at);
  const multiplier = period === "peak" && schedule !== null ? schedule.factor : 1;

  const cost =
    ((usage.input * price.input_per_mtok +
      usage.cached_input * price.cached_input_per_mtok +
      usage.output * price.output_per_mtok) /
      TOKENS_PER_MILLION) *
    multiplier;

  return { cost_usd: cost, cost_unknown: false, pricing_period: period };
}
