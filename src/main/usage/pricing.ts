/**
 * Per-million-token pricing (USD) for estimating session cost. Cache-write is
 * 1.25x input (5-minute TTL), cache-read is 0.1x input. Matched by model-id
 * prefix so dated/suffixed variants (e.g. claude-opus-4-8[1m]) still resolve.
 * Prices are estimates for display only — subscriptions (Max/Pro) don't bill
 * per token; this shows consumption, not a charge.
 */
interface Rate {
  input: number
  output: number
}

const RATES: { prefix: string; rate: Rate }[] = [
  { prefix: 'claude-fable-5', rate: { input: 10, output: 50 } },
  { prefix: 'claude-mythos-5', rate: { input: 10, output: 50 } },
  { prefix: 'claude-opus-4-8', rate: { input: 5, output: 25 } },
  { prefix: 'claude-opus-4-7', rate: { input: 5, output: 25 } },
  { prefix: 'claude-opus-4-6', rate: { input: 5, output: 25 } },
  { prefix: 'claude-opus-4-5', rate: { input: 5, output: 25 } },
  { prefix: 'claude-opus', rate: { input: 5, output: 25 } },
  { prefix: 'claude-sonnet-4-6', rate: { input: 3, output: 15 } },
  { prefix: 'claude-sonnet', rate: { input: 3, output: 15 } },
  { prefix: 'claude-haiku-4-5', rate: { input: 1, output: 5 } },
  { prefix: 'claude-haiku', rate: { input: 1, output: 5 } }
]

/**
 * Cache-write premium over base input price. The TTL Claude Code requests differs
 * by billing mode, so the multiplier does too: a subscription (Max/Pro) gets the
 * 1-hour TTL (2×), an API key gets the 5-minute TTL (1.25×). Read is always 0.1×.
 */
export const CACHE_WRITE_MULT_5MIN = 1.25
export const CACHE_WRITE_MULT_1H = 2
const CACHE_READ_MULT = 0.1

/** The cache-write multiplier Claude Code actually incurs for this billing mode. */
export function cacheWriteMultFor(billingReal: boolean): number {
  return billingReal ? CACHE_WRITE_MULT_5MIN : CACHE_WRITE_MULT_1H
}

export interface TokenTotals {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

function rateFor(model: string | undefined): Rate | null {
  if (!model) return null
  const m = model.toLowerCase()
  return RATES.find((r) => m.startsWith(r.prefix))?.rate ?? null
}

/** Estimated USD cost for accumulated token totals on a model. Null if the
 *  model isn't in the pricing table. `cacheWriteMult` defaults to the 5-minute
 *  TTL premium; pass `cacheWriteMultFor(billingReal)` to match a subscription. */
export function estimateCost(
  model: string | undefined,
  t: TokenTotals,
  cacheWriteMult: number = CACHE_WRITE_MULT_5MIN
): number | null {
  const rate = rateFor(model)
  if (!rate) return null
  const perM = (n: number, price: number): number => (n / 1_000_000) * price
  return (
    perM(t.input, rate.input) +
    perM(t.output, rate.output) +
    perM(t.cacheCreation, rate.input * cacheWriteMult) +
    perM(t.cacheRead, rate.input * CACHE_READ_MULT)
  )
}

/** Fraction (0..1) of this token mix's estimated cost that is OUTPUT tokens.
 *  Output bills ~5x input, so a high fraction means response volume — not the
 *  re-sent context — is what's driving spend. Null if the model isn't priced
 *  or the mix has no cost. */
export function outputCostFraction(
  model: string | undefined,
  t: TokenTotals,
  cacheWriteMult: number = CACHE_WRITE_MULT_5MIN
): number | null {
  const rate = rateFor(model)
  if (!rate) return null
  const perM = (n: number, price: number): number => (n / 1_000_000) * price
  const outputCost = perM(t.output, rate.output)
  const inputCost =
    perM(t.input, rate.input) +
    perM(t.cacheCreation, rate.input * cacheWriteMult) +
    perM(t.cacheRead, rate.input * CACHE_READ_MULT)
  const total = outputCost + inputCost
  return total > 0 ? outputCost / total : null
}
