// Runtime test for TaskHub (src/main/tasks/TaskHub.ts): the two-list router that
// backs "My Goals" (local) + "Shared Goals" (synced folder). Exercises routing by
// id, moving goals between lists, and unshare-migration. Uses real temp folders.
// Run: node scripts/test-task-hub.mjs
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const out = join(process.cwd(), 'scripts', '.tmp-hub.mjs')
await build({
  entryPoints: ['src/main/tasks/TaskHub.ts'],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const { TaskHub } = await import(pathToFileURL(out).href)

let passed = 0
const ok = (cond, msg) => (cond ? (passed++, console.log('✓ ' + msg)) : (console.error('✗ ' + msg), (process.exitCode = 1)))

const root = mkdtempSync(join(tmpdir(), 'hub-root-'))
const share = mkdtempSync(join(tmpdir(), 'hub-share-'))
const hub = new TaskHub({ projectRoot: root, sharedPath: share, author: 'tester', onChange: () => {}, onWarning: () => {} })

// 1. Goals land in the list they were added to.
const g1 = hub.addGoal({ title: 'Private goal' }, null, 'mine')
const g2 = hub.addGoal({ title: 'Shared goal' }, null, 'shared')
{
  const s = hub.snapshot()
  ok(s.mine.goals.length === 1 && s.shared.goals.length === 1, 'add routes goals to mine vs shared')
  ok(s.shared.goals[0].title === 'Shared goal', 'shared goal is in the shared list')
}

// 2. Edits addressed by id route to the right list.
const { taskIds } = hub.addTasks(g2.goalId, ['do the thing'], null)
hub.updateTask(taskIds[0], { status: 'doing' }, null)
{
  const s = hub.snapshot()
  ok(s.mine.goals[0].tasks.length === 0, 'task added under a shared goal did NOT land in mine')
  ok(s.shared.goals[0].tasks[0].status === 'doing', 'updateTask routed to the shared list by id')
  ok(s.shared.goals[0].tasks[0].updatedBy === 'tester', 'edit stamped with author')
}

// 3. Move a private goal into the shared list.
hub.moveGoal(g1.goalId, 'shared', null)
{
  const s = hub.snapshot()
  ok(s.mine.goals.length === 0, 'moved goal left the private list')
  ok(
    s.shared.goals.length === 2 && s.shared.goals.some((g) => g.id === g1.goalId),
    'moved goal (same id) now in the shared list'
  )
}

// 4. Unsharing copies shared goals back into the private list and drops the shared list.
hub.setSharedPath(null)
{
  const s = hub.snapshot()
  ok(s.shared === null && s.sharedPath === null, 'unshare removes the shared list')
  ok(s.mine.goals.length === 2, 'shared goals migrated back into mine on unshare')
}

// 5. Re-enabling a shared folder that already has a file loads it.
hub.setSharedPath(share)
{
  const s = hub.snapshot()
  ok(s.shared !== null && s.shared.goals.length >= 1, 're-enabling loads the existing shared file')
}

// 6. Goal completion: new goals start active; updateGoal + setStatus mark them done/reopen.
{
  const g = hub.addGoal({ title: 'Ship it' }, null, 'mine')
  ok(hub.snapshot().mine.goals.find((x) => x.id === g.goalId).status === 'active', 'new goal starts active')

  hub.updateGoal(g.goalId, { status: 'done' }, null)
  ok(hub.snapshot().mine.goals.find((x) => x.id === g.goalId).status === 'done', 'updateGoal marks a goal done')

  // setStatus is polymorphic (used by the MCP tool): a goal id + done completes the goal.
  hub.updateGoal(g.goalId, { status: 'active' }, null)
  const r = hub.setStatus(g.goalId, 'done', 't1')
  ok(r.ok && r.kind === 'goal', 'setStatus routes a goal id to goal completion')
  ok(hub.snapshot().mine.goals.find((x) => x.id === g.goalId).status === 'done', 'setStatus(goalId, done) completes the goal')

  // a task id still routes to the task.
  const { taskIds } = hub.addTasks(g.goalId, ['a step'], null)
  const rt = hub.setStatus(taskIds[0], 'done', 't1')
  ok(rt.ok && rt.kind === 'task', 'setStatus routes a task id to the task')
  ok(hub.snapshot().mine.goals.find((x) => x.id === g.goalId).tasks[0].status === 'done', 'setStatus(taskId, done) completes the task')
}

hub.dispose()
rmSync(out, { force: true })
rmSync(root, { recursive: true, force: true })
rmSync(share, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
process.exit(process.exitCode ?? 0)
