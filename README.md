# Claude Pipeline Manager

Desktop manager for Claude Code, built for data-engineering work:

- **Multiple Claude terminals** — real `claude` CLI sessions (full TUI, your existing login) in resizable panes, each with its own working folder.
- **Agent launcher** — dropdown of your custom agents (`~/.claude/agents/*.md` and `<project>/.claude/agents/*.md`); pick one to boot a session as that agent, or create a starter agent from the dialog.
- **Live pipeline graph** — a DAG of your data pipeline that the Claude sessions themselves maintain. Every terminal is launched with an injected protocol plus a shared `graph` MCP server (hosted by the app) exposing `graph_get` / `graph_upsert_nodes` / `graph_upsert_edges` / `graph_set_status` / `graph_remove`. As sessions read and edit your SQL/dbt/ETL code they record lineage and validation statuses, and the graph re-renders live. Docked in the main window (drag the divider to resize) or popped out via ⧉.
- **Click-to-prompt impact analysis** — click a node to highlight upstream/downstream; right-click for actions ("Validate downstream impact", "What breaks if this changes?", "Explain this node", "Deep-map lineage") that compose a prompt and type it into the terminal you choose.

Graph state persists per project in `<project>/.claude-manager/graph.json`.

## Prerequisites

- **Node.js 20+** (built on Node 24)
- **Claude Code CLI** installed globally via npm (`npm install -g @anthropic-ai/claude-code`) and logged in. The app resolves the CLI from the npm global install (`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`).
- Windows 10/11 (uses ConPTY; other platforms untested).

## Setup

```
npm install
# if the Electron binary didn't download during install:
node node_modules/electron/install.js
```

## Run

Double-click `Start Pipeline Manager.bat`, or:

```
npm run dev
```

## Notes

- Terminal sessions are real Claude Code — permission prompts, slash commands, MCP servers, and your settings all behave exactly as in a normal terminal.
- The first time a session uses each graph tool you'll get a normal permission prompt; choose "don't ask again in this project" once.
- `scripts/` contains a dev-only harness (CDP driver + headless screen renderer) used for automated verification; it requires the app to be running in dev mode (`--remote-debugging-port=9222`).
