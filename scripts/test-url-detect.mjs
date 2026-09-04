// Unit checks for the live-preview dev-server URL detector (pure, no Electron).
// Run: npm run test:preview
import { detectLocalUrls, normalizeLocalUrl, shortUrl } from '../out/.urldetect-under-test.mjs'

let pass = 0
let fail = 0
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`)
}

// ---- framework banners ----
eq('vite', detectLocalUrls('  VITE v7.3.6  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose'), ['http://localhost:5173'])
eq('flask', detectLocalUrls(' * Running on http://127.0.0.1:5000\nPress CTRL+C to quit'), ['http://127.0.0.1:5000'])
eq('flask all interfaces', detectLocalUrls(' * Running on all addresses (0.0.0.0)\n * Running on http://127.0.0.1:5000\n * Running on http://192.168.1.20:5000'), ['http://127.0.0.1:5000'])
eq('django', detectLocalUrls('Starting development server at http://127.0.0.1:8000/\nQuit the server with CTRL-BREAK.'), ['http://127.0.0.1:8000'])
eq('next', detectLocalUrls('   ▲ Next.js 15.1.0\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.5:3000'), ['http://localhost:3000'])
eq('rails', detectLocalUrls('* Listening on http://127.0.0.1:3000\n* Listening on http://[::1]:3000'), ['http://127.0.0.1:3000', 'http://[::1]:3000'])
eq('python http.server (wildcard v6)', detectLocalUrls('Serving HTTP on :: port 8000 (http://[::]:8000/) ...'), ['http://localhost:8000'])
eq('0.0.0.0 bind → localhost', detectLocalUrls('Listening on http://0.0.0.0:8080'), ['http://localhost:8080'])
eq('https', detectLocalUrls('https://localhost:8443/ ready'), ['https://localhost:8443'])
eq('subpath kept', detectLocalUrls('open http://localhost:5000/admin/login to continue'), ['http://localhost:5000/admin/login'])
eq('trailing punctuation stripped', detectLocalUrls('App is up at http://localhost:4000.'), ['http://localhost:4000'])
eq('parenthesised', detectLocalUrls('(see http://localhost:4000)'), ['http://localhost:4000'])
eq('markdown-ish backtick', detectLocalUrls('open `http://localhost:4000` now'), ['http://localhost:4000'])

// ---- noise ----
eq('ansi colored', detectLocalUrls('\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'), ['http://localhost:5173'])
eq('dedupe within chunk', detectLocalUrls('http://localhost:5173/ and again http://localhost:5173'), ['http://localhost:5173'])
eq('excluded app ports', detectLocalUrls('mcp at http://127.0.0.1:53211/mcp and page http://localhost:5173', { excludePorts: [53211] }), ['http://localhost:5173'])
eq('non-loopback ignored', detectLocalUrls('deployed to https://example.com and http://10.0.0.5:3000'), [])
eq('no scheme not detected (too noisy)', detectLocalUrls('listening on localhost:3000'), [])
eq('no urls', detectLocalUrls('plain text with :// but https://'), [])

// ---- chunk-boundary handling ----
eq('trailing fragment held', detectLocalUrls('Local: http://localhost:', { holdTrailing: true }), [])
eq('trailing complete url held too (next chunk re-scans)', detectLocalUrls('go to http://localhost:5173', { holdTrailing: true }), [])
eq('trailing newline releases it', detectLocalUrls('go to http://localhost:5173\n', { holdTrailing: true }), ['http://localhost:5173'])
eq('no hold by default', detectLocalUrls('go to http://localhost:5173'), ['http://localhost:5173'])

// ---- manual entry normalization ----
eq('bare port', normalizeLocalUrl('5173'), 'http://localhost:5173')
eq('host:port', normalizeLocalUrl('localhost:3000'), 'http://localhost:3000')
eq('host:port/path', normalizeLocalUrl('127.0.0.1:8000/admin'), 'http://127.0.0.1:8000/admin')
eq('trailing slash dropped', normalizeLocalUrl('http://localhost:3000/'), 'http://localhost:3000')
eq('query kept', normalizeLocalUrl('http://localhost:3000/?tab=2'), 'http://localhost:3000/?tab=2')
eq('rejects remote', normalizeLocalUrl('https://example.com'), null)
eq('rejects junk', normalizeLocalUrl('not a url'), null)
eq('rejects empty', normalizeLocalUrl('   '), null)
eq('shortUrl', shortUrl('http://localhost:5173/app?x=1'), 'localhost:5173/app?x=1')
eq('shortUrl bare', shortUrl('http://localhost:5173'), 'localhost:5173')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
