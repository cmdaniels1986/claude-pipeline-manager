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

const { analyze } = await load('src/main/usage/advisor.ts', 'advisor')

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
