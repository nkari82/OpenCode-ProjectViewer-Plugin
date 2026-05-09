# 기존 시스템 명세 (Analysis)

## 1. API Contract
| Method | Path | Description |
|---|---|---|
| GET | `/api/ping` | Health check |
| GET | `/api/root` | Get project root |
| GET | `/api/projects` | Get project list (sqlite) |
| GET | `/api/events` | SSE event stream |
| POST | `/api/open-project` | Change project root |
| POST | `/api/refresh` | Trigger refresh signal |
| GET | `/api/refresh` | Get last refresh timestamp |
| GET | `/api/tree` | Get directory tree |
| GET | `/api/file` | Read file & detect type |
| GET | `/api/raw` | Raw file stream |
| GET | `/*` | Serve SPA |

## 2. 프로세스 라이프사이클
- **Start**: `plugin.ts`가 `killProcessOnPort` (Windows: `taskkill`) 후 `server/server.js` 실행.
- **Sync**: 1초마다 webview가 `/api/root` + `/api/refresh` polling.
- **Shutdown**:
    - `PARENT_PID` 감시 (setInterval) → `shutdownServer`
    - `SIGINT/SIGTERM/SIGBREAK` → `shutdownServer`
    - `shutdownServer`: `sseClients` 연결 종료, `httpServer` close, `process.exit(0)`.
