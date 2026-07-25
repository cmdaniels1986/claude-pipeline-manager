window.api.promptInject({
  termId: window.__testTermId,
  text:
    'Map this SQL pipeline into the shared pipeline graph: read every file under models/, then record all datasets and their lineage with the graph tools (graph_upsert_nodes / graph_upsert_edges), including the raw source tables. Set meta path for each node. Keep it to what the code actually shows.',
  autoSubmit: true
})
