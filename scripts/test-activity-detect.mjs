// Runtime test for the terminal "Claude is working" detector
// (src/main/pty/activityDetect.ts). Bundles the TS with esbuild and drives the
// ActivityMonitor with a fake clock so the idle-timeout transitions are
// deterministic. Run: node scripts/test-activity-detect.mjs
import { build } from 'esbuild'
import { rmSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'

const out = join(process.cwd(), 'scripts', '.tmp-activity-detect.mjs')
await build({
  entryPoints: ['src/main/pty/activityDetect.ts'],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const { detectWorking, ActivityMonitor } = await import(pathToFileURL(out).href)

let passed = 0
const ok = (cond, msg) => (cond ? (passed++, console.log('✓ ' + msg)) : (console.error('✗ ' + msg), (process.exitCode = 1)))

// ---- detectWorking (pure) --------------------------------------------------
ok(detectWorking('✻ Herding… (12s · esc to interrupt)'), 'detects the "esc to interrupt" working hint')
ok(detectWorking('\x1b[2m\x1b[38;5;244m esc to interrupt \x1b[0m'), 'detects it through ANSI color codes')
ok(!detectWorking('> type your message here'), 'idle prompt is not "working"')
ok(!detectWorking(''), 'empty output is not "working"')

// ---- ActivityMonitor (fake clock) ------------------------------------------
let clock = 0
let seq = 0
const scheduled = new Map()
const setTimer = (fn, ms) => {
  const id = ++seq
  scheduled.set(id, { fn, at: clock + ms })
  return id
}
const clearTimer = (id) => scheduled.delete(id)
const advance = (ms) => {
  clock += ms
  for (const [id, t] of [...scheduled].sort((a, b) => a[1].at - b[1].at)) {
    if (t.at <= clock) {
      scheduled.delete(id)
      t.fn()
    }
  }
}

const events = []
const mon = new ActivityMonitor({
  onChange: (termId, busy) => events.push([termId, busy]),
  idleMs: 1500,
  setTimer,
  clearTimer
})

// 1. First working output flips busy on, exactly once.
mon.observe('t1', '✻ Thinking… (esc to interrupt)')
mon.observe('t1', '✻ Thinking… (2s · esc to interrupt)')
ok(events.length === 1 && events[0][0] === 't1' && events[0][1] === true, 'busy fires once on first working output')

// 2. Still working before the idle window elapses → stays busy (no new event).
advance(1000)
mon.observe('t1', '✻ Working… (3s · esc to interrupt)')
advance(1000)
ok(events.length === 1, 'repeated working output keeps it busy without re-firing')

// 3. Output stops → after the idle window it flips back to idle.
advance(1500)
ok(events.length === 2 && events[1][1] === false, 'goes idle once output stops past the idle window')

// 4. A marker split across two chunks is still detected.
mon.observe('t1', 'foo esc to inter')
mon.observe('t1', 'rupt bar')
ok(events.length === 3 && events[2][1] === true, 'marker split across two data chunks still counts as working')

// 5. Exit forces idle immediately and drops state.
mon.end('t1')
ok(events.length === 4 && events[3][1] === false, 'end() flips a busy terminal back to idle')

// 6. Idle output never produces an event.
const before = events.length
mon.observe('t2', 'some normal command output\n$ ')
advance(2000)
ok(events.length === before, 'a terminal that never shows the hint never reports busy')

mon.dispose()
rmSync(out, { force: true })
console.log(`\n${passed} checks passed`)
process.exit(process.exitCode ?? 0)
