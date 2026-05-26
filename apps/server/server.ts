import express from "express"
import cors from "cors"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { createRequire } from "module"
import { extractSymbols } from "./symbolExtractor.js"
import { deflateRawSync, inflateRawSync } from "zlib"
import { exec, execSync, spawn } from "child_process"

const _require = createRequire(import.meta.url)

// pdfjs-dist for better text extraction (handles LaTeX / complex font encoding)
// @ts-ignore
import * as _pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs"
// @ts-ignore
const pdfjsLib: any = _pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(_require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href

import MarkdownIt from "markdown-it"
import anchor from "markdown-it-anchor"
import toc from "markdown-it-table-of-contents"
// @ts-ignore
import mk from "@traptitech/markdown-it-katex"
// @ts-ignore
import taskLists from "markdown-it-task-lists"
// @ts-ignore
import footnote from "markdown-it-footnote"
// @ts-ignore
import sub from "markdown-it-sub"
// @ts-ignore
import sup from "markdown-it-sup"
// @ts-ignore
import mark from "markdown-it-mark"
// @ts-ignore
import * as emojiPlugin from "markdown-it-emoji"
// @ts-ignore
import container from "markdown-it-container"
// @ts-ignore
import abbr from "markdown-it-abbr"
// @ts-ignore
import deflist from "markdown-it-deflist"

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
    // @ts-ignore
    db = new DatabaseSync(dbPath)
    // WAL mode: readers and writers proceed concurrently without SHARED-lock contention
    try { db.prepare("PRAGMA journal_mode=WAL").get() } catch {}
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
const openSockets = new Set<import("net").Socket>()

function shutdownServer(reason: string, details: string | null) {
  if (shuttingDown) return
  shuttingDown = true

  console.log("[viewer] shutdown:", reason, details || "")

  // Keep HTTP listener alive during the 2s window — register-pid must be reachable for
  // NSSM restart cancellation. Closing the listener first made the window unreachable.
  setTimeout(() => {
    if (parentPids.size > 0) {
      console.log("[viewer] shutdown cancelled: new parent registered")
      shuttingDown = false
      return
    }
    // Forcefully destroy all open connections so the port is released immediately.
    // Without this, Chrome keep-alive sockets hold the port after process exit.
    for (const sock of openSockets) {
      try { sock.destroy() } catch {}
    }
    openSockets.clear()
    try {
      if (httpServer) httpServer.close()
    } catch {}
    process.exit(0)
  }, 2_000)
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

const FILE_CACHE_MAX = 200
interface FileCacheEntry { mtime: number; size: number; result: object }
const fileCache = new Map<string, FileCacheEntry>()

function getFileCache(filePath: string): object | null {
  const entry = fileCache.get(filePath)
  if (!entry) return null
  try {
    const stat = fs.statSync(filePath)
    if (stat.mtimeMs === entry.mtime && stat.size === entry.size) return entry.result
  } catch {}
  fileCache.delete(filePath)
  return null
}

function setFileCache(filePath: string, result: object) {
  if (fileCache.size >= FILE_CACHE_MAX) {
    const first = fileCache.keys().next().value
    if (first !== undefined) fileCache.delete(first)
  }
  try {
    const stat = fs.statSync(filePath)
    fileCache.set(filePath, { mtime: stat.mtimeMs, size: stat.size, result })
  } catch {}
}

let refreshSeq = 0

function getSessionRoot(req: express.Request): string {
  const sid = req.headers["x-session-id"] as string | undefined
  if (sid && sessionRoots.has(sid)) return sessionRoots.get(sid)!
  return ROOT
}
type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>

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
    .use(mk, { throwOnError: false })
    .use(taskLists, { enabled: true, label: true })
    .use(footnote)
    .use(sub)
    .use(sup)
    .use(mark)
    .use((emojiPlugin as any).full)
    .use(abbr)
    .use(deflist)
    .use(container, "info",    mkContainer("info",    "ℹ️ Info"))
    .use(container, "tip",     mkContainer("tip",     "💡 Tip"))
    .use(container, "warning", mkContainer("warning", "⚠️ Warning"))
    .use(container, "danger",  mkContainer("danger",  "🚨 Danger"))
    .use(container, "note",    mkContainer("note",    "📝 Note"))
    .use(container, "success", mkContainer("success", "✅ Success"))
    .use(container, "details", mkContainer("details", "📋 Details"))

  const origFence = mdShiki.renderer.rules.fence
  mdShiki.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const lang = token.info.trim().split(/\s+/)[0].toLowerCase()
    const code = token.content.trim()
    const isPlantUml = lang === "plantuml" || lang === "puml" || code.startsWith("@startuml")
    if (isPlantUml) {
      const finalCode = code.startsWith("@start") ? code : `@startuml\n${code}\n@enduml`
      const encoded = encodePlantUml(finalCode)
      return `<div class="md-plantuml"><img src="/api/plantuml/${encoded}" alt="PlantUML Diagram" /></div>\n`
    }
    if (origFence) return origFence(tokens, idx, options, env, self)
    return self.renderToken(tokens, idx, options)
  }

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

function safeNoteResolve(filePath: string, root: string): string {
  if (!filePath || !root) throw new Error("Path required")
  const resolved = path.resolve(root, filePath)
  const normalizedRoot = path.normalize(root).toLowerCase()
  if (!path.normalize(resolved).toLowerCase().startsWith(normalizedRoot)) {
    throw new Error("Access denied: Path traversal detected")
  }
  const rel = path.relative(root, resolved)
  const notesDir = path.join(root, ".notes")
  const notePath = path.join(notesDir, rel + ".md")
  if (!path.normalize(notePath).toLowerCase().startsWith(path.normalize(notesDir).toLowerCase() + path.sep)) {
    throw new Error("Access denied: Note path outside .notes directory")
  }
  return notePath
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".turbo", ".cache", ".pytest_cache", ".notes"])
const DIR_FILE_LIMIT = 500

interface TreeNode {
  type: "dir" | "file"
  name: string
  path: string
  truncated?: true
  total?: number
  offset?: number      // next offset to load for "load more"
  parentPath?: string  // parent dir of this truncated node
}

const TREE_CACHE_MAX = 150
interface TreeCacheEntry { mtime: number; dirs: TreeNode[]; files: TreeNode[] }
const treeListCache = new Map<string, TreeCacheEntry>()

function getRawDirContents(dir: string): { dirs: TreeNode[]; files: TreeNode[] } | null {
  const entry = treeListCache.get(dir)
  if (!entry) return null
  try {
    if (fs.statSync(dir).mtimeMs === entry.mtime) return entry
  } catch {}
  treeListCache.delete(dir)
  return null
}

function setRawDirCache(dir: string, dirs: TreeNode[], files: TreeNode[]) {
  if (treeListCache.size >= TREE_CACHE_MAX) {
    const first = treeListCache.keys().next().value
    if (first !== undefined) treeListCache.delete(first)
  }
  try {
    treeListCache.set(dir, { mtime: fs.statSync(dir).mtimeMs, dirs, files })
  } catch {}
}

function walkShallow(dir: string, offset = 0): TreeNode[] {
  let contents = getRawDirContents(dir)

  if (!contents) {
    let entries: string[] = []
    try { entries = fs.readdirSync(dir) } catch { return [] }

    const dirs: TreeNode[] = []
    const files: TreeNode[] = []

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
      if (stat.isDirectory()) dirs.push({ type: "dir", name: file, path: full })
      else files.push({ type: "file", name: file, path: full })
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))
    setRawDirCache(dir, dirs, files)
    contents = { dirs, files, mtime: 0 } as any
  }

  const { dirs, files } = contents!
  const slice = files.slice(offset, offset + DIR_FILE_LIMIT)
  const result: TreeNode[] = [...(offset === 0 ? dirs : []), ...slice]

  if (files.length > offset + DIR_FILE_LIMIT) {
    const remaining = files.length - offset - DIR_FILE_LIMIT
    result.push({
      type: "file",
      name: `… ${remaining.toLocaleString()}개 더 보기`,
      path: `${dir}/__more__`,
      truncated: true,
      total: files.length,
      offset: offset + DIR_FILE_LIMIT,
      parentPath: dir,
    })
  }

  return result
}

app.get("/api/ping", (_, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, reason: "shutting down" })
  res.json({ ok: true })
})

app.get("/api/root", (req, res) => {
  res.json({ root: getSessionRoot(req), refreshSeq })
})

// ── File Search ──────────────────────────────────────────────────────────────

const SEARCH_RESULT_LIMIT = 100
const SEARCH_MATCHES_PER_FILE = 4
const SEARCH_MAX_FILE_SIZE = 512 * 1024  // 512 KB

const SEARCHABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".swift", ".scala",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".php", ".rb", ".lua",
  ".md", ".markdown", ".txt", ".log",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml",
  ".html", ".css", ".scss", ".sass", ".less",
  ".sh", ".bash", ".ps1", ".bat", ".cmd",
  ".sql", ".graphql", ".env", ".ini", ".conf", ".cfg",
  ".dockerfile", ".gitignore", ".editorconfig",
])

interface SearchResult {
  path: string
  name: string
  dir: string
  matches?: { line: number; text: string }[]
}

function searchWalk(
  dir: string,
  query: string,
  type: "name" | "content",
  results: SearchResult[],
) {
  if (results.length >= SEARCH_RESULT_LIMIT) return
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return }

  for (const file of entries) {
    if (results.length >= SEARCH_RESULT_LIMIT) break
    if (SKIP_DIRS.has(file)) continue
    const full = path.join(dir, file)
    let stat
    try { stat = fs.statSync(full) } catch { continue }

    if (stat.isDirectory()) {
      searchWalk(full, query, type, results)
      continue
    }

    if (type === "name") {
      if (file.toLowerCase().includes(query)) {
        results.push({ path: full, name: file, dir: path.dirname(full) })
      }
    } else {
      const ext = path.extname(file).toLowerCase()
      if (!SEARCHABLE_EXTENSIONS.has(ext)) continue
      if (stat.size > SEARCH_MAX_FILE_SIZE) continue
      try {
        const content = fs.readFileSync(full, "utf8")
        const lines = content.split("\n")
        const matches: { line: number; text: string }[] = []
        for (let i = 0; i < lines.length && matches.length < SEARCH_MATCHES_PER_FILE; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            matches.push({ line: i + 1, text: lines[i].trimEnd().slice(0, 120) })
          }
        }
        if (matches.length > 0) {
          results.push({ path: full, name: file, dir: path.dirname(full), matches })
        }
      } catch {}
    }
  }
}

app.get("/api/search", (req, res) => {
  try {
    const q = ((req.query.q as string) || "").trim().toLowerCase()
    if (q.length < 1) return res.json({ results: [] })
    const type = req.query.type === "content" ? "content" : "name"
    const root = getSessionRoot(req)
    const results: SearchResult[] = []
    searchWalk(root, q, type, results)
    res.json({ results })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/open-in-explorer", (req, res) => {
  const targetPath = (req.body?.path as string | undefined) || getSessionRoot(req)
  if (!targetPath) return res.status(400).json({ error: "no path" })
  if (!fs.existsSync(targetPath)) return res.status(400).json({ error: "path does not exist" })
  try {
    if (process.platform === "win32") {
      const normalized = path.normalize(targetPath)
      spawn("cmd.exe", ["/c", "start", "", normalized], { detached: true, stdio: "ignore" }).unref()
    } else if (process.platform === "darwin") {
      spawn("open", [targetPath], { detached: true, stdio: "ignore" }).unref()
    } else {
      spawn("xdg-open", [targetPath], { detached: true, stdio: "ignore" }).unref()
    }
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/open-terminal", (req, res) => {
  const targetPath = (req.body?.path as string | undefined) || getSessionRoot(req)
  if (!targetPath) return res.status(400).json({ error: "no path" })
  if (!fs.existsSync(targetPath)) return res.status(400).json({ error: "path does not exist" })
  try {
    if (process.platform === "win32") {
      const normalized = path.normalize(targetPath)
      // Windows Terminal → PowerShell → cmd 순서로 시도
      try {
        spawn("wt.exe", ["-d", normalized], { detached: true, stdio: "ignore" }).unref()
      } catch {
        try {
          spawn("powershell.exe", ["-NoExit", "-Command", `Set-Location '${normalized.replace(/'/g, "''")}'`], { detached: true, stdio: "ignore" }).unref()
        } catch {
          spawn("cmd.exe", ["/k", `cd /d "${normalized}"`], { detached: true, stdio: "ignore" }).unref()
        }
      }
    } else if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", targetPath], { detached: true, stdio: "ignore" }).unref()
    } else {
      const term = process.env.TERMINAL || "xterm"
      spawn(term, [], { cwd: targetPath, detached: true, stdio: "ignore" }).unref()
    }
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/open-vscode", (req, res) => {
  const targetPath = (req.body?.path as string | undefined) || getSessionRoot(req)
  if (!targetPath) return res.status(400).json({ error: "no path" })
  if (!fs.existsSync(targetPath)) return res.status(400).json({ error: "path does not exist" })
  try {
    spawn("code", [targetPath], { detached: true, stdio: "ignore", shell: true }).unref()
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/refresh", (_, res) => {
  refreshSeq++
  fileCache.clear()
  treeListCache.clear()
  res.json({ ok: true, refreshSeq })
})

app.get("/api/projects", (req, res) => {
  if (req.query.refresh === "1") projectsCache = null
  const result = listOpencodeProjects()
  const currentRoot = getSessionRoot(req)

  let projects = result.projects
  if (currentRoot) {
    const norm = (p: string) => path.resolve(p).replace(/[/\\]+$/, "")
    const currentNorm = norm(currentRoot)
    const inDb = projects.some(p => norm(p.worktree) === currentNorm)
    if (!inDb && fs.existsSync(currentRoot)) {
      projects = [
        {
          id: `unregistered:${currentRoot}`,
          worktree: currentRoot,
          name: path.basename(currentRoot),
          vcs: null,
          iconColor: null,
          timeUpdated: 0,
          timeCreated: 0,
        },
        ...projects,
      ]
    }
  }

  res.json({
    ok: result.ok,
    error: result.error || null,
    dbPath: result.dbPath || null,
    currentRoot,
    projects,
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
    sessionRoots.clear()
    persistRoot(ROOT)
    console.log("[viewer] global root:", ROOT)
  }

  res.json({ ok: true, root: newRoot })
})

app.get("/api/tree", (req, res) => {
  try {
    const sessionRoot = getSessionRoot(req)
    const targetDir = req.query.path
      ? safeResolve(req.query.path as string, sessionRoot)
      : sessionRoot
    const offset = Math.max(0, parseInt(req.query.offset as string || "0", 10) || 0)
    res.json(walkShallow(targetDir, offset))
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
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac", ".aac", ".m4a", ".opus", ".weba", ".wma", ".aiff", ".au"])

app.get("/api/file", async (req, res) => {
  try {
    const file = safeResolve(req.query.path as string, getSessionRoot(req))
    const ext = path.extname(file).toLowerCase()
    const rawPath = `/api/raw?path=${encodeURIComponent(req.query.path as string)}`

    if (ext === ".pdf") {
      return res.json({ type: "pdf", raw: "", rendered: "", url: rawPath })
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      return res.json({ type: "image", raw: "", url: rawPath })
    }

    if (AUDIO_EXTENSIONS.has(ext)) {
      return res.json({ type: "audio", raw: "", url: rawPath })
    }

    // Serve from cache if file unchanged (mtime + size match)
    const cached = getFileCache(file)
    if (cached) return res.json(cached)

    const raw = fs.readFileSync(file, "utf8")

    if (ext === ".md") {
      const md = await getMdShiki()
      const fileDir = path.dirname(file)
      const rendered = md.render(raw).replace(
        /<img([^>]*)\ssrc="([^"]+)"/g,
        (_match, attrs: string, src: string) => {
          if (/^(https?:\/\/|\/\/|data:|\/)/i.test(src)) return `<img${attrs} src="${src}"`
          const abs = path.resolve(fileDir, src)
          return `<img${attrs} src="/api/raw?path=${encodeURIComponent(abs)}"`
        },
      )

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

      const result = { type: "markdown", raw, rendered, highlightedRaw, symbols }
      setFileCache(file, result)
      return res.json(result)
    }

    if (ext === ".html") {
      const activeHighlighter = await ensureHighlighter()
      const highlightedRaw = activeHighlighter
        ? shikiHtml(activeHighlighter, raw, "html")
        : `<pre><code>${escapeHtml(raw)}</code></pre>`

      const result = { type: "html", raw, rendered: raw, highlightedRaw, url: rawPath }
      setFileCache(file, result)
      return res.json(result)
    }

    if (ext === ".puml") {
      const activeHighlighter = await ensureHighlighter()
      const highlightedRaw = activeHighlighter
        ? shikiHtml(activeHighlighter, raw, "plaintext")
        : `<pre><code>${escapeHtml(raw)}</code></pre>`

      const encoded = encodePlantUml(raw)
      const result = { type: "plantuml", raw, rendered: "", highlightedRaw, url: `/api/plantuml/${encoded}` }
      setFileCache(file, result)
      return res.json(result)
    }

    if (ext === ".mmd") {
      const activeHighlighter = await ensureHighlighter()
      const highlightedRaw = activeHighlighter
        ? shikiHtml(activeHighlighter, raw, "plaintext")
        : `<pre><code>${escapeHtml(raw)}</code></pre>`

      const result = { type: "mermaid", raw, rendered: `<pre class="language-mermaid">\n${escapeHtml(raw)}\n</pre>`, highlightedRaw }
      setFileCache(file, result)
      return res.json(result)
    }

    const lang = langMap[ext]
    if (lang) {
      const activeHighlighter = await ensureHighlighter()
      if (activeHighlighter) {
        const rendered = shikiHtml(activeHighlighter, raw, lang)
        const symbols = extractSymbols(raw, lang)
        const result = { type: "code", raw, rendered, symbols }
        setFileCache(file, result)
        return res.json(result)
      }
      const result = { type: "code", raw, rendered: `<pre><code>${escapeHtml(raw)}</code></pre>` }
      setFileCache(file, result)
      return res.json(result)
    }

    const result = { type: "text", raw, rendered: `<pre>${escapeHtml(raw)}</pre>` }
    setFileCache(file, result)
    return res.json(result)
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

// Known label/abbreviation prefixes — period after these is NOT a sentence end
const ABBREV_PREFIX = /\b(Dr|Mr|Mrs|Ms|Prof|Fig|Figs|Table|Tab|Eq|Eqs|Sec|Ref|Refs|et al|e\.g|i\.e|vs|etc|cf|approx|dept|vol|no|pp|op|cit|ibid|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|[A-Z]{2,6})\s*$/

// Returns true only when the token immediately before '.' is a real word ending
function isFalseDot(textBeforeDot: string): boolean {
  const token = (textBeforeDot.match(/(\S+)\s*$/) || [])[1] || ""
  // Roman numerals: I II III IV V VI VII VIII IX X XI XII ...
  if (/^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i.test(token) && token.length <= 6) return true
  // Single letter (section/list marker like "A.", "B.", "a.")
  if (/^[A-Za-z]$/.test(token)) return true
  // Pure number or dotted number (1. 1.2. 3.4.1.)
  if (/^\d+(\.\d+)*$/.test(token)) return true
  // Known abbreviation prefix
  if (ABBREV_PREFIX.test(textBeforeDot)) return true
  return false
}

// Split accumulated text at true sentence boundaries
function splitAtSentences(text: string): string[] {
  // Match [.!?] optionally followed by quote, then whitespace + uppercase/digit/quote
  const re = /([.!?]['"»]?)(\s+)(?=[A-Z\d"«‘“])/g
  const parts: string[] = []
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    const dotEnd = m.index + m[1].length
    const before = text.slice(0, m.index + m[1].length - /* the punct char */ 1 + 1)
    if (!isFalseDot(text.slice(0, m.index))) {
      parts.push(text.slice(last, dotEnd).trim())
      last = dotEnd + m[2].length
      re.lastIndex = last
    }
  }
  if (last < text.length) parts.push(text.slice(last).trim())
  return parts.filter(p => p.length > 0)
}

function reconstructSentences(lines: string[]): string[] {
  const out: string[] = []
  let cur = ""

  for (const line of lines) {
    if (!line.trim()) {
      if (cur.trim()) { out.push(...splitAtSentences(cur)); cur = "" }
      continue
    }
    // De-hyphenate: "train-" + "ing ..." → "training ..."
    if (cur.endsWith("-") && /^[a-z]/.test(line)) {
      cur = cur.slice(0, -1) + line
    } else {
      cur += (cur ? " " : "") + line
    }
  }
  if (cur.trim()) out.push(...splitAtSentences(cur))
  return out.filter(s => s.length > 0)
}

async function extractPdfSegments(buffer: Buffer): Promise<{ segments: { text: string; page: number }[]; numpages: number }> {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise

  const allSegments: { text: string; page: number }[] = []

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum)
    const content = await page.getTextContent({ includeMarkedContent: false })
    const items: any[] = (content.items as any[]).filter((it: any) => typeof it.str === "string" && it.str.trim())

    items.sort((a: any, b: any) => {
      const dy = b.transform[5] - a.transform[5]
      if (Math.abs(dy) > 3) return dy
      return a.transform[4] - b.transform[4]
    })

    // group items into lines by Y proximity
    const lines: string[] = []
    let curLine = ""
    let lastY: number | null = null

    for (const item of items) {
      const y = item.transform[5]
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (curLine.trim()) lines.push(curLine.trim())
        curLine = item.str
      } else {
        curLine += (curLine && !curLine.endsWith(" ") && !item.str.startsWith(" ") ? " " : "") + item.str
      }
      lastY = y
    }
    if (curLine.trim()) lines.push(curLine.trim())

    // Reconstruct sentences: de-hyphenate, join continuation lines, split at real sentence ends
    const sentences = reconstructSentences(lines)
    // Group sentences into translation chunks (~3 sentences or ~400 chars each)
    let chunk = ""
    for (const sent of sentences) {
      if (chunk && chunk.length + sent.length > 400) {
        allSegments.push({ text: chunk.trim(), page: pageNum })
        chunk = sent
      } else {
        chunk += (chunk ? " " : "") + sent
      }
    }
    if (chunk.trim()) allSegments.push({ text: chunk.trim(), page: pageNum })
  }

  return { segments: allSegments, numpages: doc.numPages }
}

function isMathSegment(text: string): boolean {
  if (text.length < 3) return false
  if (/[∫∑∏∂∇±×÷≤≥≠≈∞√∈∉⊂⊃∪∩αβγδεζηθλμνξπρστυφχψω]/.test(text)) return true
  if (/\\[a-zA-Z]+[\s\{]/.test(text)) return true
  if (/\$[^$]{1,100}\$/.test(text)) return true
  if (text.length < 20 && /^[\s\d\w\+\-\*\/\=\(\)\[\]\{\}\^\._,:<>|]+$/.test(text)) return true
  return false
}

app.get("/api/pdf-text", async (req, res) => {
  try {
    const file = safeResolve(req.query.path as string, getSessionRoot(req))
    if (path.extname(file).toLowerCase() !== ".pdf") {
      return res.status(400).json({ error: "Not a PDF" })
    }
    const buffer = fs.readFileSync(file)

    const { segments: rawSegments, numpages } = await extractPdfSegments(buffer)

    if (!rawSegments.length) {
      return res.json({ segments: [], empty: true, pages: numpages })
    }

    const segments = rawSegments
      .filter(s => s.text.length > 1)
      .map(s => ({ text: s.text, isMath: isMathSegment(s.text), page: s.page }))

    res.json({ segments, empty: false, pages: numpages })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/translate", async (req, res) => {
  const { text, from = "auto", to = "ko" } = req.body as { text?: string; from?: string; to?: string }
  if (!text || typeof text !== "string") return res.status(400).json({ error: "text required" })

  try {
    // Google Translate unofficial endpoint — no API key required
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
    if (!resp.ok) throw new Error(`status ${resp.status}`)
    const d = await resp.json() as any[]
    // d[0] is array of [translated_chunk, original_chunk, ...]
    const translated = (d[0] as any[]).map((chunk: any) => chunk[0]).filter(Boolean).join("")
    if (!translated) throw new Error("no result")
    return res.json({ translated })
  } catch (err: any) {
    res.status(502).json({ error: err.message })
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

function mkContainer(type: string, defaultTitle: string) {
  return {
    render(tokens: any[], idx: number) {
      if (tokens[idx].nesting === 1) {
        const custom = tokens[idx].info.trim().slice(type.length).trim()
        const title = custom ? escapeHtml(custom) : defaultTitle
        return `<div class="md-container md-container-${type}"><p class="md-container-title">${title}</p>\n`
      }
      return `</div>\n`
    },
  }
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

app.get("/api/notes/project", (req, res) => {
  const sessionRoot = getSessionRoot(req)
  if (!sessionRoot) return res.json({ content: null })
  const notePath = path.join(sessionRoot, ".notes", "PROJECT.md")
  try {
    if (!fs.existsSync(notePath)) return res.json({ content: null })
    res.json({ content: fs.readFileSync(notePath, "utf8") })
  } catch (err: any) {
    res.status(403).json({ error: err.message })
  }
})

app.post("/api/notes/project", (req, res) => {
  const sessionRoot = getSessionRoot(req)
  if (!sessionRoot) return res.status(400).json({ error: "no project root" })
  const { content } = req.body as { content?: string }
  if (typeof content !== "string") return res.status(400).json({ error: "content required" })
  const notePath = path.join(sessionRoot, ".notes", "PROJECT.md")
  try {
    if (!content.trim()) {
      try { fs.unlinkSync(notePath) } catch {}
      return res.json({ ok: true, deleted: true })
    }
    fs.mkdirSync(path.dirname(notePath), { recursive: true })
    fs.writeFileSync(notePath, content, "utf8")
    res.json({ ok: true })
  } catch (err: any) {
    res.status(403).json({ error: err.message })
  }
})

app.delete("/api/notes/project", (req, res) => {
  const sessionRoot = getSessionRoot(req)
  if (!sessionRoot) return res.status(400).json({ error: "no project root" })
  const notePath = path.join(sessionRoot, ".notes", "PROJECT.md")
  try { fs.unlinkSync(notePath) } catch {}
  res.json({ ok: true })
})

app.post("/api/render-markdown", async (req, res) => {
  try {
    const { content } = req.body as { content?: string }
    if (typeof content !== "string") return res.status(400).json({ error: "content required" })
    const md = await getMdShiki()
    res.json({ html: md.render(content) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/notes", (req, res) => {
  try {
    const sessionRoot = getSessionRoot(req)
    const notePath = safeNoteResolve(req.query.path as string, sessionRoot)
    if (!fs.existsSync(notePath)) return res.json({ content: null })
    res.json({ content: fs.readFileSync(notePath, "utf8") })
  } catch (err: any) {
    res.status(403).json({ error: err.message })
  }
})

app.post("/api/notes", (req, res) => {
  try {
    const sessionRoot = getSessionRoot(req)
    const { path: filePath, content } = req.body as { path?: string; content?: string }
    if (typeof filePath !== "string" || typeof content !== "string") {
      return res.status(400).json({ error: "path and content required" })
    }
    const notePath = safeNoteResolve(filePath, sessionRoot)
    if (!content.trim()) {
      try { fs.unlinkSync(notePath) } catch {}
      return res.json({ ok: true, deleted: true })
    }
    fs.mkdirSync(path.dirname(notePath), { recursive: true })
    fs.writeFileSync(notePath, content, "utf8")
    res.json({ ok: true })
  } catch (err: any) {
    res.status(403).json({ error: err.message })
  }
})

app.delete("/api/notes", (req, res) => {
  try {
    const sessionRoot = getSessionRoot(req)
    const notePath = safeNoteResolve(req.query.path as string, sessionRoot)
    try { fs.unlinkSync(notePath) } catch {}
    res.json({ ok: true })
  } catch (err: any) {
    res.status(403).json({ error: err.message })
  }
})

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
        // findstr 부분 문자열 매칭 대신 전체 netstat 출력을 파싱하여 정확한 포트 비교.
        // 예: findstr :4310 은 :43100 도 매칭하여 VPN/RDP 관련 프로세스를 잘못 종료할 수 있음.
        const output = execSync(`netstat -ano`, { encoding: "utf8" })
        for (const line of output.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed.includes("LISTENING")) continue
          const parts = trimmed.split(/\s+/)
          // netstat 포맷: Proto LocalAddr ForeignAddr State PID
          if (parts.length < 5) continue
          const localAddr = parts[1] || ""
          // 정확한 포트 매칭: ":4310"으로 끝나는지 확인 (":43100" 등 제외)
          if (!localAddr.endsWith(`:${port}`)) continue
          const pid = parts[parts.length - 1]
          if (pid && /^\d+$/.test(pid) && parseInt(pid) !== process.pid) {
            console.log("[viewer:kill existing]", { port, pid })
            // /t (tree) 플래그 제거: 자식 프로세스 전체 트리 종료를 방지 (VPN/RDP 끊김 원인)
            try { execSync(`taskkill /pid ${pid} /f`, { stdio: "ignore" }) } catch {}
          }
        }
      } catch {}
    } else {
      try { execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" }) } catch {}
    }
  } catch {}
}

let startRetries = 0
const MAX_START_RETRIES = 5

function startServer() {
  httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[viewer] running at http://0.0.0.0:${PORT} (also http://127.0.0.1:${PORT})`)
    console.log(`[viewer] mode: standalone`)
    startRetries = 0
  })

  httpServer.on("connection", (socket) => {
    openSockets.add(socket)
    socket.once("close", () => openSockets.delete(socket))
  })

  httpServer.on("error", (err: any) => {
    console.error("[viewer:listen error]", err)

    if (err?.code === "EADDRINUSE" && startRetries < MAX_START_RETRIES) {
      startRetries++
      const delay = 500 * startRetries
      console.log(`[viewer:retry after kill] attempt=${startRetries} delay=${delay}ms`)
      killProcessOnPort(PORT)
      setTimeout(() => startServer(), delay)
      return
    }

    shutdownServer("listen error", err?.message)
  })
}

const parentPids = new Set<number>()
if (PARENT_PID) parentPids.add(PARENT_PID)

app.post("/api/register-pid", (req, res) => {
  const newPid = Number(req.body?.pid)
  if (newPid > 0) {
    // 이전 OpenCode 프로세스가 아직 살아있으면 kill → zombie socket 방지.
    // NSSM restart 시 이전 OpenCode(4096 점유)가 강제 kill 되지 않고 살아있는 경우를 처리.
    for (const oldPid of [...parentPids]) {
      if (oldPid === newPid) continue
      let alive = false
      try { process.kill(oldPid, 0); alive = true } catch {}
      if (alive) {
        console.log("[viewer] stale parent pid still alive, killing:", oldPid)
        try {
          if (process.platform === "win32") {
            execSync(`taskkill /f /pid ${oldPid}`, { stdio: "ignore" })
          } else {
            process.kill(oldPid, "SIGTERM")
          }
        } catch {}
      } else {
        console.log("[viewer] stale parent pid already gone:", oldPid)
      }
      parentPids.delete(oldPid)
    }
    parentPids.add(newPid)
    console.log("[viewer] registered pid:", newPid, "total:", parentPids.size)
    if (shuttingDown) {
      console.log("[viewer] shutdown preempted by new pid:", newPid)
      shuttingDown = false
    }
  }
  res.json({ ok: true, pids: parentPids.size })
})

if (PARENT_PID) {
  const pidTimer = setInterval(() => {
    for (const pid of [...parentPids]) {
      try { process.kill(pid, 0) } catch { parentPids.delete(pid) }
    }
    if (parentPids.size === 0) {
      // 25s grace: NSSM 재시작 후 새 OpenCode가 plugin()을 호출해 register-pid를
      // 보내기까지 충분한 시간. opencode-start.ps1 기준 npm update(5s) + port wait(0-10s)
      // + opencode 기동(3s) = 최대 ~20s → 25s는 안전 마진 포함.
      // (구 120s → 25s: 불필요한 4310 포트 점유 최소화)
      setTimeout(() => {
        if (parentPids.size === 0) shutdownServer("all parent processes gone", null)
      }, 25_000)
    }
  }, 5_000)
  pidTimer.unref()
}

killProcessOnPort(PORT)
setTimeout(() => startServer(), 800)
