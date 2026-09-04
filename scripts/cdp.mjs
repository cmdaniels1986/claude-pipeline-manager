// Dev-only harness: evaluate a JS expression in the app's renderer via CDP.
// Usage: node scripts/cdp.mjs "<expression>" [--graph]
//        node scripts/cdp.mjs --file <path.js> [--graph]   (avoids shell escaping)
import { readFileSync } from 'fs'
import WebSocket from 'ws'

const wantGraphWindow = process.argv.includes('--graph')
const fileIdx = process.argv.indexOf('--file')
const expression = fileIdx !== -1 ? readFileSync(process.argv[fileIdx + 1], 'utf8') : process.argv[2]
if (!expression) {
  console.error('usage: node scripts/cdp.mjs "<expression>" | --file <path.js> [--graph]')
  process.exit(1)
}

const matchIdx = process.argv.indexOf('--match')
const matchStr = matchIdx !== -1 ? process.argv[matchIdx + 1] : null

const cdpPort = process.env.CPM_CDP_PORT || '9222'
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
// vite picks the next port when 5173 is busy — match any local renderer page
const pages = targets.filter((t) => t.type === 'page' && /^http:\/\/localhost:\d+\//.test(t.url))
const target = matchStr
  ? pages.find((t) => t.url.includes(matchStr))
  : pages.find((t) =>
      wantGraphWindow ? t.url.includes('graph') : !t.url.includes('graph') && !t.url.includes('/term/')
    )
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
  const id = 1
  const timer = setTimeout(() => reject(new Error('CDP evaluate timed out')), 30000)
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id === id) {
      clearTimeout(timer)
      resolve(msg)
    }
  })
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    })
  )
})

ws.close()
if (result.result?.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(result.result.exceptionDetails, null, 2))
  process.exit(2)
}
console.log(JSON.stringify(result.result?.result?.value ?? result.result, null, 2))
