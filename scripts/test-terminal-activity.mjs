// Runtime test for the tab "what did this terminal work on" helper
// (src/renderer/src/components/terminalActivity.ts). Bundles the TS with esbuild
// and checks event filtering by termId, newest-first order, and the tooltip text.
// Run: node scripts/test-terminal-activity.mjs
import { build } from 'esbuild'
import { rmSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'

const out = join(process.cwd(), 'scripts', '.tmp-activity.mjs')
await build({
  entryPoints: ['src/renderer/src/components/terminalActivity.ts'],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'node',
  logLevel: 'silent'
})
const { collectActivity, describeTerminal } = await import(pathToFileURL(out).href)

let passed = 0
const ok = (cond, msg) => (cond ? (passed++, console.log('✓ ' + msg)) : (console.error('✗ ' + msg), (process.exitCode = 1)))

const T = (n) => `2026-08-04T10:0${n}:00.000Z`
const gev = (ts, termId, summary) => ({ ts, termId, tool: 'graph', summary })
const tev = (ts, termId, summary) => ({ ts, termId, tool: 'task', summary, by: 'agent' })

const graph = [gev(T(1), 't1', 'upserted 2 node(s): stg_orders, eligibility'), gev(T(4), 't2', 'other terminal')]
const tasks = [tev(T(3), 't1', '"ship it" → done'), tev(T(2), null, 'human edit'), tev(T(5), 't1', 'goal "Launch" completed ✓')]

// 1. Only this terminal's events; human (null) + other terminals excluded.
{
  const a = collectActivity('t1', graph, tasks)
  ok(a.length === 3, 'collects only the given termId (excludes null + other terminals)')
  ok(!a.some((x) => x.summary === 'human edit' || x.summary === 'other terminal'), 'human + other-terminal events filtered out')
}

// 2. Newest first, across both sources.
{
  const a = collectActivity('t1', graph, tasks)
  ok(a[0].summary === 'goal "Launch" completed ✓' && a[a.length - 1].summary.startsWith('upserted'), 'sorted newest-first across graph + task')
}

// 3. No termId (a starting/attaching pane) → nothing.
ok(collectActivity(undefined, graph, tasks).length === 0, 'no termId yields no activity')

// 4. Tooltip: header, counts, and bullets.
{
  const text = describeTerminal({ cwd: '/proj', agentName: 'builder', label: 'Terminal 1' }, collectActivity('t1', graph, tasks))
  ok(text.includes('agent: builder') && text.includes('/proj'), 'tooltip leads with label/agent + cwd')
  ok(/1 pipeline update\b/.test(text) && /2 task updates\b/.test(text), 'tooltip summarizes update counts (singular/plural)')
  ok(text.includes('goal "Launch" completed ✓'), 'tooltip lists recent activity summaries')
}

// 5. Empty activity → explicit "nothing yet" line, no bullets.
{
  const text = describeTerminal({ cwd: '/proj', label: 'Terminal 2' }, [])
  ok(text.includes('No pipeline or task activity recorded yet.'), 'empty terminal says so')
}

// 6. Long histories are capped with an overflow line.
{
  const many = Array.from({ length: 9 }, (_, i) => gev(`2026-08-04T11:${String(i).padStart(2, '0')}:00.000Z`, 't1', `step ${i}`))
  const text = describeTerminal({ cwd: '/p', label: 'T' }, collectActivity('t1', many, []))
  ok(text.includes('…and 3 more'), 'caps the list and notes how many more')
}

rmSync(out, { force: true })
console.log(`\n${passed} checks passed`)
process.exit(process.exitCode ?? 0)
