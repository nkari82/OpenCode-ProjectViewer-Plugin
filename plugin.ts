import fs from "fs"
import path from "path"
import { spawn, spawnSync } from "child_process"
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
  // 종료 중에는 포트 킬 금지: execSync가 이벤트 루프를 블록킹하면
  // shutdownAbort 전파 및 process.exit(0) 실행이 지연됨.
  if (isShuttingDown) return
  const { execSync } = await import("child_process")
  if (process.platform === "win32") {
    try {
      // findstr 부분 문자열 매칭 대신 전체 netstat 출력을 파싱하여 정확한 포트 비교.
      // 예: findstr :4310 은 :43100 도 매칭하여 VPN/RDP 관련 프로세스를 잘못 종료할 수 있음.
      const out = execSync(`netstat -ano`, { encoding: "utf8" })
      for (const line of out.split("\n")) {
        if (!line.includes("LISTENING")) continue
        const parts = line.trim().split(/\s+/)
        // netstat 포맷: Proto LocalAddr ForeignAddr State PID
        if (parts.length < 5) continue
        const localAddr = parts[1] || ""
        // 정확한 포트 매칭: ":4310"으로 끝나는지 확인 (":43100" 등 제외)
        if (!localAddr.endsWith(`:${port}`)) continue
        const pid = parts[parts.length - 1]
        if (pid && /^\d+$/.test(pid) && pid !== "0" && parseInt(pid) !== process.pid) {
          // /t (tree) 플래그 제거: 자식 프로세스 전체 트리 종료를 방지 (VPN/RDP 끊김 원인)
          try { execSync(`taskkill /f /pid ${pid}`, { stdio: "ignore" }) } catch {}
        }
      }
    } catch {}
  } else {
    try { execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" }) } catch {}
  }
}

function findNodeExecutable(): string {
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\nodejs\\node.exe",
      path.join(process.env.ProgramFiles ?? "", "nodejs", "node.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node.exe"),
      path.join(process.env.APPDATA ?? "", "nvm", "current", "node.exe"),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    try {
      const result = spawnSync("where", ["node"], { encoding: "utf8" })
      const first = result.stdout?.trim().split(/\r?\n/)[0] ?? ""
      if (first && fs.existsSync(first)) return first
    } catch {}
  } else {
    const execPath = process.execPath ?? ""
    if (path.basename(execPath).toLowerCase().replace(/\.exe$/i, "") === "node") return execPath
    for (const c of ["/usr/local/bin/node", "/usr/bin/node"]) {
      if (fs.existsSync(c)) return c
    }
    try {
      const result = spawnSync("which", ["node"], { encoding: "utf8" })
      const first = result.stdout?.trim() ?? ""
      if (first && fs.existsSync(first)) return first
    } catch {}
  }
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

    const nodeExec = findNodeExecutable()
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

function openBrowser(url: string) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref()
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref()
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref()
  }
}

async function syncProjectToViewer(worktree: string) {
  if (!worktree) return
  try {
    await fetchWithTimeout(viewerUrl("/api/open-project"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: worktree }),
    }, 2000)
    pluginLog(`프로젝트 동기화: ${worktree}`)
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

  const ready = await startViewerServer().catch(err => {
    pluginLog(`Server startup error: ${err}`)
    return false
  })
  startWatchdog()

  if (!input) return {}

  if (ready) {
    const worktree = input.worktree
    if (worktree && worktree !== "/" && worktree.length > 2) {
      latestWorktree = worktree
      await syncProjectToViewer(worktree)
    }
  }

  return {
    event: async ({ event }: any) => {
      const worktree = event?.properties?.worktree
      if (worktree && worktree !== "/" && worktree.length > 2) {
        latestWorktree = worktree
        await syncProjectToViewer(worktree)
      }
    },

    config: async (config: any) => {
      if (!config.command) config.command = {}
      config.command["open-view"] = {
        description: "브라우저에서 프로젝트 뷰어 열기 (localhost:4310)",
        template: "The user ran /open-view. The project viewer is opening in the browser at http://localhost:4310. Confirm this in one short sentence.",
      }
    },

    "command.execute.before": async (cmdInput: any, _output: any) => {
      if (cmdInput.command === "open-view") {
        const worktree = latestWorktree || input.worktree
        if (worktree && worktree !== "/" && worktree.length > 2 && await pingServer()) {
          await syncProjectToViewer(worktree)
        }
        openBrowser(viewerUrl())
        pluginLog(`/open-view 실행: 브라우저 열기 ${viewerUrl()}`)
      }
    },
  }
}

export default plugin
export { plugin as server }
