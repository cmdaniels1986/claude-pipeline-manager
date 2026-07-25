(async () => {
  const cwd = 'C:\\Users\\cmdan\\dev\\demo-pipeline'
  await window.api.setActiveProject(cwd)
  const info = await window.api.termCreate({ cwd, cols: 140, rows: 40 })
  window.__testTermId = info.termId
  return info
})()
