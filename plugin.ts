import type { Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"
import { spawn, spawnSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let viewerProcess: any = null
let currentPort = 4310
let isShuttingDown = false

function viewerUrl(pathname = "") {
  return `http://127.0.0.1:${currentPort}${pathname}`
}

async function fetchWithTimeout(url: string, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function pingServer() {
  try {
    const res = await fetchWithTimeout(viewerUrl("/api/ping"))
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
  if (!viewerProcess) return
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

let startViewerPromise: Promise<boolean> | null = null;
async function startViewerServer() {
  if (startViewerPromise) return startViewerPromise;
  startViewerPromise = (async () => {
    if (isShuttingDown) return false
    if (await pingServer()) return true

    await killProcessOnPort(currentPort)
    for(let i = 0; i < 10; i++) {
        if(!(await pingServer())) break;
        await new Promise(r => setTimeout(r, 500));
    }

    const serverDir = path.join(__dirname, "apps", "server")
    viewerProcess = spawn("node", ["server.js"], {
      cwd: serverDir,
      stdio: "ignore",
      env: { ...process.env, PORT: currentPort.toString(), PARENT_PID: process.pid.toString() }
    })

    viewerProcess.on("exit", () => {
      viewerProcess = null
      startViewerPromise = null
    })

    for (let i = 0; i < 60; ++i) {
      if (await pingServer()) return true
      await new Promise(r => setTimeout(r, 500));
    }
    shutdownViewer()
    return false
  })();
  return startViewerPromise;
}

process.on("exit", shutdownViewer)
process.on("SIGINT", shutdownViewer)
process.on("SIGTERM", shutdownViewer)

const plugin: Plugin = async () => {
  await startViewerServer()
  return {
    event: () => {},
    "session.created": () => {},
    "session.updated": () => {},
    "file.watcher.updated": () => {
      fetch(viewerUrl("/api/refresh"), { method: "POST" }).catch(() => {})
    }
  }
}

export default plugin
