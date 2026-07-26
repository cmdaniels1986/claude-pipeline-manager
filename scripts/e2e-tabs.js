(async () => {
  const cwd = 'C:\\Users\\cmdan\\dev\\demo-pipeline'
  await window.api.setActiveProject(cwd)
  const store = window.__termStore.getState()
  store.addPane({ cwd })
  store.addPane({ cwd })
  await new Promise((r) => setTimeout(r, 6000))
  const s = window.__termStore.getState()
  return s.panes.map((p) => ({ paneId: p.paneId, termId: p.termId, status: p.status, active: s.activePaneId === p.paneId }))
})()
