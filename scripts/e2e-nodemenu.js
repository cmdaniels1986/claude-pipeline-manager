(async () => {
  // ensure the graph is showing in the dock
  const nodeEl = [...document.querySelectorAll('.react-flow__node')].find((n) =>
    n.textContent.includes('eligibility')
  )
  if (!nodeEl) return { err: 'no eligibility node in DOM', count: document.querySelectorAll('.react-flow__node').length }
  const r = nodeEl.getBoundingClientRect()
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  nodeEl.dispatchEvent(new MouseEvent('contextmenu', opts))
  await new Promise((res) => setTimeout(res, 300))
  const menu = document.querySelector('.context-menu')
  if (!menu) return { err: 'no context menu appeared' }
  return {
    title: menu.querySelector('.context-menu-title')?.textContent,
    path: menu.querySelector('.ctx-path')?.textContent,
    provenance: menu.querySelector('.ctx-prov')?.textContent?.trim(),
    openBtn: [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('Open source file'))?.textContent,
    openDisabled: [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('Open source file'))?.disabled,
    templateCount: [...menu.querySelectorAll('button')].filter((b) => b.textContent.includes('Validate') || b.textContent.includes('Explain') || b.textContent.includes('breaks') || b.textContent.includes('map')).length
  }
})()
