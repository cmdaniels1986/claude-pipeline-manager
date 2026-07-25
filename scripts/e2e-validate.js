window.api.promptInject({
  termId: window.__testTermId,
  text:
    'Using the pipeline graph (call graph_get first), find every downstream dependent of "eligibility" and check each one\'s code against the current state of "eligibility". Validate what you can (compile, run tests, dry-run queries — whatever fits this project), then set each checked node\'s status via graph_set_status: "validated" with evidence, "stale" if it needs rework, or "breaking" with exactly what breaks.',
  autoSubmit: true
})
