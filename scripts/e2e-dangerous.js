(async () => {
  const cwd = 'C:\\Users\\cmdan\\dev\\demo-pipeline'
  await window.api.setActiveProject(cwd)
  window.__termStore.getState().addPane({ cwd, color: '#f85149', dangerous: true })
  await new Promise((r) => setTimeout(r, 9000))
  const p = window.__termStore.getState().panes.at(-1)
  return { termId: p.termId, dangerous: p.dangerous, status: p.status }
})()
