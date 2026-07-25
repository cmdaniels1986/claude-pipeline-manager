// Render the test terminal's raw output buffer into readable screen text.
// Usage: node scripts/cdp.mjs "window.__termDebug.tail(window.__testTermId, 30000)" | node scripts/render-screen.mjs
import xterm from '@xterm/headless'

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  const data = JSON.parse(raw)
  const term = new xterm.Terminal({ cols: 140, rows: 40, allowProposedApi: true })
  term.write(data, () => {
    const buf = term.buffer.active
    const lines = []
    for (let y = 0; y < term.rows; y++) {
      lines.push(buf.getLine(y + buf.viewportY)?.translateToString(true) ?? '')
    }
    // trim trailing blank lines
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    console.log(lines.join('\n'))
  })
})
