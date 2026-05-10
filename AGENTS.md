# AGENTS.md - OpenCode Project Viewer Plugin

## What This Is

OpenCode에서 프로젝트를 선택하면 웹 파일뷰어에 파일 트리가 표시되고, 파일 클릭 시 내용을 미리보는 플러그인.
- React SPA + Express API 기반
- 기술 스택: Express(서버), React+Vite(프론트), Shiki(코드 하이라이팅), markdown-it(마크다운), Mermaid(다이어그램)

## Architecture

- **plugin.ts**: OpenCode 플러그인 엔트리 (프로젝트 루트에서 실행)
  - `apps/server/server.ts` child process 관리 (포트 4310 고정, EADDRINUSE 시 자동 종료)
  - `session.created` / `session.updated` / `file.watcher.updated` 이벤트 처리
- **apps/server/**: 독립 패키지 (`viewer-server`)
  - Express API 서버, 정적 파일(`apps/client/dist`) 서빙
  - 프로젝트 파일 접근은 `safeResolve()` (ROOT 하위만 허용, Path Traversal 방지)
- **apps/client/**: 독립 패키지 (`viewer-client`, React)
  - 웹뷰가 1초 주기로 `/api/root` + `/api/refresh` 폴링

## Development Commands

```bash
# 루트 패키지 설치
pnpm install

# 개발 서버 실행
pnpm dev # (루트에서)
```

## Runtime Contracts

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ping` | GET | 서버 상태 확인 |
| `/api/root` | GET | 프로젝트 루트 경로 조회 |
| `/api/open-project` | POST | 프로젝트 루트 변경 (`{ path }`) |
| `/api/tree` | GET | 프로젝트 파일 트리 조회 |
| `/api/file` | GET | 파일 내용 읽기 |
| `/api/refresh` | POST/GET | 트리 변경 신호 전송/조회 (`refreshAt` 활용) |
| `/api/raw` | GET | 원본 파일 스트리밍 (PDF/이미지 등) |

## Key Gotchas

1. **포트 4310**: 플러그인은 항상 4310 포트를 점유하려고 시도함. 서버 시작 전 `killProcessOnPort()`로 기존 프로세스 제거.
2. **이벤트 모델**: 서버-웹뷰 간 SSE/Push는 삭제됨. 웹뷰가 `/api/root` + `/api/refresh`를 1초 주기로 폴링하여 상태 동기화.
3. **파일 트리**: `walk()` 함수는 `EPERM`/`EACCES`/`ENOENT` 에러를 건너뛰어 트리 생성 실패 방지. 특정 폴더(`.git`, `node_modules` 등)는 스캔 제외.
4. **글로벌 환경**: OpenCode 글로벌 플러그인 경로에서 동작하려면 `~/.config/opencode/plugins/project-viewer.ts` 같은 심볼릭 링크/Shim 파일 필요.
5. **런타임**: `plugin.ts`는 반드시 `process.env.PARENT_PID`를 서버 환경변수로 전달하여, 플러그인 종료 시 서버도 자가 종료(`process.kill(PARENT_PID, 0)` 감시)하도록 설계됨.
6. **이미지/기타**: `.png`, `.svg` 등의 이미지는 `/api/raw` 호출, PlantUML은 PlantUML 서버 SVG 렌더링.
7. **코드 폴딩**: 웹뷰(`App.jsx`)는 코드 블록별 폴딩/복사 기능 포함.
