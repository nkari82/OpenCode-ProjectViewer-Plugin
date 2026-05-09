# AGENTS.md - OpenCode Project Viewer Plugin

## What This Is

OpenCode에서 프로젝트를 선택하면 웹 파일뷰어에 파일 트리가 표시되고, 파일 클릭 시 내용을 미리보는 플러그인.

- React SPA + Express API 기반
- 코드 하이라이팅(Shiki), Markdown 렌더링, Mermaid 렌더링, PDF/HTML 미리보기 지원

## Architecture

- **plugin.ts**: OpenCode plugin entry
  - Viewer 서버(`server/server.js`) child process 실행
  - 포트 4310–4399 스캔
  - 프로젝트 루트 동기화(`/api/open-project`) 및 refresh 신호 전달(`/api/refresh`)
  - `session.created` / `session.updated` / generic `event` 경로 모두 처리
- **server/**: 독립 패키지(별도 `package.json`)
  - `server.js`: Express API + 정적 서빙(`dist/`)
  - `src/`: React SPA (`main.jsx`, `App.jsx`, `styles.css`)
  - `dist/`: 프로덕션 빌드 산출물
  - `vite.config.js`: 프론트엔드 개발 서버(5173)

## Commands

```bash
# install
cd server && npm install

# frontend dev (Vite only)
cd server && npm run dev

# production build
cd server && npm run build
```

테스트/린트/CI 설정은 없음. 루트에 `tsconfig.json`도 없음.

## Runtime Contracts

### Plugin ↔ Viewer
- Viewer server health: `GET /api/ping`
- 프로젝트 루트 조회: `GET /api/root`
- 프로젝트 루트 변경: `POST /api/open-project` with `{ path }`
- 트리 조회: `GET /api/tree`
- 파일 읽기/삭제: `GET /api/file`, `DELETE /api/file?path=...`
- 변경 감지 신호: `POST /api/refresh` (timestamp 갱신), `GET /api/refresh` (현재 timestamp 조회)
- Raw 파일 스트리밍: `GET /api/raw?path=...` (PDF iframe source 등)

### Webview Sync Model
- 웹뷰는 1초 주기로 `/api/root` + `/api/refresh`를 함께 폴링
- 루트 변경 또는 refresh timestamp 변경 시 트리 재로드
- 루트 변경 시 파일 선택 상태/뷰 모드/열린 폴더 상태 초기화

## File Rendering Behavior

| Type | Extension | Rendering |
|---|---|---|
| Code | `.cs`, `.c`, `.cpp`, `.py`, `.js`, `.ts`, `.tsx`, ... | Shiki (`github-dark`) |
| Markdown | `.md`, `.markdown` | markdown-it + highlight.js |
| Diagram | `.puml`, `.mmd` | Mermaid (client-side) |
| HTML | `.html` | Render/Text toggle 지원 |
| PDF | `.pdf` | iframe via `/api/raw` |
| Plain text | unknown/other text | `<pre>` |

추가 UI 규칙:
- 폴더는 기본 접힘(default-collapsed), 클릭으로 펼침/접힘
- 미리보기 불가 파일은 트리에서 disabled 처리(선택 불가)

## Tree & Security Rules

- 트리 제외 디렉터리:
  - `.git`, `node_modules`, `dist`, `.next`, `.turbo`, `.cache`, `.pytest_cache`
- 파일 시스템 접근은 `safeResolve()`로 ROOT 하위만 허용(path traversal 방지)
- `walk()`는 `EPERM`/`EACCES`/`ENOENT`를 건너뛰어 트리 생성 중단을 방지

## Lifecycle & Shutdown

- `plugin.ts`는 로깅을 **console-only**로 수행 (파일 로그 생성 안 함)
- 플러그인 이벤트 처리/루트 동기화는 비차단(fire-and-forget + in-flight coalescing)
- Windows 종료: `taskkill /pid /f /t` (종료 경로에서 sync/async 모두 사용)
- Unix 종료: `SIGTERM`
- `server.js`는 `PARENT_PID` 감시(`process.kill(pid, 0)`)로 부모 종료 시 self-shutdown
- `SIGINT`/`SIGTERM`/`SIGBREAK`/`uncaughtException`/`unhandledRejection` 경로에서 안전 종료 처리

## Port & URLs

- Plugin viewer port range: **4310–4399**
- Default viewer URL: `http://localhost:4310`
- Vite dev URL: `http://localhost:5173` (API 없음)

## Global Install Gotcha

이 프로젝트를 OpenCode global plugins 경로에서 사용할 때는 환경에 따라
`%USERPROFILE%/.config/opencode/plugins/project-viewer.ts`
같은 top-level 엔트리 파일이 필요할 수 있음(실제 구현은 `project-viewer/plugin.ts` 재-export).