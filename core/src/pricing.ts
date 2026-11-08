/**
 * Usage pricing (spec §7).
 *
 * `input` already excludes cached tokens for both adapters: the codex adapter
 * subtracts `cached_input_tokens`, and dsh's `inputTokens` never includes cache
 * reads (S2/S6). The three components are therefore disjoint and are simply
 * summed at the model's per-million-token prices.
 */

import type { NormalisedUsage, Pricing } from "./types.js";

export interface UsagePrice {
  cost_usd: number;
  /** True when the model is unknown or the price table has no entry for it. */
  cost_unknown: boolean;
}

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Price normalised usage for `model`.
 *
 * A missing model or price yields `{cost_usd: 0, cost_unknown: true}` so the
 * caller can record the zero cost while flagging that it is not comparable.
 */
export function priceUsage(
  usage: NormalisedUsage,
  model: string | null,
  pricing: Pricing,
): UsagePrice {
  if (model === null) return { cost_usd: 0, cost_unknown: true };

  const price = pricing.models[model];
  if (price === undefined) return { cost_usd: 0, cost_unknown: true };

  const cost =
    (usage.input * price.input_per_mtok +
      usage.cached_input * price.cached_input_per_mtok +
      usage.output * price.output_per_mtok) /
    TOKENS_PER_MILLION;

  return { cost_usd: cost, cost_unknown: false };
}
