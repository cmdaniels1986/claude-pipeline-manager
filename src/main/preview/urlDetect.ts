import { stripAnsi } from '../usage/limitDetect'

/**
 * Find local dev-server URLs in raw PTY output.
 *
 * Every web stack prints its address on startup — Vite ("Local: http://localhost:5173/"),
 * Flask ("Running on http://127.0.0.1:5000"), Django ("Starting development server at
 * http://127.0.0.1:8000/"), Next ("- Local: http://localhost:3000"), Rails ("Listening on
 * http://127.0.0.1:3000"), `python -m http.server` ("(http://[::]:8000/)") — so a scheme +
 * loopback host + port is the one framework-independent signal. Same class of TUI-text
 * scrape as the usage-limit and activity detectors: tolerant, and only ever *offers*.
 */
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))?(?:\/[^\s"'<>)\]`]*)?/gi

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'])
// wildcard binds aren't browsable as written — the page is reachable on localhost
const WILDCARD_HOSTS = new Set(['0.0.0.0', '[::]'])

/** Canonical form of a loopback URL: wildcard hosts → localhost, trailing punctuation dropped,
 *  no trailing slash on a bare origin. Returns null for anything that isn't a loopback http(s) URL. */
export function normalizeLocalUrl(raw: string): string | null {
  let s = raw.trim().replace(/[.,;:!?)\]]+$/, '')
  if (!/^https?:\/\//i.test(s)) {
    // "5173", "localhost:3000", "127.0.0.1:8000/admin" typed by hand
    if (/^\d{2,5}(\/.*)?$/.test(s)) s = `http://localhost:${s}`
    else if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d{2,5})?(\/.*)?$/i.test(s)) s = `http://${s}`
    else return null
  }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  // WHATWG URL keeps the brackets on IPv6 hostnames ("[::1]")
  const h = u.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(h)) return null
  const host = WILDCARD_HOSTS.has(h) ? 'localhost' : h
  const port = u.port ? `:${u.port}` : ''
  const path = u.pathname === '/' && !u.search && !u.hash ? '' : `${u.pathname}${u.search}${u.hash}`
  return `${u.protocol}//${host}${port}${path}`
}

export interface DetectOptions {
  /** ports that belong to the app itself (MCP, telemetry, devtools) — never offered */
  excludePorts?: number[]
  /** skip a match that runs right up to the end of `text` — a PTY chunk can cut a URL
   *  mid-port ("http://localhost:" + "5173"), and that fragment would otherwise pass as
   *  a bare "http://localhost". The caller re-scans with the next chunk appended. */
  holdTrailing?: boolean
}

/** Every distinct loopback URL in `text` (raw PTY output), in order of first appearance. */
export function detectLocalUrls(text: string, opts: DetectOptions = {}): string[] {
  const clean = stripAnsi(text)
  const exclude = new Set(opts.excludePorts ?? [])
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of clean.matchAll(URL_RE)) {
    if (opts.holdTrailing) {
      // nothing after the match, or only the start of a port (":" / ":5") the regex
      // couldn't take yet → the rest is probably still in flight
      const rest = clean.slice(m.index + m[0].length)
      if (/^(:\d?)?$/.test(rest)) continue
    }
    const url = normalizeLocalUrl(m[0])
    if (!url) continue
    const port = Number(m[1] ?? (url.startsWith('https') ? 443 : 80))
    if (exclude.has(port)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** Compact display form of a preview URL ("localhost:5173/admin"). */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' && !u.search ? '' : u.pathname + u.search
    return `${u.host}${path}`
  } catch {
    return url
  }
}
