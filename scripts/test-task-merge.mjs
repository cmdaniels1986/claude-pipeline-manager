// Runtime test for the shared-tasks merge (src/main/tasks/merge.ts).
// Bundles the TS with esbuild, then exercises the concurrent-edit scenarios a
// cloud-synced shared tasks.json actually hits. Run: node scripts/test-task-merge.mjs
import { build } from 'esbuild'
import { rmSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'

const out = join(process.cwd(), 'scripts', '.tmp-merge.mjs')
await build({
  entryPoints: ['src/main/tasks/merge.ts'],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'node',
  logLevel: 'silent'
})
const { mergeTasksState } = await import(pathToFileURL(out).href)

let passed = 0
const fail = (msg) => {
  console.error('✗ ' + msg)
  process.exitCode = 1
}
const ok = (cond, msg) => (cond ? (passed++, console.log('✓ ' + msg)) : fail(msg))

const T = (n) => `2026-07-27T10:0${n}:00.000Z`
const task = (id, title, status, updatedAt, updatedBy) => ({
  id, title, status, createdAt: T(0), updatedAt, updatedBy
})
const goal = (id, title, tasks, updatedAt) => ({ id, title, tasks, createdAt: T(0), updatedAt })
const state = (goals, events = [], removed = []) => ({
  version: 1, projectRoot: '/local', updatedAt: T(9), goals, events, removed
})
const findTask = (s, id) => s.goals.flatMap((g) => g.tasks).find((t) => t.id === id)
const findGoal = (s, id) => s.goals.find((g) => g.id === id)

// 1. Two people add DIFFERENT goals at the same time → both survive.
{
  const mine = state([goal('g1', 'Mine', [], T(1))])
  const theirs = state([goal('g2', 'Theirs', [], T(1))])
  const m = mergeTasksState(mine, theirs)
  ok(m.goals.length === 2 && findGoal(m, 'g1') && findGoal(m, 'g2'), 'concurrent adds of different goals both survive')
}

// 2. Both edit the SAME task → newest updatedAt wins.
{
  const mine = state([goal('g1', 'G', [task('t1', 'old', 'todo', T(2), 'me')], T(2))])
  const theirs = state([goal('g1', 'G', [task('t1', 'NEW', 'doing', T(5), 'coworker')], T(5))])
  const m = mergeTasksState(mine, theirs)
  const t = findTask(m, 't1')
  ok(t.title === 'NEW' && t.status === 'doing' && t.updatedBy === 'coworker', 'same-task edit resolves last-write-wins (newer)')
}

// 3. Coworker adds a task under a goal I also touched → both my edit and their task survive.
{
  const mine = state([goal('g1', 'My renamed goal', [task('t1', 'A', 'todo', T(3))], T(3))])
  const theirs = state([goal('g1', 'G', [task('t1', 'A', 'todo', T(1)), task('t2', 'B', 'todo', T(4))], T(4))])
  const m = mergeTasksState(mine, theirs)
  const g = findGoal(m, 'g1')
  ok(g.tasks.length === 2 && findTask(m, 't2'), 'new task from coworker unioned into a goal I edited')
}

// 4. I delete a task (tombstone); coworker's copy still has it → stays deleted.
{
  const mine = state([goal('g1', 'G', [], T(5))], [], [{ id: 't1', ts: T(5) }])
  const theirs = state([goal('g1', 'G', [task('t1', 'zombie', 'todo', T(2))], T(2))])
  const m = mergeTasksState(mine, theirs)
  ok(!findTask(m, 't1'), 'deleted task does not resurrect from a stale copy')
}

// 5. Delete, then someone re-touches it AFTER the delete → it comes back (intentional revive).
{
  const mine = state([goal('g1', 'G', [], T(3))], [], [{ id: 't1', ts: T(3) }])
  const theirs = state([goal('g1', 'G', [task('t1', 'revived', 'doing', T(6))], T(6))])
  const m = mergeTasksState(mine, theirs)
  ok(findTask(m, 't1')?.title === 'revived', 'edit newer than the tombstone revives the task')
}

// 6. Events are unioned, de-duped, and sorted.
{
  const e = (ts, s) => ({ ts, termId: null, tool: 'x', summary: s })
  const mine = state([], [e(T(1), 'a'), e(T(3), 'c')])
  const theirs = state([], [e(T(1), 'a'), e(T(2), 'b')])
  const m = mergeTasksState(mine, theirs)
  const sums = m.events.map((x) => x.summary)
  ok(sums.join(',') === 'a,b,c', 'events merged, de-duped, chronological')
}

// 7. Merge is convergent: merge(a,b) and merge(b,a) agree on membership.
{
  const a = state([goal('g1', 'A', [task('t1', 'x', 'todo', T(2))], T(2))])
  const b = state([goal('g2', 'B', [task('t2', 'y', 'doing', T(3))], T(3))])
  const ab = mergeTasksState(a, b)
  const ba = mergeTasksState(b, a)
  const ids = (s) => s.goals.flatMap((g) => [g.id, ...g.tasks.map((t) => t.id)]).sort().join(',')
  ok(ids(ab) === ids(ba), 'merge order-independent on membership')
}

rmSync(out, { force: true })
console.log(`\n${passed} checks passed`)
