/**
 * Detects a Claude Code "usage limit reached" state from raw PTY output and, when
 * present, works out when the limit resets. Claude Code has no machine-readable
 * signal for this (it just prints a line in the TUI), so we scrape the text. The
 * wording changes across CLI versions; blocked-state variants known through 2.1.x:
 *   "You've hit your session limit · resets 3:45pm (America/New_York)"
 *   "You've hit your weekly limit · resets Mon 12:00am (Europe/Dublin)"
 *   "You've hit your monthly spend limit."
 *   "You've hit your org's monthly usage limit · resets Oct 9, 10:59am"
 *   "Claude usage limit reached · resets at 3pm"
 *   "You're out of usage credits · resets 3am"            (credits system, 2.1.x)
 *   "Your org is out of usage · add funds to continue"
 * Reset times may be absolute ("resets 3:45pm"), dated ("resets Oct 9, 10:59am"),
 * or relative ("resets in 2h 4m").
 * NOT treated as blocked: "You've hit your fast limit" (fast mode just falls back
 * to normal speed), "Context limit reached" (compaction, not usage), and the
 * "You're close to ..." / "You're now using ..." warnings.
 */

const ESC = String.fromCharCode(27)
// strip OSC, CSI and other escape sequences plus stray control chars
const ANSI = new RegExp(
  `${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|${ESC}\\[[0-9:;<=>?]*[ -/]*[@-~]|${ESC}[ -/]*[0-~]|[\\u0000-\\u0008\\u000b-\\u001f\\u007f]`,
  'g'
)

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
}

// the session is BLOCKED (not merely an "approaching your limit" warning); the
// fast-limit banner is excluded because fast mode just falls back to normal speed
const BLOCK_RE =
  /you['’]?ve hit your ((?!fast\b)[a-z0-9'’ -]{0,30}?limit)|(?:you['’]?re|your org is) out of usage(?: credits)?|usage limit reached|reached your usage limit/i

// "resets [at] [Mon[,]] [Oct 9[,]] 3[:45]pm (Area/City)" — weekday, date and timezone optional
const RESET_ABS_RE =
  /reset[s]?(?:\s+at)?\s+(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i

// "resets in 2h 4m" / "resets in 1 day 3 hrs" — relative countdown
const RESET_REL_RE =
  /reset[s]?\s+in\s+((?:\d+\s*(?:d(?:ays?)?|h(?:(?:ou)?rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b[\s,]*)+)/i
const REL_UNIT_RE = /(\d+)\s*(d|h|m|s)/gi
const REL_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }

export interface LimitInfo {
  type: string
  /** epoch ms when the limit resets, or null when it couldn't be parsed */
  resetAt: number | null
  /** human-readable reset description for the UI, e.g. "session limit · resets 3:45pm (America/New_York)" */
  resetLabel: string
}

/** Returns limit info if `text` shows a usage-limit block, else null. `now` is injectable for tests. */
export function detectUsageLimit(text: string, now: Date = new Date()): LimitInfo | null {
  // collapse whitespace so TUI line-wraps inside the message can't break a match
  const clean = stripAnsi(text).replace(/\s+/g, ' ')
  const block = BLOCK_RE.exec(clean)
  if (!block) return null

  const type = block[1]
    ? block[1].toLowerCase()
    : /out of usage/i.test(block[0])
      ? 'usage credits'
      : 'usage limit'

  const abs = RESET_ABS_RE.exec(clean)
  if (abs) {
    const [, dow, mon, day, hh, mm, ampm, tz] = abs
    let hour = parseInt(hh, 10) % 12
    if (ampm.toLowerCase() === 'pm') hour += 12
    const minute = mm ? parseInt(mm, 10) : 0
    const zone = tz?.trim() || localZone()
    const resetAt =
      mon && day
        ? zonedNextDate(now, MONTHS[mon.toLowerCase()], parseInt(day, 10), hour, minute, zone)
        : zonedNextOccurrence(now, dow ? DOW[dow.toLowerCase()] : null, hour, minute, zone)
    return { type, resetAt, resetLabel: `${type} · ${abs[0].trim()}` }
  }

  const rel = RESET_REL_RE.exec(clean)
  if (rel) {
    let ms = 0
    for (const m of rel[1].matchAll(REL_UNIT_RE)) ms += parseInt(m[1], 10) * REL_MS[m[2].toLowerCase()]
    if (ms > 0) return { type, resetAt: now.getTime() + ms, resetLabel: `${type} · ${rel[0].trim()}` }
  }

  const label = type === 'usage credits' ? 'out of usage credits' : `${type} reached`
  return { type, resetAt: null, resetLabel: label }
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Wall-clock parts of an instant in a given IANA timezone. */
function partsInZone(
  ms: number,
  tz: string
): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short'
  })
  const p: Record<string, string> = {}
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value
  const hour = p.hour === '24' ? 0 : parseInt(p.hour, 10)
  return {
    y: parseInt(p.year, 10),
    mo: parseInt(p.month, 10),
    d: parseInt(p.day, 10),
    h: hour,
    mi: parseInt(p.minute, 10),
    dow: DOW[p.weekday.slice(0, 3).toLowerCase()] ?? 0
  }
}

/** Offset (ms) of `tz` from UTC at instant `ms`, i.e. localWallClock - UTC. */
function zoneOffset(ms: number, tz: string): number {
  const p = partsInZone(ms, tz)
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0)
  // partsInZone drops seconds precision; round the source to the minute to match
  return asUtc - Math.floor(ms / 60000) * 60000
}

/** Converts a wall-clock date/time in `tz` to an epoch-ms instant (DST-aware). */
function zonedWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  let utc = guess - zoneOffset(guess, tz)
  // one refinement pass handles DST boundaries where the first offset was wrong
  const off2 = zoneOffset(utc, tz)
  if (guess - off2 !== utc) utc = guess - off2
  return utc
}

/** Next occurrence (epoch ms) of a month/day wall-clock time in `tz` — this year,
 *  or next year if that instant has already passed. */
function zonedNextDate(
  now: Date,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string
): number {
  const cur = partsInZone(now.getTime(), tz)
  let at = zonedWallClockToUtc(cur.y, month, day, hour, minute, tz)
  if (at <= now.getTime()) at = zonedWallClockToUtc(cur.y + 1, month, day, hour, minute, tz)
  return at
}

/** Next occurrence (epoch ms) of a wall-clock time in `tz`; if `targetDow` is set,
 *  the next matching weekday, otherwise today (or tomorrow if already passed). */
function zonedNextOccurrence(
  now: Date,
  targetDow: number | null,
  hour: number,
  minute: number,
  tz: string
): number {
  const cur = partsInZone(now.getTime(), tz)
  const nowMinutes = cur.h * 60 + cur.mi
  const targetMinutes = hour * 60 + minute

  let dayOffset: number
  if (targetDow != null) {
    dayOffset = (targetDow - cur.dow + 7) % 7
    if (dayOffset === 0 && targetMinutes <= nowMinutes) dayOffset = 7
  } else {
    dayOffset = targetMinutes <= nowMinutes ? 1 : 0
  }

  // advance the calendar date by dayOffset (UTC arithmetic is safe for a date-only shift)
  const shifted = new Date(Date.UTC(cur.y, cur.mo - 1, cur.d) + dayOffset * 86_400_000)
  return zonedWallClockToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    hour,
    minute,
    tz
  )
}
