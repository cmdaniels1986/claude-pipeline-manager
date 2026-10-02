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

## Live Preview (web work)

The **🖥 Live Preview** header button opens an embedded browser beside the terminals for whatever web app Claude is building — any stack (Vite/React, Next, Flask, Django, static HTML…), since every one of them ends up as a URL on localhost.

- **Finding the page**: agents call the `preview_set` MCP tool when they start a dev server (the injected protocol tells them to), the app also spots any `http://localhost:…` / `127.0.0.1:…` URL printed in a terminal (Vite, Flask, Django, Next, Rails banners…), and you can type a port or URL into the bar. The first server seen is shown automatically; later ones are offered as "new server" chips and listed under **servers ▾**. The URL is remembered per project.
- **Reloading**: pages with a hot-reload client (Vite, Next, webpack, Parcel, live-reload) update themselves and the pane shows an ⚡ badge. For everything else the pane reloads when files in the project change (toggle **⟳ auto**), and agents can call `preview_reload`.
- **Closing the loop with Claude**: **📸** pastes a screenshot of the page into a Claude session (pick the session in the dropdown when more than one is running), then you describe what to change and press Enter. Browser console errors/warnings collect in a badge; **Send to Claude** forwards them as a bug report.
- Viewport presets (phone / tablet / desktop) scale to fit the panel; **⧉** pops the preview into its own window.
- If the server isn't up yet (or is restarting) the pane shows a "can't reach" overlay and retries every few seconds.

## Memory, Global Memory and linked memory

Every terminal starts with your saved Claude memory: the app injects **every** Claude Code memory store on the machine (a normal `claude` session only sees the one nearest its folder). The **🧠 Memory** header button shows what was found and roughly how many tokens it adds.

Two more kinds of memory are managed in the same panel. Both are app-wide (every project, every terminal):

- **🌐 Global Memory**: a folder you choose (**Choose location…**) that terminals save to when you tell one *"save this to global memory"*. They call the `global_memory_save` MCP tool, which writes a normal Claude memory file (frontmatter + body, stamped with who saved it) and keeps the folder's `MEMORY.md` index up to date. Pick a shared or synced folder (Google Drive, OneDrive, Dropbox…) so other people can load it too. Anyone who chooses the same folder as their own Global Memory loads it **and** can add to it. **＋ Add memory files…** copies memory files you pick (for example from your own memory under `~/.claude/projects/…/memory`) into it. Other tools: `global_memory_list`, `global_memory_remove`. Ordinary "remember this" requests still go to Claude's personal memory.
- **🔗 Linked memory**: someone else's memory you browse to (**Link file…** / **Link folder…**): a `MEMORY.md` (links its whole folder), a memory folder, or one memory file. It's loaded into every new terminal, read-only. A linked folder that's already loaded another way (your Global Memory, or a store on this machine) isn't injected twice. An unreachable path (drive unplugged, sync app off) is flagged and skipped.

The locations are saved in `<app data>/memory-sources.json`. New terminals pick up changes immediately; an already-running session can call `global_memory_list` to see entries added since it started.

## Notes

- Terminal sessions are real Claude Code — permission prompts, slash commands, MCP servers, and your settings all behave exactly as in a normal terminal.
- The first time a session uses each graph tool you'll get a normal permission prompt; choose "don't ask again in this project" once.
- `scripts/` contains a dev-only harness (CDP driver + headless screen renderer) used for automated verification; it requires the app to be running in dev mode (`--remote-debugging-port=9222`). To check changes without touching the app you're using, start a second dev instance with `CPM_CDP_PORT` (its own debug port) and `CPM_USER_DATA` (its own app-data folder; its window opens without stealing focus).
