import express from "express"
import cors from "cors"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { extractSymbols } from "./symbolExtractor.js"
import { WebSocketServer, WebSocket } from "ws"
import { deflateRawSync } from "zlib"
import { execSync } from "child_process"

import MarkdownIt from "markdown-it"
import anchor from "markdown-it-anchor"
import toc from "markdown-it-table-of-contents"

import { createHighlighter } from "shiki"

// @ts-ignore
import { DatabaseSync } from "node:sqlite"

const OPENCODE_DB_CANDIDATES = [
  process.env.OPENCODE_DB_PATH,
  path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
  path.join(os.homedir(), "AppData", "Local", "opencode", "opencode.db"),
].filter(Boolean)

function findOpencodeDbPath() {
  for (const p of OPENCODE_DB_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.R_OK)
      return p
    } catch {}
  }
  return null
}

interface Project {
  id: string
  worktree: string
  name: string
  vcs: string | null
  iconColor: string | null
  timeUpdated: number
  timeCreated: number
}

function listOpencodeProjects(): { ok: boolean; error?: string; dbPath?: string; projects: Project[] } {
  if (!DatabaseSync) {
    return { ok: false, error: "node:sqlite unavailable", projects: [] }
  }

  const dbPath = findOpencodeDbPath()
  if (!dbPath) {
    return { ok: false, error: "opencode.db not found", projects: [] }
  }

  let db = null
  try {
    // @ts-ignore
    db = new DatabaseSync(dbPath, { readOnly: true })

    const rows = db.prepare(
      "SELECT id, worktree, vcs, name, icon_color, time_updated, time_created FROM project ORDER BY time_updated DESC"
    ).all()

    const projects = rows
      .filter((r: any) => typeof r.worktree === "string" && r.worktree.trim().length > 0)
      .map((r: any) => ({
        id: r.id,
        worktree: r.worktree,
        name: r.name || path.basename(r.worktree),
        vcs: r.vcs || null,
        iconColor: r.icon_color || null,
        timeUpdated: Number(r.time_updated) || 0,
        timeCreated: Number(r.time_created) || 0,
      }))

    return { ok: true, dbPath, projects }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err), projects: [] }
  } finally {
    if (db) {
      try { db.close() } catch {}
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DIST_DIR = path.join(__dirname, "../../apps/client/dist")
const INDEX_HTML = path.join(DIST_DIR, "index.html")

const PLANTUML_SERVER_URL = (
  process.env.PLANTUML_SERVER_URL || "https://www.plantuml.com/plantuml"
).replace(/\/$/, "")

const PLANTUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"

export const app = express()

app.use(cors())
app.use(express.json())

let parentWatchTimer: ReturnType<typeof setInterval> | null = null
let httpServer: ReturnType<typeof app.listen> | null = null
let wss: InstanceType<typeof WebSocketServer> | null = null
let shuttingDown = false

function shutdownServer(reason: string, details: string | null) {
  if (shuttingDown) return
  shuttingDown = true

  console.log("[viewer] shutdown:", reason, details || "")

  if (wss) {
    for (const client of wss.clients) {
      try {
        client.send(JSON.stringify({ type: "closing" }))
        client.close()
      } catch (err) {
        console.error("[viewer:ws client close failed]", err)
      }
    }
  }

  if (parentWatchTimer) {
    clearInterval(parentWatchTimer)
    parentWatchTimer = null
  }

  const forceTimer = setTimeout(() => process.exit(0), 1500)
  forceTimer.unref?.()

  try {
    if (httpServer) {
      httpServer.close(() => process.exit(0))
      return
    }
  } catch (err) {
    console.error("[viewer:http server close failed]", err)
  }

  process.exit(0)
}

const PORT = Number(process.env.PORT) || 4310
const PARENT_PID = Number(process.env.PARENT_PID) || 0

let ROOT = process.env.PROJECT_ROOT || process.cwd()
let lastRefreshAt = Date.now()

function broadcastWsEvent(payload: object) {
  if (!wss) return
  const data = JSON.stringify(payload)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

function publishRefresh(source: string) {
  lastRefreshAt = Date.now()
  broadcastWsEvent({ type: source, root: ROOT, refreshAt: lastRefreshAt })
}

function publishProjectChanged() {
  publishRefresh("project.changed")
}

function publishTreeChanged() {
  publishRefresh("tree.changed")
}

type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>

// lineNumbers is a valid Shiki runtime option but missing from v1.29 types
function shikiHtml(h: ShikiHighlighter, code: string, lang: string): string {
  return (h.codeToHtml as any)(code, { lang, theme: "github-dark", lineNumbers: true })
}

let highlighter: ShikiHighlighter | null = null

async function ensureHighlighter() {
  if (highlighter) return highlighter

  try {
    highlighter = await createHighlighter({
      themes: ["monokai", "dracula", "vitesse-dark", "github-dark"],
      langs: [
        "c", "cpp", "csharp", "objective-c", "objective-cpp",
        "python", "ruby", "php", "perl", "lua", "r",
        "javascript", "typescript", "jsx", "tsx",
        "java", "kotlin", "scala", "groovy",
        "rust", "go", "swift", "dart",
        "haskell", "elixir", "erlang", "fsharp", "clojure",
        "json", "jsonc", "yaml", "toml", "xml", "csv",
        "html", "css", "scss", "sass", "less",
        "bash", "shellscript", "powershell", "bat",
        "sql", "graphql",
        "ini", "dockerfile", "docker", "makefile", "cmake",
        "diff", "git-commit", "git-rebase",
        "markdown", "latex",
        "plaintext",
      ],
    })
  } catch (err) {
    console.error("[viewer:highlighter init failed]", err)
    highlighter = null
  }

  return highlighter
}

let mdShiki: MarkdownIt | null = null

async function getMdShiki(): Promise<MarkdownIt> {
  if (mdShiki) return mdShiki
  const h = await ensureHighlighter()
  mdShiki = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(code, lang) {
      if (h && lang) {
        try {
          return shikiHtml(h, code, lang)
        } catch {}
      }
      return escapeHtml(code)
    },
  })
    .use(anchor, {
      slugify: (s: string) =>
        s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
    })
    .use(toc, { includeLevel: [1, 2, 3] })
  return mdShiki
}

function safeResolve(file: string) {
  if (!file) throw new Error("Path required")

  const resolved = path.resolve(ROOT, file)
  const normalizedRoot = path.normalize(ROOT).toLowerCase()
  const normalizedResolved = path.normalize(resolved).toLowerCase()

  if (!normalizedResolved.startsWith(normalizedRoot)) {
    throw new Error("Access denied: Path traversal detected")
  }

  if (!fs.existsSync(resolved)) {
    throw new Error("File not found")
  }

  return resolved
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".turbo", ".cache", ".pytest_cache"])

interface TreeNode {
  type: "dir" | "file"
  name: string
  path: string
  children?: TreeNode[]
}

function walk(dir: string): TreeNode[] {
  let entries: string[] = []

  try {
    entries = fs.readdirSync(dir)
  } catch (err: any) {
    if (err?.code === "EPERM" || err?.code === "EACCES") return []
    throw err
  }

  const result: TreeNode[] = []

  for (const file of entries) {
    if (SKIP_DIRS.has(file)) continue

    const full = path.join(dir, file)
    let stat

    try {
      stat = fs.statSync(full)
    } catch (err: any) {
      if (err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "ENOENT") continue
      throw err
    }

    if (stat.isDirectory()) {
      result.push({ type: "dir", name: file, path: full, children: walk(full) })
    } else {
      result.push({ type: "file", name: file, path: full })
    }
  }

  result.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1
    if (a.type !== "dir" && b.type === "dir") return 1
    return a.name.localeCompare(b.name)
  })

  return result
}

app.get("/api/ping", (_, res) => {
  res.json({ ok: true })
})

app.get("/api/root", (_, res) => {
  res.json({ root: ROOT })
})

app.get("/api/projects", (_, res) => {
  const result = listOpencodeProjects()
  res.json({
    ok: result.ok,
    error: result.error || null,
    dbPath: result.dbPath || null,
    currentRoot: ROOT,
    projects: result.projects,
  })
})

app.post("/api/open-project", (req, res) => {
  if (typeof req.body?.path !== "string" || !req.body.path.trim()) {
    return res.status(400).json({ error: "path is required" })
  }

  ROOT = path.resolve(req.body.path)
  publishProjectChanged()
  console.log("[viewer] root:", ROOT)

  res.json({ ok: true, root: ROOT, refreshAt: lastRefreshAt })
})

app.post("/api/refresh", (_, res) => {
  publishTreeChanged()
  res.json({ ok: true, refreshAt: lastRefreshAt })
})

app.get("/api/refresh", (_, res) => {
  res.json({ refreshAt: lastRefreshAt })
})

app.get("/api/tree", (_, res) => {
  res.json(walk(ROOT))
})

const langMap: Record<string, string> = {
  ".cs": "csharp",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".m": "objective-c",
  ".mm": "objective-c",
  ".py": "python",
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".css": "css",
  ".sh": "bash",
  ".sql": "sql",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".swift": "swift",
  ".kt": "kotlin",
  ".txt": "plaintext",
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".svg"])

app.get("/api/file", async (req, res) => {
  try {
    const file = safeResolve(req.query.path as string)
    const ext = path.extname(file).toLowerCase()
    const rawPath = `/api/raw?path=${encodeURIComponent(req.query.path as string)}`

    if (ext === ".pdf") {
      return res.json({ type: "pdf", raw: "", rendered: "", url: rawPath })
    }

    const raw = fs.readFileSync(file, "utf8")

    if (ext === ".md") {
      const md = await getMdShiki()
      const rendered = md.render(raw)

      const activeHighlighter = await ensureHighlighter()
      const highlightedRaw = activeHighlighter
        ? shikiHtml(activeHighlighter, raw, "markdown")
        : `<pre><code>${escapeHtml(raw)}</code></pre>`

      const tokens = md.parse(raw, {})
      const symbols: { name: string; line: number }[] = []
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === "heading_open") {
          symbols.push({
            name: tokens[i + 1].content,
            line: tokens[i].map ? tokens[i].map[0] + 1 : 0,
          })
        }
      }

      return res.json({ type: "markdown", raw, rendered, highlightedRaw, symbols })
    }

    if (ext === ".html") {
      const activeHighlighter = await ensureHighlighter()
      const highlightedRaw = activeHighlighter
        ? shikiHtml(activeHighlighter, raw, "html")
        : `<pre><code>${escapeHtml(raw)}</code></pre>`

      return res.json({ type: "html", raw, rendered: raw, highlightedRaw, url: rawPath })
    }

    if (ext === ".puml") {
      const activeHighlighter = await ensureHighlighter()
      const highlightedRaw = activeHighlighter
        ? shikiHtml(activeHighlighter, raw, "plaintext")
        : `<pre><code>${escapeHtml(raw)}</code></pre>`

      return res.json({
        type: "plantuml",
        raw,
        rendered: "",
        highlightedRaw,
        url: `${PLANTUML_SERVER_URL}/svg/${encodePlantUml(raw)}`,
      })
    }

    if (ext === ".mmd") {
      const activeHighlighter = await ensureHighlighter()
      const highlightedRaw = activeHighlighter
        ? shikiHtml(activeHighlighter, raw, "plaintext")
        : `<pre><code>${escapeHtml(raw)}</code></pre>`

      return res.json({
        type: "mermaid",
        raw,
        rendered: `<pre class="language-mermaid">\n${escapeHtml(raw)}\n</pre>`,
        highlightedRaw,
      })
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      return res.json({ type: "image", raw: "", url: rawPath })
    }

    const lang = langMap[ext]
    if (lang) {
      const activeHighlighter = await ensureHighlighter()
      if (activeHighlighter) {
        const rendered = shikiHtml(activeHighlighter, raw, lang)
        const symbols = extractSymbols(raw, lang)
        return res.json({ type: "code", raw, rendered, symbols })
      }
      return res.json({ type: "code", raw, rendered: `<pre><code>${escapeHtml(raw)}</code></pre>` })
    }

    return res.json({ type: "text", raw, rendered: `<pre>${escapeHtml(raw)}</pre>` })
  } catch (err: any) {
    res.status(403).json({ error: err.message })
  }
})

app.get("/api/raw", (req, res) => {
  try {
    const file = safeResolve(req.query.path as string)
    return res.sendFile(file)
  } catch (err: any) {
    return res.status(403).json({ error: err.message })
  }
})

function encodePlantUml6Bit(value: number) {
  return PLANTUML_ALPHABET[value & 0x3f]
}

function appendPlantUmlEncodedBytes(b1: number, b2: number, b3: number) {
  const c1 = b1 >> 2
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4)
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6)
  const c4 = b3 & 0x3f
  return (
    encodePlantUml6Bit(c1) +
    encodePlantUml6Bit(c2) +
    encodePlantUml6Bit(c3) +
    encodePlantUml6Bit(c4)
  )
}

function encodePlantUml(text: string) {
  const source = /@start\w+/i.test(text) ? text : `@startuml\n${text}\n@enduml`
  const compressed = deflateRawSync(Buffer.from(source, "utf8"))
  let encoded = ""
  for (let i = 0; i < compressed.length; i += 3) {
    encoded += appendPlantUmlEncodedBytes(
      compressed[i],
      compressed[i + 1] || 0,
      compressed[i + 2] || 0,
    )
  }
  return encoded
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

app.use(express.static(DIST_DIR))

app.get("*", (_, res) => {
  res.sendFile(INDEX_HTML)
})

process.on("SIGINT", () => shutdownServer("SIGINT", null))
process.on("SIGTERM", () => shutdownServer("SIGTERM", null))

if (process.platform === "win32") {
  process.on("SIGBREAK", () => shutdownServer("SIGBREAK", null))
}

process.on("uncaughtException", err => {
  console.error("[viewer:uncaughtException]", err)
  shutdownServer("uncaughtException", err?.message)
})

process.on("unhandledRejection", reason => {
  console.error("[viewer:unhandledRejection]", reason)
  shutdownServer("unhandledRejection", String(reason))
})

if (PARENT_PID > 0) {
  parentWatchTimer = setInterval(() => {
    try {
      (process as any).kill(PARENT_PID, 0)
    } catch (err: any) {
      if (err?.code === "ESRCH") {
        shutdownServer("parent exited", null)
      }
    }
  }, 1000)
  parentWatchTimer.unref?.()
}

function killProcessOnPort(port: number) {
  try {
    if (process.platform === "win32") {
      try {
        const output = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" })
        for (const line of output.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed.includes("LISTENING")) continue
          const parts = trimmed.split(/\s+/)
          const pid = parts[parts.length - 1]
          if (pid && /^\d+$/.test(pid)) {
            console.log("[viewer:kill existing]", { port, pid })
            try { execSync(`taskkill /pid ${pid} /f /t`, { stdio: "ignore" }) } catch {}
          }
        }
      } catch {}
    } else {
      try { execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" }) } catch {}
    }
  } catch {}
}

function startServer(retry = true) {
  httpServer = app.listen(PORT, "0.0.0.0", () => {
    wss = new WebSocketServer({
      server: httpServer as any,
      verifyClient: (info: any, cb: any) => {
        const origin = info.origin
        if (!origin || (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`)) {
          return cb(false, 403, "Forbidden")
        }
        cb(true)
      },
    })

    wss.on("connection", (ws: any) => {
      ws.isAlive = true
      ws.on("pong", () => { ws.isAlive = true })
      ws.send(JSON.stringify({ type: "connected", root: ROOT, refreshAt: lastRefreshAt }))
    })

    const pingInterval = setInterval(() => {
      wss!.clients.forEach((ws: any) => {
        if (ws.isAlive === false) return ws.terminate()
        ws.isAlive = false
        ws.ping()
      })
    }, 30000)

    wss.on("close", () => clearInterval(pingInterval))

    console.log(`[viewer] running at http://0.0.0.0:${PORT} (also http://127.0.0.1:${PORT})`)
    if (PARENT_PID > 0) {
      console.log("[viewer] parent pid:", PARENT_PID)
    }
  })

  httpServer.on("error", (err: any) => {
    console.error("[viewer:listen error]", err)

    if (retry && err?.code === "EADDRINUSE") {
      console.log("[viewer:retry after kill]", { port: PORT })
      killProcessOnPort(PORT)
      setTimeout(() => startServer(false), 1000)
      return
    }

    shutdownServer("listen error", err?.message)
  })
}

killProcessOnPort(PORT)
startServer()
