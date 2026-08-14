// Runtime test for the cost advisor: bundles the pure detector + the stateful
// hub with esbuild and exercises them against synthetic session traces.
// Run: node scripts/test-advisor.mjs
import { build } from 'esbuild'
import { writeFileSync } from 'fs'
import { pathToFileURL } from 'url'

async function load(entry, outName) {
  const r = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false })
  const out = `scripts/_${outName}.mjs`
  writeFileSync(out, r.outputFiles[0].text)
  return import(pathToFileURL(out).href)
}

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

/** Build a cumulative history: `samples` snapshots `stepMs` apart, each turn
 *  adding `perStep` tokens. `tweak(i, acc)` can mutate one turn (e.g. a big spike). */
function ramp({ samples, stepMs, perStep, tweak }) {
  const h = []
  const acc = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  for (let i = 0; i < samples; i++) {
    if (i > 0) {
      acc.input += perStep.input || 0
      acc.output += perStep.output || 0
      acc.cacheRead += perStep.cacheRead || 0
      acc.cacheCreation += perStep.cacheCreation || 0
      if (tweak) tweak(i, acc)
    }
    h.push({ t: i * stepMs, input: acc.input, output: acc.output, cacheRead: acc.cacheRead, cacheCreation: acc.cacheCreation, cost: null })
  }
  return h
}
const nowOf = (h) => h[h.length - 1].t
const kinds = (list) => list.map((s) => s.kind).sort()
const withModel = (h, model) => h.map((s) => ({ ...s, model }))

const { analyze, analyzeFleet } = await load('src/main/usage/advisor.ts', 'advisor')

// A) healthy short well-cached session → nothing
{
  const h = ramp({ samples: 8, stepMs: 10_000, perStep: { input: 500, cacheRead: 8000, cacheCreation: 200, output: 400 } })
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('A healthy short session → 0 suggestions', r.length === 0)
}

// B) caching essentially off (big input, ~no cache), long enough → cache_off
{
  const h = ramp({ samples: 10, stepMs: 25_000, perStep: { input: 22_000, cacheCreation: 100, output: 3000 } })
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('B caching-off → exactly [cache_off]', r.length === 1 && r[0].kind === 'cache_off')
  check('B cache_off is high severity + high confidence', r[0]?.severity === 'high' && r[0]?.confidence === 'high')
}

// C) writing cache but not reading it back → cache_thrash (not cache_off)
{
  const h = ramp({ samples: 10, stepMs: 25_000, perStep: { input: 5000, cacheCreation: 6500, cacheRead: 2200, output: 2000 } })
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('C thrash → exactly [cache_thrash]', r.length === 1 && r[0].kind === 'cache_thrash')
}

// D) long un-cleared session with a big recent-turn context → context_bloat (+ action)
{
  const h = ramp({
    samples: 40,
    stepMs: 60_000,
    perStep: { input: 2000, cacheRead: 6000, cacheCreation: 200, output: 1500 },
    tweak: (i, acc) => {
      if (i === 20) acc.cacheRead += 180_000 // one turn re-reads a huge context
    }
  })
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('D context bloat → includes context_bloat', kinds(r).includes('context_bloat'))
  const b = r.find((s) => s.kind === 'context_bloat')
  check('D context_bloat carries a /clear action', b?.action?.kind === 'inject_clear')
  check('D context_bloat is medium (<400k) severity', b?.severity === 'medium')
}

// E) big input but too little evidence (few samples, short) → nothing
{
  const h = ramp({ samples: 3, stepMs: 10_000, perStep: { input: 100_000, cacheCreation: 100 } })
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('E not enough evidence → 0 suggestions', r.length === 0)
}

// F) savings are always a range with low <= high
{
  const h = ramp({ samples: 10, stepMs: 25_000, perStep: { input: 22_000, cacheCreation: 100 } })
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('F savings is a valid range', r.every((s) => s.savingsLowPct <= s.savingsHighPct))
}

// G) on Opus but every turn is light + well-cached → model_rightsize (suggest-only)
{
  const h = withModel(
    ramp({ samples: 14, stepMs: 20_000, perStep: { input: 2000, cacheRead: 12_000, cacheCreation: 300, output: 800 } }),
    'claude-opus-4-8'
  )
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('G light Opus session → exactly [model_rightsize]', r.length === 1 && r[0].kind === 'model_rightsize')
  const m = r.find((s) => s.kind === 'model_rightsize')
  check('G rightsize offers a set_model → sonnet action', m?.action?.kind === 'set_model' && m?.action?.model === 'sonnet')
  check('G rightsize is medium severity + LOW confidence (two axes)', m?.severity === 'medium' && m?.confidence === 'low')
  check('G rightsize savings is a real range (Sonnet..Haiku)', m?.savingsLowPct > 0 && m?.savingsLowPct < m?.savingsHighPct)
}

// H) on Opus but recent turns generate lots of output → do NOT suggest downgrade
{
  const h = withModel(
    ramp({ samples: 14, stepMs: 20_000, perStep: { input: 2000, cacheRead: 12_000, cacheCreation: 300, output: 9000 } }),
    'claude-opus-4-8'
  )
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('H heavy-output Opus → never model_rightsize (peak, not mean)', !kinds(r).includes('model_rightsize'))
}

// I) responses dominate spend → verbose_output (advisory, no one-click)
{
  const h = withModel(
    ramp({ samples: 12, stepMs: 25_000, perStep: { input: 2000, cacheRead: 3000, output: 9000 } }),
    'claude-sonnet-4-6'
  )
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  const v = r.find((s) => s.kind === 'verbose_output')
  check('I output-heavy session → includes verbose_output', !!v)
  check('I verbose_output is low severity + advisory-only (no action)', v?.severity === 'low' && !v?.action)
}

// J) light session on a NON-Opus model → nothing (rightsize is Opus-only)
{
  const h = withModel(
    ramp({ samples: 14, stepMs: 20_000, perStep: { input: 2000, cacheRead: 12_000, cacheCreation: 300, output: 800 } }),
    'claude-sonnet-4-6'
  )
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('J light Sonnet session → 0 suggestions (rightsize is Opus-only)', r.length === 0)
}

// ---- the stateful hub: dedup + dismissal + no-resurrection ----
const { CostAdvisor } = await load('src/main/usage/CostAdvisor.ts', 'costAdvisor')
{
  const calls = []
  const adv = new CostAdvisor((termId, suggestions) => calls.push(suggestions))
  const base = 100_000
  const samples = ramp({ samples: 10, stepMs: 25_000, perStep: { input: 22_000, cacheCreation: 100, output: 3000 } })
  for (const s of samples) {
    adv.record(
      { termId: 't', inputTokens: s.input, outputTokens: s.output, cacheCreationTokens: s.cacheCreation, cacheReadTokens: s.cacheRead, contextTokens: 0, messages: 0, costUsd: null },
      base + s.t,
      false
    )
  }
  check('hub fired once for the appearing cache_off (dedup)', calls.length === 1 && calls[0].length === 1 && calls[0][0].kind === 'cache_off')

  adv.dismiss('t', 'cache_off')
  check('hub emits empty list after dismiss', calls.length === 2 && calls[1].length === 0)

  // still caching-off, but dismissed → must NOT resurface
  const more = samples[samples.length - 1]
  adv.record(
    { termId: 't', inputTokens: more.input + 22_000, outputTokens: more.output, cacheCreationTokens: more.cacheCreation, cacheReadTokens: 0, contextTokens: 0, messages: 0, costUsd: null },
    base + more.t + 25_000,
    false
  )
  check('dismissed suggestion does not resurrect', calls.length === 2)
}

// K) context near the window ceiling (Haiku 200k) → context_ceiling, supersedes bloat
{
  const h = withModel(
    ramp({
      samples: 40,
      stepMs: 60_000,
      perStep: { input: 1500, cacheRead: 5000, cacheCreation: 200, output: 1200 },
      tweak: (i, acc) => {
        if (i === 20) acc.cacheRead += 185_000 // one turn fills most of Haiku's 200k window
      }
    }),
    'claude-haiku-4-5'
  )
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  check('K near-ceiling Haiku → includes context_ceiling', kinds(r).includes('context_ceiling'))
  check('K context_ceiling supersedes context_bloat', !kinds(r).includes('context_bloat'))
  const c = r.find((s) => s.kind === 'context_ceiling')
  check('K context_ceiling is high severity + carries /clear', c?.severity === 'high' && c?.action?.kind === 'inject_clear')
}

// L) a subagent dominates attributed tokens → attribution_hotspot (only when bySource present)
{
  const h = withModel(
    ramp({ samples: 10, stepMs: 25_000, perStep: { input: 500, cacheRead: 8000, cacheCreation: 200, output: 400 } }),
    'claude-sonnet-4-6'
  )
  h[h.length - 1].bySource = [
    { source: 'main', input: 20_000, output: 8000, cacheRead: 2000, cacheCreation: 0 },
    { source: 'subagent', input: 60_000, output: 30_000, cacheRead: 10_000, cacheCreation: 0 }
  ]
  const r = analyze({ termId: 't', now: nowOf(h), billingReal: false, history: h })
  const a = r.find((s) => s.kind === 'attribution_hotspot')
  check('L subagent hotspot → attribution_hotspot fires', !!a)
  check('L attribution_hotspot is low severity + advisory-only', a?.severity === 'low' && !a?.action)
  const h2 = withModel(
    ramp({ samples: 10, stepMs: 25_000, perStep: { input: 500, cacheRead: 8000, cacheCreation: 200, output: 400 } }),
    'claude-sonnet-4-6'
  )
  const r2 = analyze({ termId: 't', now: nowOf(h2), billingReal: false, history: h2 })
  check('L no bySource → no attribution_hotspot', !kinds(r2).includes('attribution_hotspot'))
}

// ---- fleet: several terminals on Opus at once ----
{
  const mkOpus = () =>
    withModel(
      ramp({ samples: 10, stepMs: 30_000, perStep: { input: 3000, cacheRead: 5000, cacheCreation: 500, output: 2000 } }),
      'claude-opus-4-8'
    )
  const a = mkOpus()
  const b = mkOpus()
  const now = nowOf(a)
  const f = analyzeFleet({ now, billingReal: false, terms: [{ termId: 'a', history: a }, { termId: 'b', history: b }] })
  check('fleet: two Opus terminals → fleet_opus_burn', f?.kind === 'fleet_opus_burn')
  check('fleet: names both terminals, medium severity', f?.terms.length === 2 && f?.severity === 'medium')
  check('fleet: reports a combined burn rate', (f?.combinedBurnPerMin ?? 0) > 0)

  const sonnet = withModel(
    ramp({ samples: 10, stepMs: 30_000, perStep: { input: 3000, cacheRead: 5000, output: 2000 } }),
    'claude-sonnet-4-6'
  )
  const f2 = analyzeFleet({ now, billingReal: false, terms: [{ termId: 'a', history: a }, { termId: 's', history: sonnet }] })
  check('fleet: one Opus + one Sonnet → no fleet card', f2 === null)

  const f3 = analyzeFleet({
    now,
    billingReal: false,
    terms: [{ termId: 'a', history: a }, { termId: 'b', history: b }],
    resetLabel: 'weekly limit · resets Mon 12:00am'
  })
  check('fleet: overlays a scraped reset label when present', !!f3 && f3.detail.includes('resets Mon'))
}

// ---- dismissal store: soft-snooze, auto-retire, mute (persistence semantics) ----
const { DismissalStore } = await load('src/main/usage/dismissalStore.ts', 'dismissal')
{
  const ds = new DismissalStore() // in-memory (no file)
  ds.record('cache_off', 'session', 1000)
  check('store: a plain dismiss soft-snoozes the kind', ds.isSuppressed('cache_off', 1000 + 30 * 60_000))
  check('store: soft-snooze expires while count < retire', !ds.isSuppressed('cache_off', 1000 + 2 * 60 * 60_000))
  ds.record('cache_off', 'session', 2000)
  ds.record('cache_off', 'session', 3000)
  check('store: auto-retire after 3 dismissals, regardless of time', ds.isSuppressed('cache_off', 1000 + 100 * 60 * 60_000))
  ds.record('verbose_output', 'mute', 1000)
  check('store: mute suppresses immediately and forever', ds.isSuppressed('verbose_output', 1000 + 9999 * 60 * 60_000))
}

// ---- CostAdvisor honours mute end-to-end ----
{
  const seen = []
  const adv = new CostAdvisor((_t, s) => seen.push(s))
  const trace = ramp({ samples: 10, stepMs: 25_000, perStep: { input: 22_000, cacheCreation: 100, output: 3000 } })
  const rec = (s, t) =>
    adv.record(
      { termId: 't', inputTokens: s.input, outputTokens: s.output, cacheCreationTokens: s.cacheCreation, cacheReadTokens: s.cacheRead, contextTokens: 0, messages: 0, costUsd: null },
      t,
      false
    )
  for (const s of trace) rec(s, 100_000 + s.t)
  check('mute: cache_off is active before muting', seen[seen.length - 1].some((x) => x.kind === 'cache_off'))
  adv.dismiss('t', 'cache_off', 'mute')
  check('mute: card clears immediately', !seen[seen.length - 1].some((x) => x.kind === 'cache_off'))
  const last = trace[trace.length - 1]
  rec({ input: last.input + 22_000, output: last.output, cacheCreation: last.cacheCreation, cacheRead: 0 }, 100_000 + last.t + 25_000)
  check('mute: kind never resurfaces', !seen[seen.length - 1].some((x) => x.kind === 'cache_off'))
}

// ---- pricing: subscription pays the 1-hour (2×) cache-write premium ----
const { cacheWriteMultFor, estimateCost } = await load('src/main/usage/pricing.ts', 'pricing')
{
  check('pricing: subscription 2× vs API 1.25×', cacheWriteMultFor(false) === 2 && cacheWriteMultFor(true) === 1.25)
  const t = { input: 0, output: 0, cacheCreation: 1_000_000, cacheRead: 0 }
  const sub = estimateCost('claude-opus-4-8', t, cacheWriteMultFor(false))
  const api = estimateCost('claude-opus-4-8', t, cacheWriteMultFor(true))
  check('pricing: 2× cache-write costs more than 1.25×', sub > api && Math.abs(sub - 10) < 1e-9 && Math.abs(api - 6.25) < 1e-9)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
