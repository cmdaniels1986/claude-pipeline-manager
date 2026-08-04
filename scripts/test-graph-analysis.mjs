// Runtime test for graph health analysis (src/renderer/src/graph/analysis.ts)
// and the git-scope path matcher (src/main/graph/gitScope.ts). Bundles both with
// esbuild and asserts on hand-built graphs. Run: node scripts/test-graph-analysis.mjs
import { build } from 'esbuild'
import { rmSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'

async function load(entry, tmp) {
  const out = join(process.cwd(), 'scripts', tmp)
  await build({ entryPoints: [entry], outfile: out, format: 'esm', bundle: true, platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(out).href)
  return { mod, cleanup: () => rmSync(out, { force: true }) }
}

const { mod: analysisMod, cleanup: c1 } = await load('src/renderer/src/graph/analysis.ts', '.tmp-analysis.mjs')
const { mod: gitMod, cleanup: c2 } = await load('src/main/graph/gitScope.ts', '.tmp-gitscope.mjs')
const { analyzeGraph } = analysisMod
const { matchChangedNodes } = gitMod

let passed = 0
const fail = (msg) => {
  console.error('✗ ' + msg)
  process.exitCode = 1
}
const ok = (cond, msg) => (cond ? (passed++, console.log('✓ ' + msg)) : fail(msg))

const node = (id, type = 'model', meta = {}) => ({ id, label: id, type, status: 'unknown', meta, position: null })
const edge = (source, target) => ({ id: `${source}->${target}`, source, target, kind: 'lineage' })
const graph = (nodes, edges) => ({ version: 1, projectRoot: '/p', updatedAt: '', nodes, edges, events: [] })

// 1. Linear chain: src → stg → mart. No cycles/orphans; mart is a leaf report (not dead-end).
{
  const g = graph(
    [node('raw', 'source'), node('stg'), node('mart', 'report')],
    [edge('raw', 'stg'), edge('stg', 'mart')]
  )
  const a = analyzeGraph(g)
  ok(a.cycle.size === 0, 'linear chain has no cycle')
  ok(a.orphan.size === 0, 'linear chain has no orphan')
  ok(a.deadend.size === 0, 'report leaf is not a dead-end')
}

// 2. Cycle a → b → c → a: all three flagged.
{
  const g = graph([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')])
  const a = analyzeGraph(g)
  ok(a.cycle.has('a') && a.cycle.has('b') && a.cycle.has('c'), 'three-node cycle: all flagged')
}

// 3. Self-loop x → x is a cycle.
{
  const g = graph([node('x')], [edge('x', 'x')])
  ok(analyzeGraph(g).cycle.has('x'), 'self-loop flagged as cycle')
}

// 4. Orphan: node with no edges at all.
{
  const g = graph([node('lonely'), node('a'), node('b')], [edge('a', 'b')])
  const a = analyzeGraph(g)
  ok(a.orphan.has('lonely') && !a.orphan.has('a'), 'disconnected node is an orphan')
}

// 5. Dead-end: a model with upstream but no downstream consumer.
{
  const g = graph([node('raw', 'source'), node('built', 'model')], [edge('raw', 'built')])
  const a = analyzeGraph(g)
  ok(a.deadend.has('built'), 'consumed-by-nobody model is a dead-end')
  ok(!a.deadend.has('raw'), 'a source with downstream is not a dead-end')
}

// 6. Placeholder nodes surface.
{
  const g = graph([node('real'), node('ph', 'other', { placeholder: true })], [edge('real', 'ph')])
  ok(analyzeGraph(g).placeholder.has('ph'), 'placeholder node reported')
}

// ---- git-scope matcher ----------------------------------------------------

// 7. Absolute node path matches an identical changed abs path (case-insensitive).
{
  const hits = matchChangedNodes(
    [{ id: 'stg_orders', path: 'C:/repo/models/stg_orders.sql' }],
    ['c:/repo/models/stg_orders.sql']
  )
  ok(hits.length === 1 && hits[0] === 'stg_orders', 'absolute path matches (case-insensitive)')
}

// 8. Relative node path suffix-matches an absolute changed path.
{
  const hits = matchChangedNodes(
    [{ id: 'a', path: 'models/staging/stg_orders.sql' }, { id: 'b', path: 'models/other.sql' }],
    ['/home/u/repo/models/staging/stg_orders.sql']
  )
  ok(hits.length === 1 && hits[0] === 'a', 'relative path suffix-matches the changed file')
}

// 9. No false positive on a shared basename with a different folder.
{
  const hits = matchChangedNodes(
    [{ id: 'a', path: 'models/staging/orders.sql' }],
    ['/repo/models/marts/orders.sql']
  )
  ok(hits.length === 0, 'same basename, different path does not match')
}

c1()
c2()
console.log(`\n${passed} checks passed`)
