import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let viewerProcess: any = null
let currentPort = 4310
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let isShuttingDown = false
// 모든 fetch() 요청을 일괄 취소하는 글로벌 AbortController.
// shutdown 시 abort()하면 Bun의 fetch connection pool이 즉시 해제되어
// event loop가 자연 종료됨 (process.exit() 없이).
let shutdownAbort = new AbortController()

const PLUGIN_LOG = path.join(__dirname, "plugin.log")
function pluginLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(PLUGIN_LOG, line) } catch {}
  console.log("[project-viewer]", msg)
}
pluginLog(`모듈 로드됨 __dirname=${__dirname} pid=${process.pid} execPath=${process.execPath}`)

function handleShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true
  pluginLog(`종료 시그널 수신: ${signal} — 플러그인 리소스 정리`)
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  // 모든 pending fetch()를 즉시 abort → Bun fetch connection pool 해제
  // ping loop 내 shutdownAbort 연결 sleep도 즉시 깨어남
  shutdownAbort.abort()
  pluginLog("fetch 전체 취소 완료 — process.exit(0)")
  // 즉시 종료: 1000ms 딜레이 제거.
  // 이전 1000ms 대기는 "자연 종료 기다리기"였으나 Bun/OpenCode event loop는
  // WebSocket·DB 때문에 자연 종료되지 않아 항상 process.exit(0)이 실행됐음.
  // → 딜레이만큼 port 4096이 더 오래 점유되어 NSSM 재시작 시 ghost socket 유발.
  // process.exit(0)은 정상 종료(ExitProcess)이므로 OS가 4096 소켓을 즉시 반환.
  process.exit(0)
}

process.on("SIGINT", () => handleShutdown("SIGINT"))
process.on("SIGTERM", () => handleShutdown("SIGTERM"))
if (process.platform === "win32") {
  process.on("SIGBREAK", () => handleShutdown("SIGBREAK"))
}

function viewerUrl(pathname = "") {
  return `http://127.0.0.1:${currentPort}${pathname}`
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // shutdown 시 shutdownAbort.abort()가 이 요청도 즉시 취소
  const onShutdown = () => controller.abort()
  shutdownAbort.signal.addEventListener("abort", onShutdown, { once: true })
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    shutdownAbort.signal.removeEventListener("abort", onShutdown)
  }
}

async function pingServer() {
  try {
    const res = await fetchWithTimeout(viewerUrl("/api/ping"), {})
    // 503 = server alive but shutting down; still reachable for register-pid
    return res.status === 200 || res.status === 503
  } catch {
    return false
  }
}

async function killProcessOnPort(port: number) {
  // 종료 중에는 포트 킬 금지
  if (isShuttingDown) return
  // execSync → execAsync: 이벤트 루프 블로킹 제거.
  // 이전: execSync('netstat -ano') 가 수백ms 동안 OpenCode 이벤트 루프를 점유.
  const { exec } = await import("child_process")
  const { promisify } = await import("util")
  const execAsync = promisify(exec)
  if (process.platform === "win32") {
    try {
      // findstr 부분 문자열 매칭 대신 전체 netstat 출력을 파싱하여 정확한 포트 비교.
      // 예: findstr :4310 은 :43100 도 매칭하여 VPN/RDP 관련 프로세스를 잘못 종료할 수 있음.
      const { stdout } = await execAsync("netstat -ano")
      const pidsToKill: string[] = []
      for (const line of stdout.split("\n")) {
        if (!line.includes("LISTENING")) continue
        const parts = line.trim().split(/\s+/)
        // netstat 포맷: Proto LocalAddr ForeignAddr State PID
        if (parts.length < 5) continue
        const localAddr = parts[1] || ""
        // 정확한 포트 매칭: ":4310"으로 끝나는지 확인 (":43100" 등 제외)
        if (!localAddr.endsWith(`:${port}`)) continue
        const pid = parts[parts.length - 1]
        if (pid && /^\d+$/.test(pid) && pid !== "0" && parseInt(pid) !== process.pid) {
          pidsToKill.push(pid)
        }
      }
      for (const pid of pidsToKill) {
        // /t (tree) 플래그 제거: 자식 프로세스 전체 트리 종료를 방지 (VPN/RDP 끊김 원인)
        try { await execAsync(`taskkill /f /pid ${pid}`) } catch {}
      }
    } catch {}
  } else {
    try { await execAsync(`fuser -k ${port}/tcp`) } catch {}
  }
}

// spawnSync → async exec + 결과 캐시: 이벤트 루프 블로킹 제거.
// 이전: spawnSync('where', ['node']) 가 프로세스 생성 완료까지 이벤트 루프 점유.
let cachedNodeExec: string | null = null
async function findNodeExecutable(): Promise<string> {
  if (cachedNodeExec) return cachedNodeExec
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\nodejs\\node.exe",
      path.join(process.env.ProgramFiles ?? "", "nodejs", "node.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node.exe"),
      path.join(process.env.APPDATA ?? "", "nvm", "current", "node.exe"),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) { cachedNodeExec = c; return c }
    }
    try {
      const { exec } = await import("child_process")
      const { promisify } = await import("util")
      const { stdout } = await promisify(exec)("where node")
      const first = stdout.trim().split(/\r?\n/)[0] ?? ""
      if (first && fs.existsSync(first)) { cachedNodeExec = first; return first }
    } catch {}
  } else {
    const execPath = process.execPath ?? ""
    if (path.basename(execPath).toLowerCase().replace(/\.exe$/i, "") === "node") {
      cachedNodeExec = execPath; return execPath
    }
    for (const c of ["/usr/local/bin/node", "/usr/bin/node"]) {
      if (fs.existsSync(c)) { cachedNodeExec = c; return c }
    }
    try {
      const { exec } = await import("child_process")
      const { promisify } = await import("util")
      const { stdout } = await promisify(exec)("which node")
      const first = stdout.trim() ?? ""
      if (first && fs.existsSync(first)) { cachedNodeExec = first; return first }
    } catch {}
  }
  cachedNodeExec = "node"
  return "node"
}

let latestWorktree = ""
let startViewerPromise: Promise<boolean> | null = null
async function startViewerServer() {
  if (startViewerPromise) return startViewerPromise

  const p = (async () => {
    pluginLog("startViewerServer() 진입")

    if (await pingServer()) {
      pluginLog("기존 서버 감지 — PID 등록 시도")
      try {
        const regRes = await fetchWithTimeout(viewerUrl("/api/register-pid"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pid: process.pid }),
        })
        if (regRes && regRes.ok) {
          pluginLog("PID 등록 성공 — 서버 재사용")
          return true
        }
        // register-pid 실패 = 서버가 2s 취소 창 안에 있음, 잠시 대기 후 재시도
        pluginLog("register-pid 실패 — 2.5s 후 재시도")
        await new Promise(r => setTimeout(r, 2500))
        if (await pingServer()) {
          const retry = await fetchWithTimeout(viewerUrl("/api/register-pid"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pid: process.pid }),
          })
          if (retry && retry.ok) {
            pluginLog("PID 재등록 성공 — 서버 재사용")
            return true
          }
        }
        pluginLog("register-pid 재시도 실패 — 새 서버 스폰")
      } catch {
        pluginLog("register-pid 오류 — 새 서버 스폰")
      }
    }

    pluginLog(`포트 ${currentPort} 킬 중...`)
    await killProcessOnPort(currentPort)

    const serverScript = path.join(__dirname, "apps", "server", "dist", "server.js")
    if (!fs.existsSync(serverScript)) {
      pluginLog(`서버 스크립트 없음: ${serverScript}`)
      return false
    }

    const nodeExec = await findNodeExecutable()
    const logPath = path.join(__dirname, "server.log")
    pluginLog(`spawn: ${nodeExec} ${serverScript}`)
    pluginLog(`server.log → ${logPath}`)
    let logFd: number | undefined
    try {
      logFd = fs.openSync(logPath, "a")
      fs.writeSync(logFd, `\n--- [${new Date().toISOString()}] spawning with: ${nodeExec} ---\n`)
    } catch (e) {
      pluginLog(`server.log 열기 실패: ${e}`)
    }

    viewerProcess = spawn(nodeExec, [serverScript], {
      cwd: path.dirname(serverScript),
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
      detached: true,
      env: { ...process.env, PORT: currentPort.toString(), PARENT_PID: process.pid.toString() }
    })
    viewerProcess.unref()
    if (logFd !== undefined) try { fs.closeSync(logFd) } catch {}

    viewerProcess.on("error", (err: Error) => {
      pluginLog(`Spawn 실패: ${err.message}`)
      viewerProcess = null
      startViewerPromise = null
    })

    viewerProcess.on("exit", (code: number | null) => {
      pluginLog(`서버 프로세스 종료 code=${code}`)
      viewerProcess = null
      startViewerPromise = null
    })

    for (let i = 0; i < 60; ++i) {
      if (isShuttingDown) return false
      if (await pingServer()) {
        pluginLog(`서버 준비 완료 (${i * 0.5}s)`)
        return true
      }
      // shutdownAbort에 연결된 sleep: abort() 시 즉시 깨어남
      // (기존 plain setTimeout은 abort 신호를 무시해 shutdown 지연 유발)
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 500)
        if (shutdownAbort.signal.aborted) { clearTimeout(timer); resolve(); return }
        const onAbort = () => { clearTimeout(timer); resolve() }
        shutdownAbort.signal.addEventListener("abort", onAbort, { once: true })
      })
    }
    pluginLog(`서버 30초 내 준비 안됨 (node: ${nodeExec})`)
    return false
  })()

  startViewerPromise = p
  p.then(ok => { if (!ok && startViewerPromise === p) startViewerPromise = null }).catch(() => { startViewerPromise = null })
  return p
}

async function openBrowser(url: string) {
  if (process.platform === "win32") {
    const { exec } = await import("child_process")
    const { promisify } = await import("util")
    const execAsync = promisify(exec)

    // SESSIONNAME이 없거나 "Services"이면 Session 0 (NSSM 서비스 컨텍스트).
    // Session 0에서는 spawn("cmd /c start ...")이 유저 데스크탑(Session 1)에 창을 열지 못함.
    // schtasks /IT 플래그: Interactive Task — 로그온된 유저의 세션(Session 1)에서 실행됨.
    const sessionName = process.env.SESSIONNAME ?? ""
    const isSession0 = !sessionName || sessionName === "Services"
    pluginLog(`openBrowser: sessionName="${sessionName}" isSession0=${isSession0} url=${url}`)

    if (isSession0) {
      const taskName = "opencode-viewer-open"
      // schtasks /tr 값 안에 따옴표를 중첩하면 파싱 오류 발생.
      // http://127.0.0.1:4310 은 공백이 없으므로 따옴표 없이 그대로 사용.
      // /IT : Interactive Task — 로그온된 유저의 세션(Session 1)에서 실행됨.
      // /run /tn : 예약 시간 무관하게 즉시 실행. (/I 플래그는 존재하지 않음)
      const tr = `explorer.exe ${url}`
      try {
        await execAsync(`schtasks /delete /f /tn "${taskName}"`, { timeout: 3000 }).catch(() => {})
        await execAsync(`schtasks /create /f /sc ONCE /tn "${taskName}" /tr "${tr}" /st 00:00 /IT`, { timeout: 3000 })
        await execAsync(`schtasks /run /tn "${taskName}"`, { timeout: 3000 })
        pluginLog(`schtasks /IT 브라우저 열기 성공`)
      } catch (e: any) {
        pluginLog(`schtasks 실패: ${e?.message}`)
      } finally {
        execAsync(`schtasks /delete /f /tn "${taskName}"`).catch(() => {})
      }
    } else {
      // 일반 유저 세션: 직접 spawn
      const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
      child.on("error", (e) => pluginLog(`openBrowser spawn 오류: ${e.message}`))
      child.unref()
    }
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref()
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref()
  }
}

// force=false: 백그라운드 동기화 — 브라우저가 수동 선택한 세션 루트는 유지
// force=true : /open-view 전용 — sessionRoots 초기화로 모든 탭 강제 전환
async function syncProjectToViewer(worktree: string, force = false) {
  if (!worktree) return
  try {
    await fetchWithTimeout(viewerUrl("/api/open-project"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: worktree, force }),
    }, 2000)
    pluginLog(force ? `강제 프로젝트 전환: ${worktree}` : `프로젝트 동기화: ${worktree}`)
  } catch {}
}

function startWatchdog() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(async () => {
    if (isShuttingDown) return
    // Use a longer timeout than pingServer's default (1.5s) to reduce false positives
    // when the server is busy with large file processing (Shiki, PDF).
    const alive = await fetchWithTimeout(viewerUrl("/api/ping"), {}, 4000)
      .then(r => r.status === 200 || r.status === 503)
      .catch(() => false)
    if (!alive) {
      // 종료 중에는 재시작 금지: startViewerServer() 안의 killProcessOnPort(execSync)가
      // 이벤트 루프를 블록킹해 process.exit(0) 실행을 지연시킬 수 있음.
      if (isShuttingDown) return
      pluginLog("서버 다운, 재시작...")
      startViewerPromise = null
      viewerProcess = null
      await startViewerServer().catch(() => {})
    }
  }, 30_000)
  watchdogTimer.unref()
}

const plugin = async (input?: any, _options?: any): Promise<any> => {
  pluginLog(`plugin() 호출됨`)

  // OpenCode를 블로킹하지 않도록 서버 시작을 백그라운드로 처리.
  // 이전: await startViewerServer() → 서버 부팅 시 최대 30초 OpenCode 블록.
  // 수정: fire-and-forget, 서버 준비 완료 후 초기 동기화도 백그라운드 체인.
  const startupPromise = startViewerServer().catch(err => {
    pluginLog(`Server startup error: ${err}`)
    return false
  })
  startWatchdog()

  if (!input) return {}

  const worktree = input.worktree
  if (worktree && worktree !== "/" && worktree.length > 2) {
    latestWorktree = worktree
    // 서버 준비 완료 후 동기화 — await 없이 백그라운드 실행
    startupPromise.then(ready => {
      if (ready) syncProjectToViewer(worktree).catch(() => {})
    })
  }

  return {
    event: async ({ event }: any) => {
      const worktree = event?.properties?.worktree
      if (worktree && worktree !== "/" && worktree.length > 2) {
        latestWorktree = worktree
        // fire-and-forget: OpenCode 이벤트 핸들러를 블로킹하지 않음.
        // 이전: await syncProjectToViewer() → 이벤트마다 최대 2초 블록.
        syncProjectToViewer(worktree).catch(() => {})
      }
    },

    config: async (config: any) => {
      if (!config.command) config.command = {}
      config.command["open-view"] = {
        description: "브라우저에서 프로젝트 뷰어 열기 (localhost:4310)",
        // template을 빈 문자열로 설정 — LLM 호출 최소화 시도.
        // OpenCode 플러그인 API는 action-only 명령을 공식 지원하지 않으나,
        // output.parts를 before 훅에서 채워두면 LLM이 스킵될 수 있음.
        template: "",
      }
    },

    "command.execute.before": async (cmdInput: any, output: any) => {
      if (cmdInput.command === "open-view") {
        // worktree 소스 우선순위:
        //   1) cmdInput.worktree          — /open-view 실행 시점의 현재 세션 (db 미등록 포함)
        //   2) cmdInput.properties.worktree — 일부 OpenCode 버전의 구조
        //   3) latestWorktree             — 마지막 이벤트에서 받은 worktree
        //   4) input.worktree             — 플러그인 초기화 시점의 worktree
        const worktree = cmdInput?.worktree
          || cmdInput?.properties?.worktree
          || latestWorktree
          || input?.worktree
        pluginLog(`/open-view: worktree=${worktree || "(없음)"} cmdInput=${JSON.stringify(cmdInput)}`)
        if (worktree && worktree !== "/" && worktree.length > 2 && await pingServer()) {
          // force=true: sessionRoots 초기화 → 기존 브라우저 탭도 강제 전환
          await syncProjectToViewer(worktree, true)
        }
        await openBrowser(viewerUrl())
        pluginLog(`브라우저 열기 완료: ${viewerUrl()}`)
        // output.parts를 미리 채워서 LLM 스킵 시도.
        // OpenCode가 parts가 이미 채워져 있으면 LLM을 호출하지 않을 수 있음.
        try {
          if (output && Array.isArray(output.parts)) {
            output.parts.push({ type: "text", text: "프로젝트 뷰어를 브라우저에서 열었습니다." })
          }
        } catch {}
      }
    },
  }
}

export default plugin
export { plugin as server }
