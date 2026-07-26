(async () => {
  const cwd = 'C:\\Users\\cmdan\\dev\\demo-pipeline'
  await window.api.setActiveProject(cwd)
  const store = window.__termStore.getState()
  store.addPane({ cwd })
  await new Promise((r) => setTimeout(r, 7000))
  const p = window.__termStore.getState().panes.at(-1)
  // simulate an abnormal exit (as if claude died at startup)
  window.__termStore.getState().setExited(p.termId, 1)
  await new Promise((r) => setTimeout(r, 400))
  const bar = document.querySelector('.terminal-pane-exitbar')
  const badText = document.querySelector('.exit-bad')?.textContent
  const showBtn = document.querySelector('.link-button')
  if (showBtn) showBtn.click()
  await new Promise((r) => setTimeout(r, 200))
  const log = document.querySelector('.exitbar-log')?.textContent ?? ''
  const esc = String.fromCharCode(27)
  return {
    barRendered: !!bar,
    badText,
    logLen: log.length,
    logHasEscapeChars: log.includes(esc),
    logSample: log.slice(0, 180)
  }
})()
