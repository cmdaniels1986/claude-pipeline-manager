import type { CostSuggestion, CostSuggestionKind } from '../../shared/types'
import { estimateCost, outputCostFraction, type TokenTotals } from './pricing'

/**
 * A single cumulative token snapshot of a session at time `t`. The OTEL feed
 * exports delta counters every ~10s which the UsageTracker accumulates, so each
 * sample is the running total; the delta between consecutive samples is roughly
 * one active turn's tokens. Chronological, latest last.
 */
export interface UsageSample {
  t: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  cost: number | null
  model?: string
}

export interface AnalyzeInput {
  termId: string
  now: number
  /** true = per-token API billing (real $); false = subscription (limit headroom) */
  billingReal: boolean
  history: UsageSample[]
}

// ---- thresholds (single place to tune) ------------------------------------
// Deliberately conservative: the whole game is NOT crying wolf. A healthy,
// well-cached, short session must produce zero suggestions.
const MIN_SAMPLES = 6 // ~1 min of 10s exports before we judge caching
const MIN_MINUTES = 3 // and at least this long, so first-turn skew washes out

const CACHE_MIN_PROMPT = 60_000 // only judge caching once real context is flowing
const CACHE_OFF_SHARE = 0.05 // cache activity < 5% of prompt tokens = effectively off
const THRASH_MIN_CREATION = 40_000 // writing this much cache…
const THRASH_READ_RATIO = 0.4 // …but reading back < 40% of it = prefix thrashing

const BLOAT_MIN_MINUTES = 30 // an un-cleared session must be genuinely long
const BLOAT_MIN_CONTEXT = 160_000 // and recent turns must carry a large context
const BLOAT_HIGH_CONTEXT = 400_000 // above this it's a high-severity drain

// model right-sizing (Opus → Sonnet). SUGGEST only — telemetry can't know a turn
// needed Opus, so this is gated hard and framed as a prompt, never auto-applied.
const RIGHTSIZE_MIN_TURNS = 8 // enough qualifying turns to judge the profile
const RIGHTSIZE_MIN_PROMPT = 60_000 // real context flowing, so the saving isn't a nit
const RIGHTSIZE_LIGHT_P95_OUTPUT = 2000 // even the HARDEST recent turn generated < this
// re-price the same token mix at these tiers to get an honest counterfactual range
const RIGHTSIZE_SONNET = 'claude-sonnet-4-6' // safer step down (~0.6× Opus)
const RIGHTSIZE_HAIKU = 'claude-haiku-4-5' // cheapest, but riskier for hard coding
const RIGHTSIZE_OPUS = 'claude-opus-4-8' // reference for the counterfactual

// verbose output — responses dominate spend (output bills ~5× input)
const VERBOSE_MIN_OUTPUT = 50_000 // enough total output to be worth a nudge
const VERBOSE_MIN_PER_TURN = 6_000 // mean response length is genuinely large
const VERBOSE_MIN_COST_SHARE = 0.5 // and output is at least half of estimated spend

/** k-formatted token count for evidence lines, e.g. 182345 -> "182k". */
function k(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(Math.round(n))
}

/** The biggest single active turn's context, approximated from the largest
 *  positive delta of (input + cacheRead + cacheCreation) between samples. */
function recentTurnContext(h: UsageSample[]): number {
  let max = 0
  for (let i = 1; i < h.length; i++) {
    const d =
      h[i].input - h[i - 1].input + (h[i].cacheRead - h[i - 1].cacheRead) + (h[i].cacheCreation - h[i - 1].cacheCreation)
    if (d > max) max = d
  }
  return max
}

/** Per-turn output token counts, from positive output deltas between samples.
 *  Each producing turn shows up as one jump; count ≈ turns that generated text. */
function perTurnOutputs(h: UsageSample[]): number[] {
  const outs: number[] = []
  for (let i = 1; i < h.length; i++) {
    const d = h[i].output - h[i - 1].output
    if (d > 0) outs.push(d)
  }
  return outs
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0
}

/** Nearest-rank percentile — used to judge the HARDEST recent turn, not the
 *  mean (§3.4: rightsize on the peak so a p95 spike keeps you off a cheaper tier). */
function percentile(a: number[], p: number): number {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const totalsOf = (s: UsageSample): TokenTotals => ({
  input: s.input,
  output: s.output,
  cacheCreation: s.cacheCreation,
  cacheRead: s.cacheRead
})

const SEV_RANK: Record<CostSuggestion['severity'], number> = { high: 0, medium: 1, low: 2 }

/** Rank: severity bucket first, then larger potential savings. */
export function compareSuggestions(a: CostSuggestion, b: CostSuggestion): number {
  return SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.savingsHighPct - a.savingsHighPct
}

function mk(
  termId: string,
  kind: CostSuggestionKind,
  s: Omit<CostSuggestion, 'id' | 'termId' | 'kind'>
): CostSuggestion {
  return { id: `${termId}:${kind}`, termId, kind, ...s }
}

/**
 * Pure analysis: given a session's token history, return the cost suggestions
 * that currently apply (0..n). No I/O, no clock of its own (`now` is passed in),
 * so it's deterministically testable. Callers layer dedup/hysteresis/dismissal
 * on top (see CostAdvisor).
 */
export function analyze(inp: AnalyzeInput): CostSuggestion[] {
  const h = inp.history
  const cur = h[h.length - 1]
  if (!cur || h.length < 2) return []

  const durMin = (inp.now - h[0].t) / 60_000
  const totalPrompt = cur.input + cur.cacheRead + cur.cacheCreation
  const cacheActivity = cur.cacheRead + cur.cacheCreation
  const cacheShare = totalPrompt > 0 ? cacheActivity / totalPrompt : 0
  const readRatio = cacheActivity > 0 ? cur.cacheRead / cacheActivity : 0
  const enoughEvidence = h.length >= MIN_SAMPLES && durMin >= MIN_MINUTES

  const out: CostSuggestion[] = []

  // --- cache health (highest-confidence, telemetry-native) ---
  // "off" supersedes "thrash" — showing both would be redundant noise.
  if (enoughEvidence && totalPrompt > CACHE_MIN_PROMPT && cacheShare < CACHE_OFF_SHARE) {
    out.push(
      mk(inp.termId, 'cache_off', {
        severity: 'high',
        finding: 'Prompt caching is essentially off this session',
        detail:
          'The repeated context is billed at full price every turn. Cache reads cost ~10× less — keep a stable prompt prefix and let the cache build.',
        savingsLowPct: 30,
        savingsHighPct: 80,
        basis: 'cache reads bill at 0.1× input vs full price for the reused context',
        confidence: 'high',
        evidence: [
          `${k(cacheActivity)} cache tokens out of ${k(totalPrompt)} prompt tokens (${Math.round(cacheShare * 100)}%)`,
          `session running ~${Math.round(durMin)} min`
        ]
      })
    )
  } else if (
    enoughEvidence &&
    cur.cacheCreation > THRASH_MIN_CREATION &&
    readRatio < THRASH_READ_RATIO &&
    totalPrompt > CACHE_MIN_PROMPT
  ) {
    out.push(
      mk(inp.termId, 'cache_thrash', {
        severity: 'medium',
        finding: 'Your prompt cache is being re-written, not reused',
        detail:
          'Something in the prompt prefix changes each turn (a timestamp, a shifting tool set), so the cache is written but rarely read. A stable prefix reuses it at ~10× less.',
        savingsLowPct: 20,
        savingsHighPct: 50,
        basis: 'cache writes cost 1.25–2× input; reads cost 0.1×',
        confidence: 'high',
        evidence: [
          `${k(cur.cacheCreation)} cache writes vs ${k(cur.cacheRead)} reads (read ratio ${Math.round(readRatio * 100)}%)`
        ]
      })
    )
  }

  // --- un-cleared long session / context bloat ---
  const turnCtx = recentTurnContext(h)
  if (durMin >= BLOAT_MIN_MINUTES && turnCtx >= BLOAT_MIN_CONTEXT) {
    const high = turnCtx >= BLOAT_HIGH_CONTEXT
    out.push(
      mk(inp.termId, 'context_bloat', {
        severity: high ? 'high' : 'medium',
        finding: 'This session carries a large context, re-sent every turn',
        detail: inp.billingReal
          ? `Recent turns carry ~${k(turnCtx)} tokens, re-sent as input on every message. If your next task is unrelated, /clear (free) resets it; mid-task, /compact.`
          : `Recent turns carry ~${k(turnCtx)} tokens, re-sent every message — that's a big slice of your usage limit per turn. If your next task is unrelated, /clear (free) resets it; mid-task, /compact.`,
        savingsLowPct: 40,
        savingsHighPct: 80,
        basis: `the model is stateless, so the full ~${k(turnCtx)}-token context is re-billed as input each turn`,
        confidence: 'med',
        evidence: [
          `recent-turn context ~${k(turnCtx)} tokens`,
          `session running ~${Math.round(durMin)} min with no reset`
        ],
        action: { label: 'Send /clear', kind: 'inject_clear', reversible: false }
      })
    )
  }

  // --- model right-sizing: on Opus, but even the hardest recent turn is light ---
  // Two-axis (§3.1): high SAVINGS, but LOW confidence — telemetry can't tell if a
  // turn needed Opus, so we only flag the opportunity and let the user decide.
  const outputs = perTurnOutputs(h)
  const turns = outputs.length
  const onOpus = (cur.model ?? '').toLowerCase().startsWith('claude-opus')
  if (
    onOpus &&
    enoughEvidence &&
    turns >= RIGHTSIZE_MIN_TURNS &&
    totalPrompt >= RIGHTSIZE_MIN_PROMPT &&
    percentile(outputs, 95) <= RIGHTSIZE_LIGHT_P95_OUTPUT
  ) {
    const t = totalsOf(cur)
    const opus = estimateCost(RIGHTSIZE_OPUS, t)
    const sonnet = estimateCost(RIGHTSIZE_SONNET, t)
    const haiku = estimateCost(RIGHTSIZE_HAIKU, t)
    if (opus && opus > 0 && sonnet != null && haiku != null) {
      const sonnetPct = Math.round((1 - sonnet / opus) * 100)
      const haikuPct = Math.round((1 - haiku / opus) * 100)
      if (sonnetPct > 0) {
        out.push(
          mk(inp.termId, 'model_rightsize', {
            severity: 'medium',
            finding: "This session is on Opus, but its recent turns look light",
            detail: inp.billingReal
              ? `Even the heaviest recent turn generated little output. If your work here has been routine, Sonnet handles it for ~${sonnetPct}% less (Haiku ~${haikuPct}% less, but riskier for hard coding). Switching resets this session's prompt cache once and only affects the next turns.`
              : `Even the heaviest recent turn generated little output. If your work here has been routine, Sonnet does it for ~${sonnetPct}% less of your usage per turn (Haiku ~${haikuPct}% less, but riskier for hard coding). Switching resets the prompt cache once and only affects the next turns.`,
            savingsLowPct: sonnetPct,
            savingsHighPct: Math.max(sonnetPct, haikuPct),
            basis: "re-pricing this session's exact token mix at Sonnet vs Haiku list rates (Opus 5/25, Sonnet 3/15, Haiku 1/5 per MTok)",
            confidence: 'low',
            evidence: [
              `${turns} turns; hardest recent turn generated ~${k(percentile(outputs, 95))} output tokens`,
              `the same tokens cost ~${sonnetPct}% less on Sonnet, ~${haikuPct}% less on Haiku`
            ],
            action: { label: 'Switch to Sonnet', kind: 'set_model', model: 'sonnet', reversible: true }
          })
        )
      }
    }
  }

  // --- verbose output: responses are the dominant slice of spend ---
  // Advisory only (no one-click) — you can't tell from tokens whether the length
  // was warranted, and over-compressing real reasoning hurts accuracy.
  const meanOut = mean(outputs)
  const outShare = outputCostFraction(cur.model, totalsOf(cur))
  if (
    enoughEvidence &&
    outShare != null &&
    cur.output >= VERBOSE_MIN_OUTPUT &&
    meanOut >= VERBOSE_MIN_PER_TURN &&
    outShare >= VERBOSE_MIN_COST_SHARE
  ) {
    const sharePct = Math.round(outShare * 100)
    out.push(
      mk(inp.termId, 'verbose_output', {
        severity: 'low',
        finding: "Model responses are the biggest slice of this session's cost",
        detail:
          `Responses average ~${k(meanOut)} tokens/turn and make up ~${sharePct}% of estimated spend. Output bills ~5× input — asking for terser answers, or lowering reasoning effort on routine turns, can cut this. Don't over-compress genuine reasoning.`,
        savingsLowPct: Math.round(outShare * 25),
        savingsHighPct: Math.round(outShare * 50),
        basis: `output is priced ~5× input and is ~${sharePct}% of this session's cost; concise-output prompting cuts response length ~30–50% at little accuracy loss`,
        confidence: 'med',
        evidence: [
          `mean output ~${k(meanOut)} tokens/turn over ${turns} turns`,
          `output ≈ ${sharePct}% of estimated session cost`
        ]
      })
    )
  }

  return out.sort(compareSuggestions)
}
