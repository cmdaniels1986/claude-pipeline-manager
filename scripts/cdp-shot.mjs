// Dev-only harness: screenshot the app's main renderer window via CDP.
// Usage: node scripts/cdp-shot.mjs <out.png> [--match <url-substring>]
// Honors CPM_CDP_PORT (default 9222) like cdp.mjs.
import { writeFileSync } from 'fs'
import WebSocket from 'ws'

const out = process.argv[2]
if (!out) {
  console.error('usage: node scripts/cdp-shot.mjs <out.png> [--match <url-substring>]')
  process.exit(1)
}
const matchIdx = process.argv.indexOf('--match')
const matchStr = matchIdx !== -1 ? process.argv[matchIdx + 1] : null
const cdpPort = process.env.CPM_CDP_PORT || '9222'

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const pages = targets.filter((t) => t.type === 'page' && /^http:\/\/localhost:\d+\//.test(t.url))
const target = matchStr
  ? pages.find((t) => t.url.includes(matchStr))
  : pages.find((t) => !t.url.includes('graph') && !t.url.includes('/term/') && !t.url.includes('/preview'))
if (!target) {
  console.error('No matching renderer target. Targets:', pages.map((p) => p.url))
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.on('open', res)
  ws.on('error', rej)
})
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP screenshot timed out')), 30000)
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id === 1) {
      clearTimeout(timer)
      resolve(msg)
    }
  })
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
})
ws.close()
if (!result.result?.data) {
  console.error('screenshot failed:', JSON.stringify(result))
  process.exit(2)
}
writeFileSync(out, Buffer.from(result.result.data, 'base64'))
console.log('wrote', out)
