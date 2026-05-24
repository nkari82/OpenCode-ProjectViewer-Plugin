# 버그 원인 정리 — NSSM 재시작 / 포트 점유 / 프로젝트 불일치

> 작성일: 2026-05-24  
> 관련 커밋: `cb2e5e1` → `a927dc4` → `fe2e8bd` → `6f3ba9b` → `4b4ce69`

---

## 문제 1 — 재시작 후 포트 4310이 가끔 안 열림 (`cb2e5e1`)

### 원인
| 항목 | 내용 |
|---|---|
| **Keep-alive 연결 미해제** | `server.close()` 호출 시 브라우저 Chrome의 HTTP keep-alive 연결이 살아 있으면 포트가 즉시 반환되지 않음 |
| **재시작 대기 시간 부족** | `taskkill` 이후 서버 바인딩 시도까지의 지연이 200ms로 너무 짧아 Windows가 포트를 회수하기 전에 bind 시도 |
| **EADDRINUSE 재시도 횟수 부족** | 포트 충돌 시 1번만 재시도하고 포기 |

### 수정
- `closeAllConnections()` → `close()` 순서로 명시적 소켓 종료
- 킬 후 대기 시간 200ms → 800ms
- EADDRINUSE 재시도 1회 → 5회 (500ms 간격 backoff)

---

## 문제 2 — NSSM 서비스 재시작 시 서버가 꺼져버림 (`a927dc4`)

### 원인
NSSM이 서비스를 재시작하면 다음 순서로 동작한다:
1. OpenCode(부모 프로세스) 종료
2. plugin.ts(자식)가 부모 PID 사라짐을 감지 → 서버에 shutdown 신호
3. **그런데 이 사이에 OpenCode가 다시 뜨면서 plugin.ts도 재시작됨**
4. 재시작된 plugin.ts가 서버에 새 PID를 등록하러 오지만 서버는 이미 종료 중

| 항목 | 내용 |
|---|---|
| **Watchdog grace period 너무 짧음** | 부모 PID 소멸 감지 후 500ms 안에 새 PID 등록 안 오면 바로 종료 |
| **shutdownServer() 취소 불가** | 한 번 shutdown이 시작되면 새 연결로 취소할 수 없는 구조 |

### 수정
- Watchdog grace period 500ms → **15초** (NSSM이 재시작하는 동안 서버 유지)
- `shutdownServer()`를 취소 가능하게 변경: 2초 안에 새 부모 PID가 `/api/register-pid`로 등록되면 **종료 중단 + HTTP 리스너 재시작**

---

## 문제 3 — 서버 재생성 무한 루프 + shutdown 취소창이 도달 불가 (`fe2e8bd`)

### 원인

#### 3-A. plugin.ts의 always-kill 방식
기존 plugin.ts는 서버를 띄울 때 **무조건 기존 프로세스를 kill하고 새로 spawn**했다.  
→ 재시작 시 서버가 shutdown 취소창(2초) 안에 `register-pid`를 받아도,  
  plugin.ts 쪽에서 그냥 kill해버리니 의미 없음.

#### 3-B. pingServer()가 503을 "서버 없음"으로 해석
서버가 shutdown 중일 때 `/api/ping`에 **503** 을 반환하는데,  
plugin.ts의 `pingServer()`가 503을 "도달 불가"로 처리  
→ `register-pid` 시도 자체를 포기하고 kill+spawn으로 넘어감.

#### 3-C. HTTP 리스너가 취소창 전에 닫힘
`shutdownServer()` 내부에서 `closeAllConnections()` + `server.close()`를 타이머 **전에** 실행  
→ 2초 취소창 동안 HTTP가 이미 닫혀 있어 `register-pid` 요청이 도달 불가.

### 수정
- plugin.ts: always-kill → **register-pid 재사용** 방식으로 교체  
  (register-pid non-ok이면 2.5초 대기 후 재시도, 그래도 안 되면 kill+spawn fallback)
- `pingServer()`: 503(shutting-down) → **"도달 가능"으로 처리** (register-pid 시도 가능하게)
- `shutdownServer()`: HTTP 리스너 종료를 **취소창(2초) 이후**로 이동  
  → register-pid 핸들러에서 즉시 `shuttingDown = false`로 취소 가능

---

## 문제 4 — Chrome keep-alive 좀비 소켓이 포트 4310 점유 (`6f3ba9b`)

### 원인
`process.exit()` 호출 후에도 Chrome의 HTTP keep-alive 연결이 OS 수준에서 소켓을 잡고 있었음.  
Windows에서는 Node.js가 종료돼도 소켓이 완전히 닫히기까지 수십~수백 ms 지연 발생.  
→ 재시작된 서버가 bind 시 포트 충돌.

추가로 watchdog ping timeout이 1.5초로 짧아, 서버가 큰 파일(Shiki 하이라이팅 등) 처리 중일 때  
응답이 늦어지면 **정상인데 죽었다고 오판**해 불필요한 재시작 유발.

### 수정
- 모든 연결을 `Set<Socket>`으로 추적, 종료 시 `socket.destroy()` 강제 호출
- Watchdog ping timeout 1.5초 → **4초**

---

## 문제 5 — 툴바 버튼(탐색기/터미널/VS Code)이 엉뚱한 프로젝트를 열음 (`4b4ce69`)

### 원인
툴바 버튼이 `open-project` 요청을 보낼 때 **body를 비워서** 전송  
→ 서버가 세션별 `sessionRoots` 맵에서 경로를 찾으려 했으나,  
  plugin.ts의 `syncProjectToViewer()`가 세션 ID 없이 `open-project`를 호출하면서  
  `sessionRoots`가 초기화되어 버림  
→ 서버가 전역 `ROOT` 변수(오래된 값 또는 다른 프로젝트)를 fallback으로 사용.

### 수정
- 클라이언트 툴바 버튼: 현재 표시 중인 `root` 값을 **요청 body에 명시적으로 포함**하여 전송

---

## 요약

| 커밋 | 핵심 원인 |
|---|---|
| `cb2e5e1` | keep-alive 소켓 미해제 + 재시작 타이밍 부족 |
| `a927dc4` | Watchdog grace period 500ms 너무 짧음 + shutdown 취소 불가 |
| `fe2e8bd` | always-kill 방식 + 503 오해석 + HTTP가 취소창 전에 닫힘 |
| `6f3ba9b` | Chrome 좀비 소켓 미추적 + ping timeout 너무 짧음 |
| `4b4ce69` | 툴바 요청 body 누락 → stale ROOT fallback |

**공통 근본 원인**: NSSM이 서비스 전체를 재시작할 때 "부모 종료 → 자식 shutdown 시작 → 부모 재시작 → 자식에 새 PID 등록" 사이의 **타이밍 레이스**를 고려하지 않은 설계.
