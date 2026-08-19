import { detectUsageLimit, stripAnsi } from '../out/.limitdetect-under-test.mjs'

// fixed "now": Tue 2026-08-18 23:30 local (America/New_York on this machine)
const now = new Date(2026, 7, 18, 23, 30, 0)
let pass = 0
let fail = 0

function check(name, text, expect) {
  const r = detectUsageLimit(text, now)
  const problems = []
  if (expect === null) {
    if (r !== null) problems.push(`expected null, got ${JSON.stringify(r)}`)
  } else {
    if (r === null) problems.push('expected detection, got null')
    else {
      if (expect.type && r.type !== expect.type) problems.push(`type "${r.type}" != "${expect.type}"`)
      if (expect.hasReset === true && r.resetAt == null) problems.push('expected resetAt, got null')
      if (expect.hasReset === false && r.resetAt != null) problems.push(`expected null resetAt, got ${new Date(r.resetAt)}`)
      if (expect.resetAt != null && r.resetAt !== expect.resetAt)
        problems.push(`resetAt ${new Date(r.resetAt)} != ${new Date(expect.resetAt)}`)
      if (expect.label && r.resetLabel !== expect.label) problems.push(`label "${r.resetLabel}" != "${expect.label}"`)
      if (expect.future && r.resetAt != null && r.resetAt <= now.getTime()) problems.push('resetAt not in the future')
    }
  }
  if (problems.length) {
    fail++
    console.log(`FAIL  ${name}`)
    for (const p of problems) console.log(`      ${p}`)
    if (r) console.log(`      got: ${JSON.stringify(r)} (${r.resetAt ? new Date(r.resetAt).toString() : 'no reset'})`)
  } else {
    pass++
    console.log(`ok    ${name}`)
  }
}

// ---- old wordings (regression) ----
check('old: session limit + tz', "You've hit your session limit · resets 3:45pm (America/New_York)", {
  type: 'session limit', hasReset: true, future: true, label: 'session limit · resets 3:45pm (America/New_York)'
})
check('old: weekly limit + weekday', "You've hit your weekly limit · resets Mon 12:00am (Europe/Dublin)", {
  type: 'weekly limit', hasReset: true, future: true
})
check('old: usage limit reached + at', 'Claude usage limit reached · resets at 3pm', {
  type: 'usage limit', hasReset: true, future: true
})
check('old: opus limit', "You've hit your Opus limit · resets 7pm", {
  type: 'opus limit', hasReset: true, future: true
})

// ---- 2.1.x credits system (the bug) ----
check('NEW: out of usage credits + clock', "You're out of usage credits · resets 3am", {
  type: 'usage credits', hasReset: true, future: true, label: 'usage credits · resets 3am'
})
check('NEW: out of usage credits, curly apostrophe', 'You’re out of usage credits · resets 3am', {
  type: 'usage credits', hasReset: true, future: true
})
check('NEW: out of usage credits + date', "You're out of usage credits · resets Oct 9, 10:59am", {
  type: 'usage credits', hasReset: true, future: true,
  resetAt: new Date(2026, 9, 9, 10, 59, 0).getTime()
})
check('NEW: org out of usage (no reset)', 'Your org is out of usage · add funds to continue', {
  type: 'usage credits', hasReset: false, label: 'out of usage credits'
})
check('NEW: monthly spend limit (no reset)', "You've hit your monthly spend limit.", {
  type: 'monthly spend limit', hasReset: false, label: 'monthly spend limit reached'
})
check("NEW: org's monthly usage limit + relative", "You've hit your org's monthly usage limit · resets in 3d 2h", {
  type: "org's monthly usage limit", resetAt: now.getTime() + 3 * 86_400_000 + 2 * 3_600_000
})
check('NEW: 5-hour limit + relative', "You've hit your 5-hour limit · resets in 2h 4m", {
  type: '5-hour limit', resetAt: now.getTime() + 2 * 3_600_000 + 4 * 60_000
})
check('NEW: usage limit reached — check plan', 'usage limit reached — check plan', {
  type: 'usage limit', hasReset: false
})

// ---- must NOT trigger ----
check('skip: fast limit (falls back to normal)', "You've hit your fast limit · resets in 2h 4m", null)
check('skip: fast limit reached banner', 'Fast limit reached and temporarily disabled · resets in 1h', null)
check('skip: context limit (compaction)', 'Context limit reached · auto-compacting', null)
check('skip: now-using warning', "You're now using usage credits · Your usage resets 3am", null)
check('skip: close-to warning', "You're close to your usage limits", null)
check('skip: user typed "ran out of usage"', 'I ran out of usage lastnight and it did not queue', null)

// ---- robustness ----
const ESC = ''
check('ansi + wrapped across lines',
  `${ESC}[38;5;208mYou're out of${ESC}[0m usage\r\n credits ${ESC}[1m· resets${ESC}[0m 3am`, {
  type: 'usage credits', hasReset: true, future: true
})
check('stripAnsi sanity', stripAnsi(`${ESC}[31mred${ESC}[0m`) === 'red' ? 'ok-marker resets 1pm usage limit reached' : 'broken', {
  type: 'usage limit', hasReset: true
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
