export interface PromptTemplate {
  id: string
  label: string
  build: (nodeId: string) => string
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'validate-downstream',
    label: '✅ Validate downstream impact',
    build: (id) =>
      `Using the pipeline graph (call graph_get first), find every downstream dependent of "${id}" and check each one's code against the current state of "${id}". Validate what you can (compile, run tests, dry-run queries — whatever fits this project), then set each checked node's status via graph_set_status: "validated" with evidence, "stale" if it needs rework, or "breaking" with exactly what breaks.`
  },
  {
    id: 'what-breaks',
    label: '💥 What breaks if this changes?',
    build: (id) =>
      `I'm considering changing "${id}". Using the pipeline graph (graph_get) and the actual code, explain: which nodes depend on it downstream (direct and transitive), what would likely break and why, and which validations would need to re-run. Do NOT change any code — analysis only.`
  },
  {
    id: 'explain',
    label: '📖 Explain this node',
    build: (id) =>
      `Explain the pipeline node "${id}". Read its source (see its meta.path in graph_get if set): summarize what it produces, its inputs/upstream sources, key transformations or business logic, and who consumes it downstream per the graph. Update the node's description in the graph with a one-line summary via graph_upsert_nodes.`
  },
  {
    id: 'map-around',
    label: '🔍 Deep-map lineage around this node',
    build: (id) =>
      `Investigate the code around pipeline node "${id}" and verify/extend its lineage in the graph: confirm its upstream inputs and downstream consumers in the actual code, add any missing nodes/edges with graph_upsert_nodes/graph_upsert_edges, and correct anything wrong. Record only lineage you confirm in code.`
  }
]
