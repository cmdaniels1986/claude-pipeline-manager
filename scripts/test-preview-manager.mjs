// Runtime checks for PreviewManager (no Electron): PTY scrape → candidates +
// auto-adopt, agent/manual set, persistence round-trip, and the project file
// watcher asking for a reload (ignored folders stay quiet).
// Run: npm run test:preview-manager
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PreviewManager } from '../out/.previewmanager-under-test.mjs'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || detail === undefined ? '' : `\n      ${detail}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'cpm-preview-'))
const changes = []
const reloads = []
const mk = () =>
  new PreviewManager({
    onChange: (s) => changes.push(s),
    onReload: (r) => reloads.push(r),
    excludePorts: () => [53211]
  })

try {
  const pm = mk()
  pm.setRoot(root)
  ok('fresh project has no url', pm.get().url === null)

  // Vite banner split across two PTY chunks, ANSI-colored
  pm.observe('t1', '\x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:')
  ok('half a URL is not adopted', pm.get().url === null)
  pm.observe('t1', '\x1b[1m5173\x1b[22m/\x1b[39m\n')
  ok('split URL adopted once complete', pm.get().url === 'http://localhost:5173', JSON.stringify(pm.get()))
  ok('adopted source = detected', pm.get().source === 'detected')
  ok('candidate attributed to terminal', pm.get().candidates[0]?.termId === 't1')

  // app's own MCP port never offered
  pm.observe('t1', 'mcp http://127.0.0.1:53211/mcp\n')
  ok('excluded port not a candidate', !pm.get().candidates.some((c) => c.url.includes('53211')))

  // a second server: candidate, but the shown page doesn't switch by itself
  const before = changes.length
  pm.observe('t2', ' * Running on http://127.0.0.1:5000\n')
  ok('second server becomes a candidate', pm.get().candidates[0]?.url === 'http://127.0.0.1:5000')
  ok('current url unchanged', pm.get().url === 'http://localhost:5173')
  ok('change broadcast', changes.length === before + 1)
  const after = changes.length
  pm.observe('t2', ' * Running on http://127.0.0.1:5000\n')
  ok('re-seeing same url within 30s is silent', changes.length === after)

  // agent set (explicit → switches, labels)
  // (a path's trailing slash is meaningful to Django/Flask routing — kept as given)
  const set = pm.set('http://0.0.0.0:8000/admin/', 'agent', 't2', 'Django admin')
  ok('agent set normalizes wildcard host', set === 'http://localhost:8000/admin/', set)
  ok('agent set switches page', pm.get().url === 'http://localhost:8000/admin/')
  ok('label kept', pm.get().label === 'Django admin')
  ok('bad url rejected', pm.set('https://example.com', 'manual', null) === null)
  ok('bad url leaves state', pm.get().url === 'http://localhost:8000/admin/')

  // persistence round-trip
  const saved = JSON.parse(readFileSync(join(root, '.claude-manager', 'preview.json'), 'utf8'))
  ok('persisted url', saved.url === 'http://localhost:8000/admin/')
  const pm2 = mk()
  pm2.setRoot(root)
  ok('restored url on reopen', pm2.get().url === 'http://localhost:8000/admin/')
  ok('restored label', pm2.get().label === 'Django admin')
  ok('candidates are session-only', pm2.get().candidates.length === 0)
  pm2.dispose()

  // agent reload passes through
  pm.reload('t2')
  ok('agent reload emitted', reloads.at(-1)?.reason === 'agent' && reloads.at(-1)?.termId === 't2')

  // file watcher: a source edit → one coalesced 'files' reload; ignored dirs stay quiet
  await sleep(800) // let chokidar finish its initial scan
  const n0 = reloads.length
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'ignored')
  writeFileSync(join(root, '.claude-manager', 'graph.json'), '{}')
  await sleep(1500)
  ok('ignored folders do not reload', reloads.length === n0, `got ${reloads.length - n0} reload(s)`)
  writeFileSync(join(root, 'app.py'), 'print(1)')
  writeFileSync(join(root, 'index.html'), '<h1>hi</h1>')
  await sleep(1800)
  ok('source edits reload once (coalesced)', reloads.length === n0 + 1, `got ${reloads.length - n0} reload(s)`)
  ok('reload reason = files with a path', reloads.at(-1)?.reason === 'files' && typeof reloads.at(-1)?.path === 'string')

  // clearing stops the watcher
  pm.clear()
  ok('clear empties url', pm.get().url === null)
  await sleep(300)
  const n1 = reloads.length
  writeFileSync(join(root, 'app.py'), 'print(2)')
  await sleep(1500)
  ok('no reloads once cleared', reloads.length === n1)

  pm.dispose()
} finally {
  await sleep(200)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // temp dir cleanup is best-effort on Windows
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
