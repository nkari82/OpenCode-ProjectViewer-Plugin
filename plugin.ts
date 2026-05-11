import fs from "fs"
import path from "path"
import { spawn, spawnSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let viewerProcess: any = null
let currentPort = 4310
let isShuttingDown = false
let watchdogTimer: ReturnType<typeof setInterval> | null = null
// ownsServer: true = we spawned it (kill on exit), false = was already running (leave it)
let ownsServer = false

// ── 플러그인 로드 확인용 로그 ──────────────────────────────────────────
const PLUGIN_LOG = path.join(__dirname, "plugin.log")
function pluginLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(PLUGIN_LOG, line) } catch {}
  console.log("[project-viewer]", msg)
}
pluginLog(`모듈 로드됨 __dirname=${__dirname} pid=${process.pid} execPath=${process.execPath}`)
// ─────────────────────────────────────────────────────────────────────

function viewerUrl(pathname = "") {
  return `http://127.0.0.1:${currentPort}${pathname}`
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function sendKeepalive() {
  if (!ownsServer) return  // 독립 실행 서버의 수명에 간섭하지 않음
  try {
    await fetchWithTimeout(
      viewerUrl("/api/keepalive"),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      2000
    )
  } catch {}
}

async function pingServer() {
  try {
    const res = await fetchWithTimeout(viewerUrl("/api/ping"), {})
    return res.ok
  } catch {
    return false
  }
}

async function killProcessOnPort(port: number) {
  if (process.platform === "win32") {
    const { execSync } = await import("child_process")
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" })
      for (const line of out.split("\n")) {
        if (line.includes("LISTENING")) {
          const parts = line.trim().split(/\s+/)
          const pid = parts[parts.length - 1]
          if (pid && pid !== "0") {
            try { execSync(`taskkill /f /t /pid ${pid}`, { stdio: "ignore" }) } catch {}
          }
        }
      }
    } catch {}
  } else {
    const { execSync } = await import("child_process")
    try { execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" }) } catch {}
  }
}

function shutdownViewer() {
  isShuttingDown = true
  if (!ownsServer || !viewerProcess) return  // 독립 실행 서버는 건드리지 않음
  const pid = viewerProcess.pid
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", pid.toString(), "/f", "/t"], { stdio: "ignore" })
    } else {
      viewerProcess.kill("SIGTERM")
    }
    viewerProcess = null
  } catch {}
}

function findNodeExecutable(): string {
  // Prefer Node.js over Bun: server.js uses node:sqlite and process.kill(pid,0)
  // which behave differently (or are missing) in Bun on Windows.
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
    // Try WHERE command as fallback
    try {
      const result = spawnSync("where", ["node"], { encoding: "utf8" })
      const first = result.stdout?.trim().split(/\r?\n/)[0] ?? ""
      if (first && fs.existsSync(first)) return first
    } catch {}
  } else {
    // On Unix: use execPath only if it's actually node (not bun or opencode)
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

let startViewerPromise: Promise<boolean> | null = null;
async function startViewerServer() {
  if (startViewerPromise) return startViewerPromise;

  const p = (async () => {
    pluginLog("startViewerServer() 진입")
    if (isShuttingDown) return false
    if (await pingServer()) {
      pluginLog("서버 이미 실행 중 (독립 실행, 종료 시 유지)")
      ownsServer = false
      return true
    }

    pluginLog(`포트 ${currentPort} 킬 중...`)
    await killProcessOnPort(currentPort)
    for (let i = 0; i < 10; i++) {
      if (!(await pingServer())) break
      await new Promise(r => setTimeout(r, 500))
    }

    const serverScript = path.join(__dirname, "apps", "server", "dist", "server.js")
    if (!fs.existsSync(serverScript)) {
      pluginLog(`서버 스크립트 없음: ${serverScript}`)
      return false
    }

    ownsServer = true
    const nodeExec = findNodeExecutable()
    const logPath = path.join(__dirname, "server.log")
    pluginLog(`spawn (owned): ${nodeExec} ${serverScript}`)
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
    // Close parent's copy of the fd; child has its own inherited handle
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
      if (await pingServer()) {
        pluginLog(`서버 준비 완료 (${i * 0.5}s) — managed 모드`)
        sendKeepalive().catch(() => {})
        return true
      }
      await new Promise(r => setTimeout(r, 500))
    }
    pluginLog(`서버 30초 내 준비 안됨 (node: ${nodeExec})`)
    ownsServer = false
    shutdownViewer()
    return false
  })()

  startViewerPromise = p
  p.then(ok => { if (!ok && startViewerPromise === p) startViewerPromise = null }).catch(() => { startViewerPromise = null })
  return p
}

function startWatchdog() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(async () => {
    if (isShuttingDown) return
    if (await pingServer()) {
      sendKeepalive().catch(() => {})
    } else {
      pluginLog("서버 다운, 재시작...")
      startViewerPromise = null
      viewerProcess = null
      ownsServer = false  // startViewerServer가 재설정
      await startViewerServer().catch(() => {})
    }
  }, 30_000)
}

process.on("exit", () => {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  shutdownViewer()
})
process.on("SIGINT", () => {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  shutdownViewer()
})
process.on("SIGTERM", () => {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  shutdownViewer()
})

const plugin = async (_ctx?: any) => {
  pluginLog(`plugin() 호출됨`)
  // Start server in background — don't block plugin init
  startViewerServer().catch(err => {
    pluginLog(`Server startup error: ${err}`)
  })
  startWatchdog()
  return {
    event: async ({ event }: { event: any }) => {
      const type = event?.type
      if (
        type === "file.watcher.updated" ||
        type === "session.created" ||
        type === "session.updated"
      ) {
        fetch(viewerUrl("/api/refresh"), { method: "POST" }).catch(() => {})
      }
    }
  }
}

export default plugin
export { plugin as server }
