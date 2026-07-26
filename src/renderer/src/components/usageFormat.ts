import type { TermUsage } from '../../../shared/types'

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function fmtCost(usd: number | null): string | null {
  if (usd == null) return null
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** all tokens that count toward usage/limits (input side + output) */
export function totalTokens(u: TermUsage): number {
  return u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens + u.outputTokens
}
