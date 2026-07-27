/**
 * Detects a Claude Code "usage limit reached" state from raw PTY output and, when
 * present, works out when the limit resets. Claude Code has no machine-readable
 * signal for this (it just prints a line in the TUI), so we scrape the text. The
 * wording is matched tolerantly across the variants we know of, e.g.:
 *   "You've hit your session limit · resets 3:45pm (America/New_York)"
 *   "You've hit your weekly limit · resets Mon 12:00am (Europe/Dublin)"
 *   "Claude usage limit reached · resets at 3pm"
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

// the session is BLOCKED (not merely a "approaching your limit" warning)
const BLOCK_RE =
  /(?:you'?ve hit your (session|weekly|opus) limit|usage limit reached|reached your usage limit)/i

// "resets [at] [Mon] 3[:45]pm (Area/City)" — weekday and timezone optional
const RESET_RE =
  /reset[s]?(?:\s+at)?\s+(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i

export interface LimitInfo {
  type: string
  /** epoch ms when the limit resets, or null when it couldn't be parsed */
  resetAt: number | null
  /** human-readable reset description for the UI, e.g. "session limit · resets 3:45pm (America/New_York)" */
  resetLabel: string
}

/** Returns limit info if `text` shows a usage-limit block, else null. `now` is injectable for tests. */
export function detectUsageLimit(text: string, now: Date = new Date()): LimitInfo | null {
  const clean = stripAnsi(text)
  const block = BLOCK_RE.exec(clean)
  if (!block) return null

  const type = block[1] ? `${block[1].toLowerCase()} limit` : 'usage limit'
  const reset = RESET_RE.exec(clean)
  if (!reset) return { type, resetAt: null, resetLabel: `${type} reached` }

  const [, dow, hh, mm, ampm, tz] = reset
  let hour = parseInt(hh, 10) % 12
  if (ampm.toLowerCase() === 'pm') hour += 12
  const minute = mm ? parseInt(mm, 10) : 0
  const zone = tz?.trim() || localZone()
  const resetAt = zonedNextOccurrence(now, dow ? DOW[dow.toLowerCase()] : null, hour, minute, zone)

  const label = `${type} · resets ${dow ? dow[0].toUpperCase() + dow.slice(1, 3).toLowerCase() + ' ' : ''}${hh}${mm ? ':' + mm : ''}${ampm.toLowerCase()}${tz ? ` (${tz.trim()})` : ''}`
  return { type, resetAt, resetLabel: label }
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
