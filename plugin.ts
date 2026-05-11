import fs from "fs"
import path from "path"
import { spawn, spawnSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let viewerProcess: any = null
let currentPort = 4310
let watchdogTimer: ReturnType<typeof setInterval> | null = null

const PLUGIN_LOG = path.join(__dirname, "plugin.log")
function pluginLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(PLUGIN_LOG, line) } catch {}
  console.log("[project-viewer]", msg)
}
pluginLog(`모듈 로드됨 __dirname=${__dirname} pid=${process.pid} execPath=${process.execPath}`)

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

async function pingServer() {
  try {
    const res = await fetchWithTimeout(viewerUrl("/api/ping"), {})
    return res.ok
  } catch {
    return false
  }
}

async function killProcessOnPort(port: number) {
  const { execSync } = await import("child_process")
  if (process.platform === "win32") {
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

let startViewerPromise: Promise<boolean> | null = null
async function startViewerServer() {
  if (startViewerPromise) return startViewerPromise

  const p = (async () => {
    pluginLog("startViewerServer() 진입")

    pluginLog(`포트 ${currentPort} 킬 중...`)
    await killProcessOnPort(currentPort)
    for (let i = 0; i < 10; i++) {
      if (!(await pingServer())) break
      await new Promise(r => setTimeout(r, 300))
    }

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
      if (await pingServer()) {
        pluginLog(`서버 준비 완료 (${i * 0.5}s)`)
        return true
      }
      await new Promise(r => setTimeout(r, 500))
    }
    pluginLog(`서버 30초 내 준비 안됨 (node: ${nodeExec})`)
    return false
  })()

  startViewerPromise = p
  p.then(ok => { if (!ok && startViewerPromise === p) startViewerPromise = null }).catch(() => { startViewerPromise = null })
  return p
}

function startWatchdog() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(async () => {
    if (!(await pingServer())) {
      pluginLog("서버 다운, 재시작...")
      startViewerPromise = null
      viewerProcess = null
      await startViewerServer().catch(() => {})
    }
  }, 30_000)
}

const plugin = async (_ctx?: any) => {
  pluginLog(`plugin() 호출됨`)
  startViewerServer().catch(err => {
    pluginLog(`Server startup error: ${err}`)
  })
  startWatchdog()
  return {}
}

export default plugin
export { plugin as server }
