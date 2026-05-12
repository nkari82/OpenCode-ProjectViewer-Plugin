import express from "express"
import cors from "cors"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { extractSymbols } from "./symbolExtractor.js"
import { deflateRawSync, inflateRawSync } from "zlib"
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

let projectsCache: { result: ReturnType<typeof _listOpencodeProjects>; ts: number } | null = null
const PROJECTS_CACHE_TTL = 30_000

function listOpencodeProjects() {
  const now = Date.now()
  if (projectsCache && now - projectsCache.ts < PROJECTS_CACHE_TTL) {
    return projectsCache.result
  }
  const result = _listOpencodeProjects()
  projectsCache = { result, ts: now }
  return result
}

function _listOpencodeProjects(): { ok: boolean; error?: string; dbPath?: string; projects: Project[] } {
  if (!DatabaseSync) {
    return { ok: false, error: "node:sqlite unavailable", projects: [] }
  }

  const dbPath = findOpencodeDbPath()
  if (!dbPath) {
    return { ok: false, error: "opencode.db not found", projects: [] }
  }

  let db = null
  try {
    // Open without readOnly so we can enable WAL mode — this prevents our reads
    // from holding a SHARED lock that blocks OpenCode's write transactions.
    // @ts-ignore
    db = new DatabaseSync(dbPath)

    // WAL mode lets readers and writers proceed concurrently (no SHARED-lock contention).
    try { db.prepare("PRAGMA journal_mode=WAL").get() } catch {}
    // Immediately release any implicit write-lock from the PRAGMA above.
    try { db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() } catch {}

    const tableInfo = db.prepare("PRAGMA table_info(project)").all() as any[]
    const colSet = new Set(tableInfo.map((c: any) => String(c.name)))

    const has = (col: string) => colSet.has(col)

    const selectParts = [
      "id",
      "worktree",
      has("name")         ? "name"         : "NULL as name",
      has("vcs")          ? "vcs"           : "NULL as vcs",
      has("icon_color")   ? "icon_color"    : "NULL as icon_color",
      has("time_updated") ? "time_updated"  : "0 as time_updated",
      has("time_created") ? "time_created"  : "0 as time_created",
    ]

    const orderBy = has("time_updated") ? "ORDER BY time_updated DESC" : ""
    const rows = db.prepare(`SELECT ${selectParts.join(", ")} FROM project ${orderBy}`).all() as any[]

    const projects = rows
      .filter((r: any) => {
        if (typeof r.worktree !== "string" || !r.worktree.trim()) return false
        const normalized = r.worktree.trim().replace(/[/\\]+$/, "")
        if (!normalized) return false
        if (/^[a-zA-Z]:$/.test(normalized)) return false
        return true
      })
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

// Works for both tsx source (apps/server/) and compiled output (apps/server/dist/)
const serverPkgDir = path.basename(__dirname) === "dist" ? path.dirname(__dirname) : __dirname
const DIST_DIR = path.join(serverPkgDir, "../client/dist")
const INDEX_HTML = path.join(DIST_DIR, "index.html")

const SETTINGS_FILE = path.join(os.homedir(), ".config", "opencode", "plugins", "project-viewer", "settings.json")

function loadSettings(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"))
  } catch {
    return {}
  }
}

function saveSettings(data: Record<string, string>) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2))
  } catch {}
}

const _settings = loadSettings()
let plantumlServerUrl: string = (
  process.env.PLANTUML_SERVER_URL ||
  _settings.plantumlServerUrl ||
  "https://www.plantuml.com/plantuml"
).replace(/\/$/, "")

const PLANTUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"

export const app = express()

app.use(cors())
app.use(express.json())

let httpServer: ReturnType<typeof app.listen> | null = null
let shuttingDown = false

function shutdownServer(reason: string, details: string | null) {
  if (shuttingDown) return
  shuttingDown = true

  console.log("[viewer] shutdown:", reason, details || "")

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

const ROOT_FILE = path.join(__dirname, "..", "..", "..", "viewer-root.json")

function loadPersistedRoot(): string {
  try {
    const data = JSON.parse(fs.readFileSync(ROOT_FILE, "utf8"))
    if (typeof data.root === "string" && fs.existsSync(data.root)) return data.root
  } catch {}
  return process.env.PROJECT_ROOT || ""
}

function persistRoot(root: string) {
  fs.promises.writeFile(ROOT_FILE, JSON.stringify({ root })).catch(() => {})
}

let ROOT = loadPersistedRoot()

const sessionRoots = new Map<string, string>()

function getSessionRoot(req: express.Request): string {
  const sid = req.headers["x-session-id"] as string | undefined
  if (sid && sessionRoots.has(sid)) return sessionRoots.get(sid)!
  return ROOT
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

function safeResolve(file: string, root: string) {
  if (!file) throw new Error("Path required")

  const resolved = path.resolve(root, file)
  const normalizedRoot = path.normalize(root).toLowerCase()
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
  } catch {
    return []
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

app.get("/api/root", (req, res) => {
  res.json({ root: getSessionRoot(req) })
})

app.get("/api/projects", (req, res) => {
  if (req.query.refresh === "1") projectsCache = null
  const result = listOpencodeProjects()
  res.json({
    ok: result.ok,
    error: result.error || null,
    dbPath: result.dbPath || null,
    currentRoot: getSessionRoot(req),
    projects: result.projects,
  })
})

app.post("/api/open-project", (req, res) => {
  if (typeof req.body?.path !== "string" || !req.body.path.trim()) {
    return res.status(400).json({ error: "path is required" })
  }

  const sid = req.headers["x-session-id"] as string | undefined
  const newRoot = path.resolve(req.body.path)

  if (sid) {
    sessionRoots.set(sid, newRoot)
    console.log("[viewer] session root:", sid.slice(0, 8), newRoot)
  } else {
    ROOT = newRoot
    persistRoot(ROOT)
    console.log("[viewer] global root:", ROOT)
  }

  res.json({ ok: true, root: newRoot })
})

app.get("/api/tree", (req, res) => {
  try {
    res.json(walk(getSessionRoot(req)))
  } catch (err: any) {
    console.error("[viewer:tree error]", err)
    res.json([])
  }
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
  ".bat": "bat",
  ".cmd": "bat",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".psd1": "powershell",
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
    const file = safeResolve(req.query.path as string, getSessionRoot(req))
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

      const encoded = encodePlantUml(raw)
      return res.json({
        type: "plantuml",
        raw,
        rendered: "",
        highlightedRaw,
        url: `/api/plantuml/${encoded}`,
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

app.get("/api/plantuml-server-url", (_req, res) => {
  res.json({ url: plantumlServerUrl })
})

app.post("/api/plantuml-server-url", (req, res) => {
  const { url } = req.body as { url?: string }
  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "url is required" })
  }
  plantumlServerUrl = url.trim().replace(/\/$/, "")
  const settings = loadSettings()
  settings.plantumlServerUrl = plantumlServerUrl
  saveSettings(settings)
  res.json({ url: plantumlServerUrl })
})

app.get("/api/plantuml/:encoded", async (req, res) => {
  const { encoded } = req.params
  const format = req.query.format === "png" ? "png" : "svg"
  // Jetty (and some other servers) have an ~8192-byte URI limit.
  // For large diagrams, decode and POST the raw text instead.
  const usePost = encoded.length > 2000
  try {
    let upstream: Response
    if (usePost) {
      const text = decodePlantUml(encoded)
      upstream = await fetch(`${plantumlServerUrl}/${format}/`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: text,
      })
    } else {
      upstream = await fetch(`${plantumlServerUrl}/${format}/${encoded}`)
    }
    const contentType = upstream.headers.get("content-type") || (format === "png" ? "image/png" : "image/svg+xml")
    res.setHeader("Content-Type", contentType)
    res.status(upstream.status)
    const body = await upstream.arrayBuffer()
    res.send(Buffer.from(body))
  } catch (err: any) {
    res.status(502).json({ error: `PlantUML server unreachable: ${err.message}` })
  }
})

app.get("/api/raw", (req, res) => {
  try {
    const file = safeResolve(req.query.path as string, getSessionRoot(req))
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

function decodePlantUml(encoded: string): string {
  const bytes: number[] = []
  for (let i = 0; i < encoded.length; i += 4) {
    const c1 = PLANTUML_ALPHABET.indexOf(encoded[i] ?? "")
    const c2 = PLANTUML_ALPHABET.indexOf(encoded[i + 1] ?? "")
    const c3 = PLANTUML_ALPHABET.indexOf(encoded[i + 2] ?? "")
    const c4 = PLANTUML_ALPHABET.indexOf(encoded[i + 3] ?? "")
    if (c1 !== -1 && c2 !== -1) bytes.push((c1 << 2) | (c2 >> 4))
    if (c3 !== -1) bytes.push(((c2 & 0xf) << 4) | (c3 >> 2))
    if (c4 !== -1) bytes.push(((c3 & 0x3) << 6) | c4)
  }
  return inflateRawSync(Buffer.from(bytes)).toString("utf8")
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

app.use(express.static(DIST_DIR, { etag: true, lastModified: true }))

app.get("*", (_, res) => {
  res.setHeader("Cache-Control", "no-cache")
  res.sendFile(INDEX_HTML)
})

process.on("SIGINT", () => shutdownServer("SIGINT", null))
process.on("SIGTERM", () => shutdownServer("SIGTERM", null))

if (process.platform === "win32") {
  process.on("SIGBREAK", () => shutdownServer("SIGBREAK", null))
}

process.on("uncaughtException", err => {
  console.error("[viewer:uncaughtException]", err)
})

process.on("unhandledRejection", reason => {
  console.error("[viewer:unhandledRejection]", reason)
})

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
    console.log(`[viewer] running at http://0.0.0.0:${PORT} (also http://127.0.0.1:${PORT})`)
    console.log(`[viewer] mode: standalone`)
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

// Track all plugin parent PIDs — server shuts down only when every parent is gone.
const parentPids = new Set<number>()
if (PARENT_PID) parentPids.add(PARENT_PID)

app.post("/api/register-pid", (req, res) => {
  const pid = Number(req.body?.pid)
  if (pid > 0) {
    parentPids.add(pid)
    console.log("[viewer] registered pid:", pid, "total:", parentPids.size)
  }
  res.json({ ok: true, pids: parentPids.size })
})

if (PARENT_PID) {
  const pidTimer = setInterval(() => {
    for (const pid of [...parentPids]) {
      try { process.kill(pid, 0) } catch { parentPids.delete(pid) }
    }
    if (parentPids.size === 0) shutdownServer("all parent processes gone", null)
  }, 5_000)
  pidTimer.unref()
}

killProcessOnPort(PORT)
setTimeout(() => startServer(), 200)
