# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An OpenCode plugin that renders a file-tree browser and file preview UI at `http://localhost:4310`. When OpenCode selects a project, the plugin updates the viewer in real time.

## Workspace Structure

pnpm monorepo with two apps:

- `plugin.ts` — OpenCode plugin entry point (spawns the server, handles events)
- `apps/server/` (`viewer-server`) — Express API + WebSocket server
- `apps/client/` (`viewer-client`) — React/Vite SPA served from the same port

## Commands

```bash
pnpm install          # install all workspace deps
pnpm build            # build server (tsc) + client (vite)
pnpm dev              # run server + client in parallel (watch mode)
pnpm dev:server       # server only (tsx watch)
pnpm dev:client       # client only (vite, port 5173)
```

After `pnpm build`, the server serves the client's `dist/` statically, so the full app runs on port 4310.

## Architecture

### `plugin.ts`
- Spawns `apps/server/dist/server.js` as a child process, passing `PARENT_PID`
- Kills any existing process on port 4310 before starting (`taskkill` on Windows, `fuser` on Unix)
- Listens to OpenCode events (`session.created`, `session.updated`, `file.watcher.updated`) and POSTs `/api/refresh` on file changes
- Server monitors `PARENT_PID` and self-exits when the parent plugin process dies

### `apps/server/server.ts`
Key API routes:
| Route | Purpose |
|---|---|
| `GET /api/ping` | Health check |
| `GET /api/root` | Current project root path |
| `POST /api/open-project` | Change root (`{ path }`) |
| `GET /api/tree` | Directory tree (skips `.git`, `node_modules`, `dist`, etc.) |
| `GET /api/file` | File content with Shiki syntax highlighting |
| `GET /api/raw` | Stream raw binary files (images, PDFs) |
| `POST /api/refresh` | Signal that file tree changed |
| `GET /api/projects` | List projects from OpenCode's SQLite DB |

- `safeResolve()` enforces all file access stays under the current project root (path traversal protection)
- Shiki handles syntax highlighting for 25+ languages
- markdown-it (with anchor + TOC plugins) renders Markdown
- PlantUML diagrams are rendered via an external PlantUML server

### `apps/client/src/App.tsx`
- Polls `/api/root` and `/api/refresh` every ~5 seconds to sync state (no push/SSE)
- Renders file tree, file preview (code, markdown, mermaid, images, PDFs)
- Symbol sidebar extracted from `apps/server/symbolExtractor.ts` (regex-based; supports TS/JS, Python, Rust, Go, C++, Java, C#, Markdown)
- Code blocks support fold/copy; Mermaid diagrams render inline

## Key Constraints

- Port is hardcoded to **4310** — do not change without updating `plugin.ts` and docs
- File access is always relative to the active project root; `safeResolve()` must be used for all `fs` operations on user-supplied paths
- The client polling interval controls perceived responsiveness; it currently polls every ~5 seconds
- `apps/client/dist/` and `apps/server/dist/` are **not committed** (covered by `.gitignore`); run `pnpm build` after cloning or changing source before the server can serve the UI
