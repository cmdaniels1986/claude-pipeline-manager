(async () => {
  const s = window.__termStore.getState()
  s.addPane({ cwd: 'C:\\Users\\cmdan\\dev\\demo-pipeline', color: '#bc8cff' })
  await new Promise((r) => setTimeout(r, 5000))
  const p = window.__termStore.getState().panes.at(-1)
  const tabs = [...document.querySelectorAll('.tab')]
  return { color: p.color, status: p.status, termColorFromMain: (await window.api.termList()).map(t => t.color) }
})()
