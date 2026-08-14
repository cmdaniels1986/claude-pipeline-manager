import type { CostSuggestion, CostSuggestionKind, FleetSuggestion, SourceUsage } from '../../shared/types'
import { cacheWriteMultFor, estimateCost, outputCostFraction, type TokenTotals } from './pricing'

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
  /** per-source token subtotals for this cumulative snapshot, when the CLI
   *  attributes usage by query_source (absent on builds that don't emit it) */
  bySource?: SourceUsage[]
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

// context-window ceiling — recent-turn context approaching the model's window,
// where Claude Code auto-compacts (a summarization pass that itself costs tokens).
const CEILING_WARN_SHARE = 0.8 // recent-turn context this fraction of the window
const CEILING_HIGH_SHARE = 0.9 // …and above this it's imminent (high severity)

// token-attribution hotspot — one non-main source (a subagent, an MCP server)
// dominating spend. Only usable when the CLI emits per-source attribution.
const ATTR_MIN_TOTAL = 80_000 // enough attributed tokens to be worth a nudge
const ATTR_MIN_SHARE = 0.5 // a single non-main source is at least half of them

// fleet: several terminals on Opus at once (the multi-terminal-only signal)
const FLEET_WINDOW_MS = 5 * 60_000 // burn measured over the last ~5 min
const FLEET_ACTIVE_MS = 3 * 60_000 // a term counts only if it emitted this recently
const FLEET_BURN_MIN = 3000 // …and burned at least this many tokens/min
const FLEET_MIN_OPUS_TERMS = 2 // this many concurrent Opus terminals → fire

/** k-formatted token count for evidence lines, e.g. 182345 -> "182k". */
function k(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
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

/** Context window (tokens) for a model, for judging how close a turn is to the
 *  ceiling where Claude Code auto-compacts. Unknown model → 1M (won't false-fire). */
function contextWindowFor(model?: string): number {
  return (model ?? '').toLowerCase().startsWith('claude-haiku') ? 200_000 : 1_000_000
}

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
  const cacheMult = cacheWriteMultFor(inp.billingReal)

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

  // --- context-window ceiling (auto-compaction imminent) ---
  // Recent-turn context near the model's window → Claude Code will soon
  // auto-compact (a summarization pass that costs tokens and can drop detail).
  const turnCtx = recentTurnContext(h)
  const window = contextWindowFor(cur.model)
  const ceilingShare = window > 0 ? turnCtx / window : 0
  const ceilingFired = enoughEvidence && ceilingShare >= CEILING_WARN_SHARE
  if (ceilingFired) {
    const high = ceilingShare >= CEILING_HIGH_SHARE
    out.push(
      mk(inp.termId, 'context_ceiling', {
        severity: high ? 'high' : 'medium',
        finding: 'This session is near its context-window limit',
        detail: inp.billingReal
          ? `Recent turns carry ~${k(turnCtx)} tokens — about ${Math.round(ceilingShare * 100)}% of this model's window. Claude Code will auto-compact soon: a summarization pass that itself costs tokens and can lose detail. If your next task is unrelated, /clear now resets cleanly; mid-task, /compact.`
          : `Recent turns carry ~${k(turnCtx)} tokens — about ${Math.round(ceilingShare * 100)}% of this model's window, re-sent near-max every turn (a big slice of your usage limit). Claude Code will auto-compact soon; if your next task is unrelated, /clear now resets cleanly; mid-task, /compact.`,
        savingsLowPct: 40,
        savingsHighPct: 80,
        basis: `recent-turn context ~${k(turnCtx)} tokens vs ~${k(window)} window; auto-compaction adds a summarization pass on top of near-max per-turn input`,
        confidence: 'med',
        evidence: [
          `recent-turn context ~${k(turnCtx)} tokens (~${Math.round(ceilingShare * 100)}% of the window)`,
          `session running ~${Math.round(durMin)} min`
        ],
        action: { label: 'Send /clear', kind: 'inject_clear', reversible: false }
      })
    )
  }

  // --- un-cleared long session / context bloat ---
  // Suppressed when context_ceiling already fired (same /clear fix — don't double-nudge).
  if (!ceilingFired && durMin >= BLOAT_MIN_MINUTES && turnCtx >= BLOAT_MIN_CONTEXT) {
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
    const opus = estimateCost(RIGHTSIZE_OPUS, t, cacheMult)
    const sonnet = estimateCost(RIGHTSIZE_SONNET, t, cacheMult)
    const haiku = estimateCost(RIGHTSIZE_HAIKU, t, cacheMult)
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
  const outShare = outputCostFraction(cur.model, totalsOf(cur), cacheMult)
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

  // --- token-attribution hotspot (only when the CLI emits per-source usage) ---
  // Defensive: absent bySource → nothing. When present, flag a single non-main
  // source (a subagent, an MCP server) that dominates this session's tokens.
  const bySource = cur.bySource
  if (enoughEvidence && bySource && bySource.length > 1) {
    const tot = (s: SourceUsage): number => s.input + s.output + s.cacheCreation + s.cacheRead
    const grand = bySource.reduce((n, s) => n + tot(s), 0)
    const nonMain = bySource
      .filter((s) => s.source && s.source.toLowerCase() !== 'main')
      .sort((a, b) => tot(b) - tot(a))[0]
    if (grand >= ATTR_MIN_TOTAL && nonMain && tot(nonMain) / grand >= ATTR_MIN_SHARE) {
      const share = Math.round((tot(nonMain) / grand) * 100)
      out.push(
        mk(inp.termId, 'attribution_hotspot', {
          severity: 'low',
          finding: `"${nonMain.source}" is using ~${share}% of this session's tokens`,
          detail: `Most of this session's tokens are attributed to ${nonMain.source}, not your main thread. If that's a subagent or MCP server you don't need running here, trimming it is the cleanest saving — it doesn't touch your main work.`,
          savingsLowPct: Math.round(share * 0.4),
          savingsHighPct: share,
          basis: `Claude Code's per-source (query_source) token attribution for this session`,
          confidence: 'med',
          evidence: [`${nonMain.source}: ~${k(tot(nonMain))} of ~${k(grand)} attributed tokens (${share}%)`]
        })
      )
    }
  }

  return out.sort(compareSuggestions)
}

// ---------------------------------------------------------------------------
// Fleet analysis — the cross-terminal signal a single session can't see.

export interface FleetTermInput {
  termId: string
  label?: string
  history: UsageSample[]
}

export interface FleetAnalyzeInput {
  now: number
  billingReal: boolean
  terms: FleetTermInput[]
  /** reset description if any terminal actually hit a usage limit (scraped) */
  resetLabel?: string | null
}

/** Recent token burn (tokens/min) over the last `windowMs`, or 0 if the term's
 *  latest sample is older than `activeMs` (idle → not burning). */
function recentBurnPerMin(h: UsageSample[], now: number, windowMs: number, activeMs: number): number {
  if (h.length < 2) return 0
  const last = h[h.length - 1]
  if (now - last.t > activeMs) return 0
  const cutoff = last.t - windowMs
  let a = h[0]
  for (let i = h.length - 1; i >= 0; i--) {
    a = h[i]
    if (h[i].t <= cutoff) break
  }
  const dt = (last.t - a.t) / 60_000
  if (dt <= 0) return 0
  const toks =
    last.input - a.input + (last.output - a.output) + (last.cacheCreation - a.cacheCreation) + (last.cacheRead - a.cacheRead)
  return toks > 0 ? toks / dt : 0
}

/**
 * Pure fleet analysis: several terminals on Opus at once. On a subscription this
 * is what burns the weekly Opus cap fastest — and it's invisible to any single
 * Claude Code session, so it's the signal a multi-terminal manager uniquely adds.
 * Honest by construction: reports concurrency + combined burn (+ the reset time
 * ONLY when a limit was actually scraped), never a fabricated "you'll hit it at 3pm".
 */
export function analyzeFleet(inp: FleetAnalyzeInput): FleetSuggestion | null {
  const active = inp.terms
    .map((t) => {
      const last = t.history[t.history.length - 1]
      return {
        termId: t.termId,
        label: t.label,
        model: (last?.model ?? '').toLowerCase(),
        burnPerMin: recentBurnPerMin(t.history, inp.now, FLEET_WINDOW_MS, FLEET_ACTIVE_MS)
      }
    })
    .filter((t) => t.model.startsWith('claude-opus') && t.burnPerMin >= FLEET_BURN_MIN)
    .sort((a, b) => b.burnPerMin - a.burnPerMin)

  if (active.length < FLEET_MIN_OPUS_TERMS) return null

  const combined = Math.round(active.reduce((n, t) => n + t.burnPerMin, 0))
  const n = active.length
  const severity: FleetSuggestion['severity'] = n >= 3 ? 'high' : 'medium'
  const reset = inp.resetLabel ? ` Your ${inp.resetLabel}.` : ''
  const detail = inp.billingReal
    ? `${n} terminals are running on Opus at once (~${k(combined)} tokens/min combined). Parallel Opus is your biggest per-token burn — moving any routine terminals to Sonnet cuts ~40% on those tokens.${reset}`
    : `${n} terminals are running on Opus at once (~${k(combined)} tokens/min combined). On a subscription, parallel Opus is what burns your weekly Opus cap fastest — move any routine terminals to Sonnet (~1.7× cheaper on tokens) to stretch your headroom.${reset}`

  return {
    kind: 'fleet_opus_burn',
    severity,
    finding: `${n} terminals on Opus at once`,
    detail,
    combinedBurnPerMin: combined,
    terms: active.map((t) => ({
      termId: t.termId,
      label: t.label,
      model: t.model,
      burnPerMin: Math.round(t.burnPerMin)
    })),
    resetLabel: inp.resetLabel ?? null,
    basis: 'recent per-terminal token burn over the last ~5 min; Opus lists at 5/25 vs Sonnet 3/15 per MTok',
    evidence: active.map(
      (t) => `${t.label ? t.label + ' ' : ''}(${t.termId}) on ${t.model || 'opus'} ~${k(Math.round(t.burnPerMin))}/min`
    ),
    sig: `${severity}:${n}:${Math.round(combined / 1000)}k:${inp.resetLabel ?? ''}`
  }
}
