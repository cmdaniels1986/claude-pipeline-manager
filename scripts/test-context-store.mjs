// Runtime test for shared context (src/main/context/ContextStore.ts): posting,
// removal + tombstones, the CONTEXT.md mirror, disk round-trip, and the
// concurrent-edit merge. Uses a real temp folder. Run: node scripts/test-context-store.mjs
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const out = join(process.cwd(), 'scripts', '.tmp-context.mjs')
await build({
  entryPoints: ['src/main/context/ContextStore.ts'],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const { ContextStore, mergeContext } = await import(pathToFileURL(out).href)

let passed = 0
const ok = (cond, msg) => (cond ? (passed++, console.log('✓ ' + msg)) : (console.error('✗ ' + msg), (process.exitCode = 1)))
const wait = (ms) => new Promise((r) => setTimeout(r, ms)) // let the debounced save flush

const folder = mkdtempSync(join(tmpdir(), 'ctx-'))
const store = new ContextStore(folder, 'chad')

// 1. Post a note → stored + authored in memory (file write is debounced).
const p1 = store.post({ text: 'raw.claims is stale — refresh before the marts run' })
ok(store.get().length === 1 && store.get()[0].author === 'chad', 'post is stored and authored')

// 2. Post tied to a task carries the task title.
store.post({ text: 'taking the eligibility rollup', taskId: 't-1', taskTitle: 'Eligibility rollup' })
ok(store.get().some((p) => p.taskTitle === 'Eligibility rollup'), 'a note can be tied to the shared task')

// 3. After the debounce, both the JSON and the human-readable mirror are on disk.
await wait(450)
ok(existsSync(join(folder, 'context.json')), 'context.json written to the shared folder')
const md = readFileSync(join(folder, 'CONTEXT.md'), 'utf8')
ok(md.includes('raw.claims is stale') && md.includes('chad'), 'CONTEXT.md mirror is readable with author + text')

// 4. Remove → gone, and a tombstone is recorded.
store.remove(p1.id)
ok(!store.get().some((p) => p.id === p1.id), 'removed post is gone')

// 5. Reopen the folder in a fresh store → posts persist across sessions.
store.dispose()
const store2 = new ContextStore(folder, 'someone-else')
ok(store2.get().length === 1, 'posts persist across a reopen')
ok(!store2.get().some((p) => p.id === p1.id), 'a removed post stays removed after reopen (tombstone honored)')
store2.dispose()

// 6. Merge: two coworkers post different notes concurrently → both survive.
const T = (n) => `2026-08-05T10:0${n}:00.000Z`
const mine = { version: 1, updatedAt: T(2), posts: [{ id: 'a', author: 'me', ts: T(1), text: 'A' }], removed: [] }
const theirs = { version: 1, updatedAt: T(3), posts: [{ id: 'b', author: 'you', ts: T(2), text: 'B' }], removed: [] }
const merged = mergeContext(mine, theirs)
ok(merged.posts.length === 2 && merged.posts.map((p) => p.id).join(',') === 'a,b', 'concurrent posts both survive, chronological')

// 7. Merge honors a tombstone from either side (a delete propagates).
const del = { version: 1, updatedAt: T(4), posts: [], removed: [{ id: 'a', ts: T(4) }] }
ok(!mergeContext(mine, del).posts.some((p) => p.id === 'a'), 'a coworker deletion propagates through merge')

rmSync(out, { force: true })
rmSync(folder, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
process.exit(process.exitCode ?? 0)
