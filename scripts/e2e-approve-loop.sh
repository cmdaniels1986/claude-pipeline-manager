#!/bin/bash
# Auto-approve validation permission prompts until node statuses change in graph.json
cd "$(dirname "$0")/.."
GRAPH=C:/Users/cmdan/dev/demo-pipeline/.claude-manager/graph.json
for i in $(seq 1 20); do
  sleep 8
  node scripts/cdp.mjs "window.__termDebug.tail(window.__testTermId, 30000)" > /tmp/tail.json 2>/dev/null
  SCREEN=$(node scripts/render-screen.mjs < /tmp/tail.json)
  if echo "$SCREEN" | grep -q "Do you want to proceed"; then
    echo "[$i] approving:"
    echo "$SCREEN" | grep -B3 "Do you want to proceed" | head -5
    node scripts/cdp.mjs "window.api.termInput(window.__testTermId, '1')" > /dev/null
  elif node -e "const g=require('$GRAPH'); process.exit(g.nodes.some(n=>n.status!=='unknown')?0:1)" 2>/dev/null; then
    echo "[$i] STATUSES CHANGED"
    break
  else
    echo "[$i] working..."
  fi
done
node -e "const g=require('$GRAPH'); console.log(g.nodes.map(n=>n.id+' => '+n.status+(n.statusNote?' | '+n.statusNote.slice(0,90):'')).join('\n'))"
