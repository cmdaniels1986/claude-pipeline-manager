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

/**
 * Short, tab-sized model name, e.g. "Opus 4.8", "Sonnet 4.6", "Haiku 4.5",
 * "Fable 5". Accepts full model ids (claude-opus-4-8[1m]), Claude Code's short
 * aliases (opus/sonnet/haiku) or plan aliases (opusplan). Returns null when the
 * model is unknown or the default (nothing worth badging).
 */
export function modelLabel(raw: string | undefined): string | null {
  if (!raw) return null
  const m = raw.toLowerCase().trim()
  if (!m || m === 'default') return null
  const family = m.includes('opus')
    ? 'Opus'
    : m.includes('sonnet')
      ? 'Sonnet'
      : m.includes('haiku')
        ? 'Haiku'
        : m.includes('fable')
          ? 'Fable'
          : m.includes('mythos')
            ? 'Mythos'
            : null
  if (!family) {
    // unrecognized id — show a trimmed form rather than nothing
    return raw.replace(/^claude-/, '').replace(/\[[^\]]*\]$/, '').trim() || null
  }
  // "4-8"/"4.8"/"3-5" → "4.8"/"3.5"; else a solo version like fable-5 → "5"
  const ver = /(\d+)[-.](\d+)/.exec(m)
  if (ver) return `${family} ${ver[1]}.${ver[2]}`
  const solo = /(?:opus|sonnet|haiku|fable|mythos)-?(\d+)(?![-.\d])/.exec(m)
  return solo ? `${family} ${solo[1]}` : family
}

/** Compact tab badge: cost when known (the truest "how much has this burned"),
 *  else a token total. Prefixed ≈ when the cost is notional (subscription). */
export function usageBadge(u: TermUsage, billingReal: boolean): string {
  const c = fmtCost(u.costUsd)
  if (c) return billingReal ? c : `≈${c}`
  return fmtTokens(totalTokens(u))
}

export interface SessionTotals {
  /** summed USD across sessions that reported a cost; null when none did */
  cost: number | null
  tokens: number
  /** number of terminals that have reported any usage this app session */
  terminals: number
}

/** Totals across every terminal that has reported usage since the app opened.
 *  The store keeps a terminal's last usage even after its tab closes, so this
 *  reflects the whole app session, not just the terminals still open. */
export function sessionTotals(usage: Record<string, TermUsage>): SessionTotals {
  let cost = 0
  let hasCost = false
  let tokens = 0
  let terminals = 0
  for (const u of Object.values(usage)) {
    terminals++
    tokens += totalTokens(u)
    if (u.costUsd != null) {
      cost += u.costUsd
      hasCost = true
    }
  }
  return { cost: hasCost ? cost : null, tokens, terminals }
}

/** Header pill text for the whole-session total: cost (≈ when notional) + tokens. */
export function sessionBadge(t: SessionTotals, billingReal: boolean): string {
  const c = fmtCost(t.cost)
  const money = c ? (billingReal ? c : `≈${c}`) : null
  const toks = `${fmtTokens(t.tokens)} tok`
  return money ? `${money} · ${toks}` : toks
}
