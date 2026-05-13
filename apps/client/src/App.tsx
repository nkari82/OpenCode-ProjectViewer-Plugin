import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

// @ts-ignore
import DOMPurify from "dompurify"
import mermaid from "mermaid"

import "./styles.css"
import "katex/dist/katex.min.css"

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
})

interface Symbol {
  name: string
  line: number
}

interface FileData {
  type: string
  raw: string
  rendered: string
  highlightedRaw?: string
  url?: string
  symbols?: Symbol[]
}

const EMPTY_FILE_DATA: FileData = {
  type: "",
  raw: "",
  rendered: "",
}

const REQUEST_TIMEOUT_MS = 5000

function makeSessionId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return Date.now().toString(36) + Math.random().toString(36).slice(2)
  }
}

const SESSION_ID = (() => {
  try {
    let id = sessionStorage.getItem("viewer-session-id")
    if (!id) {
      id = makeSessionId()
      sessionStorage.setItem("viewer-session-id", id)
    }
    return id
  } catch {
    return makeSessionId()
  }
})()

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const headers = new Headers(init.headers as HeadersInit)
    headers.set("X-Session-Id", SESSION_ID)
    const response = await fetch(url, { ...init, headers, signal: controller.signal })
    if (!response.ok) {
      throw new Error(`${url} failed (${response.status})`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

interface TreeNode {
  type: "dir" | "file"
  name: string
  path: string
  children?: TreeNode[]
}

interface Project {
  id: string
  worktree: string
  name?: string
  iconColor?: string
}

const ALLOWED_EXTENSIONS = new Set([
  ".cs", ".c", ".cpp", ".cc", ".h", ".hpp", ".m", ".mm", ".py", ".js", ".jsx", ".ts", ".tsx",
  ".java", ".kt", ".scala", ".rs", ".go", ".swift", ".dart",
  ".hs", ".ex", ".erl", ".fs", ".clj",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".csv",
  ".css", ".scss", ".sass", ".less",
  ".sh", ".bash", ".ps1", ".bat",
  ".sql", ".graphql",
  ".ini", ".dockerfile", ".docker", ".makefile", ".cmake",
  ".diff", ".patch", ".md", ".markdown", ".tex",
  ".txt", ".log",
  ".env", ".gitignore", ".dockerignore",
  ".mmd", ".puml", ".html", ".pdf",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif", ".svg", ".mp3", ".mp4", ".avi", ".mkv",
])

function getFileCategory(fileName: string) {
  const lowerName = fileName.toLowerCase()

  const isSpecialFile = (name: string) => {
    if ([".gitignore", ".dockerignore", ".gitmodules", "dockerfile"].includes(name)) return true
    if (name.includes(".env")) return true
    return false
  }

  if (isSpecialFile(lowerName)) return "text"

  const dotIndex = fileName.lastIndexOf(".")
  if (dotIndex < 0) return "unknown"
  const ext = fileName.slice(dotIndex).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) return "unknown"

  if ([".md", ".markdown", ".mmd", ".puml", ".html"].includes(ext)) return "renderable"
  if ([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".avif", ".ico", ".svg", ".mp3", ".mp4", ".avi", ".mkv"].includes(ext)) return "media"
  return "text"
}

function isPreviewableFile(fileName: string) {
  return getFileCategory(fileName) !== "unknown"
}

const LANG_OPTIONS = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "zh-CN", label: "中文(简)" },
  { value: "zh-TW", label: "中文(繁)" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "ru", label: "Русский" },
]

interface PdfSegment {
  text: string
  isMath: boolean
  translated?: string
  translating?: boolean
}

function PdfViewer({ url, title, filePath }: { url: string; title: string; filePath: string }) {
  const [showTranslation, setShowTranslation] = useState(false)
  const [targetLang, setTargetLang] = useState("ko")
  const [segments, setSegments] = useState<PdfSegment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [empty, setEmpty] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const runTranslation = useCallback(async (lang: string) => {
    if (abortRef.current) abortRef.current.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)
    setError("")
    setEmpty(false)
    setSegments([])

    let segs: PdfSegment[] = []
    try {
      const headers = new Headers({ "X-Session-Id": SESSION_ID })
      const r = await fetch(`/api/pdf-text?path=${encodeURIComponent(filePath)}`, { headers, signal: ac.signal })
      const data: { segments: PdfSegment[]; empty: boolean } = await r.json()
      if (data.empty) { setEmpty(true); setLoading(false); return }
      segs = data.segments.map(s => ({ ...s }))
      setSegments([...segs])
      setLoading(false)
    } catch (err: any) {
      if (err.name !== "AbortError") setError(err.message || "추출 실패")
      setLoading(false)
      return
    }

    for (let i = 0; i < segs.length; i++) {
      if (ac.signal.aborted) break
      if (segs[i].isMath) continue

      setSegments(prev => prev.map((s, idx) => idx === i ? { ...s, translating: true } : s))
      try {
        const headers = new Headers({ "Content-Type": "application/json", "X-Session-Id": SESSION_ID })
        const r = await fetch("/api/translate", {
          method: "POST",
          headers,
          body: JSON.stringify({ text: segs[i].text, from: "auto", to: lang }),
          signal: ac.signal,
        })
        const d: { translated?: string } = await r.json()
        segs[i].translated = d.translated || segs[i].text
      } catch {
        segs[i].translated = segs[i].text
      }
      setSegments(prev => prev.map((s, idx) => idx === i ? { ...segs[i], translating: false } : s))
    }
  }, [filePath])

  const handleToggle = useCallback(() => {
    const next = !showTranslation
    setShowTranslation(next)
    if (next && segments.length === 0 && !loading) runTranslation(targetLang)
  }, [showTranslation, segments.length, loading, runTranslation, targetLang])

  const handleLangChange = useCallback((lang: string) => {
    setTargetLang(lang)
    if (showTranslation) runTranslation(lang)
  }, [showTranslation, runTranslation])

  return (
    <div className="pdf-viewer-wrapper">
      <div className="pdf-viewer-controls">
        <button className={`toolbar-btn ${showTranslation ? "active" : ""}`} onClick={handleToggle}>
          번역
        </button>
        {showTranslation && (
          <select
            className="pdf-lang-select"
            value={targetLang}
            onChange={e => handleLangChange(e.target.value)}
          >
            {LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </div>
      <div className="pdf-content-area">
        <div className={`pdf-iframe-pane${showTranslation ? " with-panel" : ""}`}>
          <iframe src={url} className="viewer-frame" title={title} />
        </div>
        {showTranslation && (
          <div className="pdf-translation-pane">
            {loading && <div className="pdf-translate-status">텍스트 추출 중…</div>}
            {empty && <div className="pdf-translate-status pdf-translate-empty">텍스트를 추출할 수 없습니다.<br />스캔된 PDF(이미지 전용)는 번역이 지원되지 않습니다.</div>}
            {error && <div className="pdf-translate-status pdf-translate-error">{error}</div>}
            {segments.map((seg, i) =>
              seg.isMath ? (
                <div key={i} className="pdf-math">{seg.text}</div>
              ) : (
                <p key={i} className={`pdf-translation-text${seg.translating ? " pdf-translating" : ""}`}>
                  {seg.translating ? "…" : (seg.translated ?? seg.text)}
                </p>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface PlantUmlViewerProps {
  url: string
  title: string
}

function PlantUmlViewer({ url, title }: PlantUmlViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 })
  const [showConfig, setShowConfig] = useState(false)
  const [serverUrl, setServerUrl] = useState("")
  const [serverUrlInput, setServerUrlInput] = useState("")
  const [savingUrl, setSavingUrl] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [svgText, setSvgText] = useState("")
  const [naturalSize, setNaturalSize] = useState({ w: 800, h: 600 })

  useEffect(() => {
    fetch("/api/plantuml-server-url")
      .then(r => r.json())
      .then(d => { setServerUrl(d.url); setServerUrlInput(d.url) })
      .catch(() => {})
  }, [])

  // Reset view position when switching to a different file
  useEffect(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [url])

  // Fetch SVG as text so we can scale dimensions directly (crisp at any zoom)
  useEffect(() => {
    setLoaded(false)
    setError(false)
    setSvgText("")
    fetch(`${url}?_t=${reloadKey}`)
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.text() })
      .then(text => {
        if (!text.includes("<svg")) throw new Error("not svg")
        const wm = text.match(/\bwidth="([0-9.]+)/)
        const hm = text.match(/\bheight="([0-9.]+)/)
        setNaturalSize({
          w: wm ? parseFloat(wm[1]) : 800,
          h: hm ? parseFloat(hm[1]) : 600,
        })
        setSvgText(DOMPurify.sanitize(text, { USE_PROFILES: { svg: true } }))
        setLoaded(true)
      })
      .catch(() => setError(true))
  }, [url, reloadKey])

  // Scale SVG by updating width/height attributes directly — no pixel scaling
  const scaledSvg = useMemo(() => {
    if (!svgText) return ""
    const w = Math.round(naturalSize.w * scale)
    const h = Math.round(naturalSize.h * scale)
    return svgText
      .replace(/(<svg\b[^>]*)\bwidth="[^"]*"/, `$1width="${w}px"`)
      .replace(/(<svg\b[^>]*)\bheight="[^"]*"/, `$1height="${h}px"`)
      .replace(/(style="[^"]*)\bwidth:[^;]*;/, `$1width:${w}px;`)
      .replace(/(style="[^"]*)\bheight:[^;]*;/, `$1height:${h}px;`)
  }, [svgText, naturalSize, scale])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setScale(s => Math.max(0.1, Math.min(10, s + delta)))
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    setDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, tx: translate.x, ty: translate.y }
  }, [translate])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging) return
    setTranslate({
      x: dragStart.current.tx + (e.clientX - dragStart.current.x),
      y: dragStart.current.ty + (e.clientY - dragStart.current.y),
    })
  }, [dragging])

  const handleMouseUp = useCallback(() => {
    setDragging(false)
  }, [])

  useEffect(() => {
    if (dragging) {
      window.addEventListener("mousemove", handleMouseMove)
      window.addEventListener("mouseup", handleMouseUp)
    } else {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [dragging, handleMouseMove, handleMouseUp])

  const resetView = useCallback(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  const handleSaveServerUrl = useCallback(async () => {
    setSavingUrl(true)
    try {
      const res = await fetch("/api/plantuml-server-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: serverUrlInput }),
      })
      const data = await res.json()
      setServerUrl(data.url)
      setShowConfig(false)
      setLoaded(false)
      setError(false)
      setReloadKey(k => k + 1)
    } catch {}
    setSavingUrl(false)
  }, [serverUrlInput])

  const handleDownload = useCallback(async (format: "svg" | "png") => {
    const downloadUrl = format === "png" ? `${url}?format=png` : url
    try {
      const res = await fetch(downloadUrl)
      const blob = await res.blob()
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `${title}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(a.href)
    } catch {}
  }, [url, title])

  const handlePrint = useCallback(() => {
    const win = window.open("", "_blank")
    if (!win) return
    const origin = window.location.origin
    win.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: white; display: flex; justify-content: center; padding: 20px; }
    img { max-width: 100%; height: auto; }
    @media print { @page { margin: 1cm; size: auto; } body { padding: 0; } }
  </style>
</head>
<body>
  <img src="${origin}${url}" onload="window.print(); window.close();" />
</body>
</html>`)
    win.document.close()
  }, [url, title])

  const isPublicServer = serverUrl.includes("plantuml.com")

  return (
    <div className="plantuml-viewer">
      <div className="plantuml-controls">
        <button onClick={() => setScale(s => Math.min(10, s + 0.2))}>+</button>
        <span className="plantuml-scale">{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale(s => Math.max(0.1, s - 0.2))}>−</button>
        <button onClick={resetView}>Reset</button>
        <span className="plantuml-controls-sep" />
        <button onClick={() => handleDownload("svg")} title="Download SVG">SVG</button>
        <button onClick={() => handleDownload("png")} title="Download PNG">PNG</button>
        <button onClick={handlePrint} title="Print / Save as PDF">Print</button>
        <span className="plantuml-controls-sep" />
        <button
          onClick={() => setShowConfig(v => !v)}
          title="Configure PlantUML server"
          className={showConfig ? "plantuml-server-btn active" : "plantuml-server-btn"}
        >
          {isPublicServer ? "⚠ Server" : "Server"}
        </button>
      </div>

      {showConfig && (
        <div className="plantuml-config-panel">
          <div className="plantuml-config-title">PlantUML Rendering Server</div>
          {isPublicServer && (
            <div className="plantuml-config-warning">
              공개 서버(plantuml.com)는 최대 4096px 제한이 있어 대형 다이어그램이 렌더링되지 않습니다.
              로컬 서버를 실행하면 제한 없이 렌더링할 수 있습니다.
            </div>
          )}
          <div className="plantuml-config-section">
            <div className="plantuml-config-label">로컬 서버 실행 방법 (Docker)</div>
            <pre className="plantuml-config-code">docker run -d -p 8181:8080 \{"\n"}  -e PLANTUML_LIMIT_SIZE=32768 \{"\n"}  plantuml/plantuml-server:jetty</pre>
          </div>
          <div className="plantuml-config-row">
            <input
              className="plantuml-config-input"
              value={serverUrlInput}
              onChange={e => setServerUrlInput(e.target.value)}
              placeholder="http://localhost:8181"
              onKeyDown={e => { if (e.key === "Enter") handleSaveServerUrl() }}
            />
            <button
              className="plantuml-config-save"
              onClick={handleSaveServerUrl}
              disabled={savingUrl || serverUrlInput === serverUrl}
            >
              {savingUrl ? "저장중…" : "적용"}
            </button>
            <button
              className="plantuml-config-reset"
              onClick={() => setServerUrlInput("https://www.plantuml.com/plantuml")}
              title="공개 서버로 초기화"
            >
              초기화
            </button>
          </div>
          <div className="plantuml-config-current">현재: {serverUrl}</div>
        </div>
      )}

      <div
        className="plantuml-canvas"
        ref={containerRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        style={{ cursor: dragging ? "grabbing" : "default" }}
      >
        {!loaded && !error && (
          <div className="plantuml-loading">Loading diagram…</div>
        )}
        {error && (
          <div className="plantuml-error">
            <div className="plantuml-error-title">렌더링 실패</div>
            <div className="plantuml-error-detail">
              {isPublicServer
                ? "다이어그램이 너무 크거나 서버에 연결할 수 없습니다. 위의 \"Server\" 버튼을 눌러 로컬 서버를 설정하세요."
                : "PlantUML 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요."}
            </div>
          </div>
        )}
        <div
          className="plantuml-svg-wrapper"
          style={{
            display: loaded ? "block" : "none",
            transform: `translate(${translate.x}px, ${translate.y}px)`,
            transformOrigin: "top left",
          }}
          dangerouslySetInnerHTML={{ __html: scaledSvg }}
        />
      </div>
    </div>
  )
}

interface CodeBlockProps {
  rendered: string
  symbols?: Symbol[]
  onFileOpen?: (path: string, name: string) => void
  currentPath?: string
  viewMode: "render" | "text"
  fileType?: string
}

function CodeBlock({ rendered, symbols, onFileOpen, currentPath, viewMode, fileType }: CodeBlockProps) {
  const sanitizedHtml = useMemo(
    () => DOMPurify.sanitize(rendered, {
      ADD_TAGS: ["pre", "code", "span", "div", "input"],
      ADD_ATTR: ["class", "id", "style", "checked", "disabled", "type"],
    }),
    [rendered],
  )

  const selectRef = useRef<HTMLSelectElement>(null)

  const scrollToLine = (symbol: Symbol, index: number) => {
    if (fileType === "markdown" && viewMode === "render") {
      const container = document.querySelector(".preview-html")
      if (!container) return
      const headings = container.querySelectorAll("h1, h2, h3, h4, h5, h6")
      const target = headings[index] as HTMLElement | undefined
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" })
        target.style.backgroundColor = "rgba(255, 255, 255, 0.05)"
        setTimeout(() => { target.style.backgroundColor = "" }, 1000)
      }
    } else {
      const container = document.querySelector(".code-block-content")
      if (!container) return
      const lines = container.querySelectorAll(".shiki .line")
      const targetLine = lines[symbol.line - 1] as HTMLElement | undefined
      if (targetLine) {
        targetLine.scrollIntoView({ behavior: "smooth", block: "start" })
        targetLine.style.backgroundColor = "rgba(255, 255, 255, 0.1)"
        setTimeout(() => { targetLine.style.backgroundColor = "transparent" }, 1000)
      }
    }
  }

  return (
    <div className="code-block">
      {symbols && symbols.length > 0 && (
        <div className="function-bar">
          <select
            ref={selectRef}
            onChange={(e) => {
              const index = parseInt(e.target.value)
              const symbol = symbols[index]
              if (symbol) scrollToLine(symbol, index)
              if (selectRef.current) selectRef.current.value = ""
            }}
            defaultValue=""
          >
            <option value="" disabled>네비게이션</option>
            {symbols.map((s, index) => (
              <option key={index} value={index}>{s.name}</option>
            ))}
          </select>
        </div>
      )}
      <div className="code-block-content" style={{ maxHeight: "calc(100vh - 120px)", overflowY: "auto", overflowX: "auto" }}>
        <div
          className="preview-html"
          onClick={(e) => {
            const target = (e.target as HTMLElement).closest("a")
            if (target && onFileOpen && currentPath) {
              e.preventDefault()
              const href = target.getAttribute("href")
              if (href && !href.startsWith("http")) {
                const resolved = new URL(href, window.location.origin + currentPath).pathname
                const name = resolved.split("/").pop() || resolved
                onFileOpen(resolved, name)
              } else if (href) {
                window.open(href, "_blank")
              }
            }
          }}
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      </div>
    </div>
  )
}

export default function App() {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [title, setTitle] = useState<string>("")
  const [root, setRoot] = useState<string>("")
  const [viewMode, setViewMode] = useState<"render" | "text">("render")
  const [fileData, setFileData] = useState<FileData>(EMPTY_FILE_DATA)
  const [currentPath, setCurrentPath] = useState<string>("")
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set())
  const [projects, setProjects] = useState<Project[]>([])
  const [showProjectList, setShowProjectList] = useState<boolean>(false)
  const [projectsLoading, setProjectsLoading] = useState<boolean>(false)
  const [projectsError, setProjectsError] = useState<string>("")
  const [sidebarVisible, setSidebarVisible] = useState(window.innerWidth > 768)
  const [sidebarWidth, setSidebarWidth] = useState(340)
  const [hoveredPath, setHoveredPath] = useState("")
  const [resizing, setResizing] = useState(false)
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768)
  const isResizingRef = useRef(false)
  const resizeStartX = useRef(0)
  const resizeStartWidth = useRef(0)

  const projectName = useMemo(() => {
    if (!root) return "No Project"
    const parts = root.split(/[\\/]+/).filter(Boolean)
    return parts.at(-1) || root
  }, [root])

  const syncTokenRef = useRef(0)
  const rootRef = useRef(root)
  const checkRootPendingRef = useRef(false)

  useEffect(() => { rootRef.current = root }, [root])

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return
      const w = Math.min(600, Math.max(180, resizeStartWidth.current + e.clientX - resizeStartX.current))
      setSidebarWidth(w)
    }
    const onUp = () => {
      if (!isResizingRef.current) return
      isResizingRef.current = false
      setResizing(false)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [])

  function startResize(e: React.MouseEvent) {
    isResizingRef.current = true
    setResizing(true)
    resizeStartX.current = e.clientX
    resizeStartWidth.current = sidebarWidth
    e.preventDefault()
  }

  function relPath(full: string): string {
    if (!full) return ""
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "")
    const rel = norm(full).slice(norm(root).length).replace(/^\//, "")
    return rel || full
  }

  async function loadTree(expectedRoot: string) {
    const token = ++syncTokenRef.current

    try {
      const [data, rootData] = await Promise.all([
        fetchJson<TreeNode[]>("/api/tree"),
        fetchJson<{ root: string }>("/api/root"),
      ])

      if (token !== syncTokenRef.current || (expectedRoot && rootData.root !== expectedRoot)) {
        return
      }

      setTree(data)
    } catch (err) {
      console.error("loadTree failed", err)
    }
  }

  async function checkRoot() {
    if (checkRootPendingRef.current) return
    checkRootPendingRef.current = true
    try {
      const data = await fetchJson<{ root: string }>("/api/root")
      const rootValue = data.root || ""
      if (rootValue && rootValue !== rootRef.current) {
        setRoot(rootValue)
        setTitle("")
        setFileData(EMPTY_FILE_DATA)
        setViewMode("render")
        setOpenDirs(new Set())
        await loadTree(rootValue)
      }
    } catch (err) {
      console.error("checkRoot failed", err)
    } finally {
      checkRootPendingRef.current = false
    }
  }

  async function loadProjects(forceRefresh = false) {
    setProjectsLoading(true)
    setProjectsError("")
    try {
      const url = forceRefresh ? "/api/projects?refresh=1" : "/api/projects"
      const data = await fetchJson<any>(url)
      if (data.ok && Array.isArray(data.projects)) {
        setProjects(data.projects)
      } else if (!data.ok) {
        setProjectsError(data.error || "목록 로드 실패")
      }
    } catch (err) {
      setProjectsError("서버 연결 실패")
      console.error("loadProjects failed", err)
    } finally {
      setProjectsLoading(false)
    }
  }

  useEffect(() => {
    void checkRoot()
    const timer = setInterval(() => void checkRoot(), 5000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => { void loadProjects() }, [])

  useEffect(() => {
    if (showProjectList) void loadProjects()
  }, [showProjectList])

  useEffect(() => {
    if (viewMode !== "render" || fileData.type !== "mermaid") return

    async function renderMermaid() {
      const blocks = document.querySelectorAll(".language-mermaid")
      for (const block of blocks) {
        try {
          const id = "m-" + Math.random().toString(36).slice(2)
          const code = block.textContent
          const { svg } = await mermaid.render(id, code!)
          const wrapper = document.createElement("div")
          wrapper.className = "diagram-frame"
          wrapper.innerHTML = svg
          block.parentElement!.replaceWith(wrapper)
        } catch (err) {
          console.error(err)
        }
      }
    }

    renderMermaid()
  }, [fileData, viewMode])

  async function openFile(filePath: string, name: string) {
    setTitle(name)
    setCurrentPath(filePath)

    try {
      const data = await fetchJson<FileData>(`/api/file?path=${encodeURIComponent(filePath)}`)
      setFileData(data)
      setViewMode("render")
    } catch (err) {
      console.error("openFile failed", err)
      setFileData({ type: "text", raw: String(err), rendered: "" })
      setViewMode("text")
    }
  }

  function toggleDir(dirPath: string) {
    setOpenDirs(prev => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      return next
    })
  }

  function render(nodes: TreeNode[]) {
    return nodes.map(node => {
      const hasChildren = Array.isArray(node.children) && node.children.length > 0
      const isDir = node.type === "dir"
      const isOpen = openDirs.has(node.path)
      const isSelectable = isDir || isPreviewableFile(node.name)

      return (
        <div key={node.path} className="tree-item">
          <div className="row">
            <div
              className={isDir ? "node dir-node" : isSelectable ? "node" : "node disabled"}
              onMouseEnter={() => setHoveredPath(node.path)}
              onMouseLeave={() => setHoveredPath("")}
              onClick={() => {
                setHoveredPath(node.path)
                if (isDir) {
                  toggleDir(node.path)
                  return
                }
                if (!isSelectable) return
                if (window.innerWidth <= 768) {
                  setSidebarVisible(false)
                }
                openFile(node.path, node.name)
              }}
            >
              {isDir && (
                <span className="tree-chevron">
                  {hasChildren ? (isOpen ? "▼" : "▶") : "•"}
                </span>
              )}
              <span className="tree-icon">{isDir ? (isOpen ? "📂" : "📁") : "📄"}</span>
              <span className="tree-label">{node.name}</span>
            </div>
          </div>

          {hasChildren && isOpen && (
            <div className="children">{render(node.children!)}</div>
          )}
        </div>
      )
    })
  }

  const renderToggle = useMemo(() => getFileCategory(title) === "renderable", [title])

  function renderPreview() {
    const cat = getFileCategory(title)

    if (viewMode === "render" && cat === "renderable") {
      if (fileData.type === "pdf") {
        return <iframe src={fileData.url} className="viewer-frame" title={title} />
      }
      if (fileData.type === "html") {
        return <iframe src={fileData.url} className="viewer-frame" sandbox="allow-same-origin allow-scripts allow-forms allow-popups" title={title} />
      }
      if (fileData.type === "plantuml") {
        return <PlantUmlViewer url={fileData.url!} title={title} />
      }
      return (
        <CodeBlock
          rendered={fileData.rendered}
          symbols={fileData.symbols}
          onFileOpen={openFile}
          currentPath={currentPath}
          viewMode={viewMode}
          fileType={fileData.type}
        />
      )
    }

    if (cat === "media") {
      if (fileData.type === "image") return <img src={fileData.url} alt={title} className="image-preview" />
      if (fileData.type === "pdf") return <PdfViewer url={fileData.url!} title={title} filePath={currentPath} />
      return <iframe src={fileData.url} className="viewer-frame" title={title} />
    }

    if (fileData.type === "code" || (cat === "renderable" && fileData.highlightedRaw)) {
      const contentToRender = viewMode === "text" && fileData.highlightedRaw
        ? fileData.highlightedRaw
        : fileData.rendered
      return (
        <CodeBlock
          rendered={contentToRender}
          symbols={fileData.symbols}
          onFileOpen={openFile}
          currentPath={currentPath}
          viewMode={viewMode}
          fileType={fileData.type}
        />
      )
    }

    return <CodeBlock rendered={`<pre><code>${escapeHtml(fileData.raw)}</code></pre>`} viewMode={viewMode} />
  }

  return (
    <div className="app-container" style={resizing ? { userSelect: "none", cursor: "col-resize" } : undefined}>
      <div className="sidebar-trigger-area" />
      <button
        className={`sidebar-toggle-btn ${sidebarVisible ? "hidden" : ""}`}
        onClick={() => setSidebarVisible(true)}
      >
        ▶
      </button>

      <div
        className={`sidebar ${sidebarVisible ? "visible" : "hidden"}`}
        style={!isMobile ? { width: sidebarWidth, transition: resizing ? "none" : undefined } : undefined}
      >
        <div className="sidebar-fixed-header">
          <button className="sidebar-close-btn" onClick={() => setSidebarVisible(false)}>
            &times;
          </button>
          <div className="sidebar-title">OpenCode Viewer</div>
          <div className="project-header">
            <div
              className="project-name project-name-clickable"
              onClick={() => setShowProjectList(!showProjectList)}
              title="클릭하여 프로젝트 선택"
            >
              {projectName || "프로젝트 선택"}
              <span className="project-arrow">{showProjectList ? "▲" : "▼"}</span>
            </div>

            {showProjectList && (
              <div className="project-list">
                <div className="project-list-header">
                  <span>프로젝트 목록 ({projects.length})</span>
                  <button
                    className="project-refresh-btn"
                    onClick={(e) => { e.stopPropagation(); void loadProjects(true) }}
                    disabled={projectsLoading}
                    title="목록 새로고침"
                  >
                    {projectsLoading ? "⟳" : "↺"}
                  </button>
                </div>
                {projectsLoading && (
                  <div className="project-list-empty">로딩 중…</div>
                )}
                {!projectsLoading && projectsError && (
                  <div className="project-list-error" title={projectsError}>{projectsError}</div>
                )}
                {!projectsLoading && !projectsError && projects.length === 0 && (
                  <div className="project-list-empty">프로젝트 없음</div>
                )}
                {!projectsLoading && projects.map(p => (
                  <div
                    key={p.id}
                    className={p.worktree === root ? "project-list-item active" : "project-list-item"}
                    onClick={async () => {
                      setShowProjectList(false)
                      try {
                        const resp = await fetch("/api/open-project", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
                          body: JSON.stringify({ path: p.worktree }),
                        })
                        if (resp.ok) {
                          const data = await resp.json()
                          const resolvedRoot = data.root || p.worktree
                          setRoot(resolvedRoot)
                          setTitle("")
                          setFileData(EMPTY_FILE_DATA)
                          setViewMode("render")
                          setOpenDirs(new Set())
                          await loadTree(resolvedRoot)
                        }
                      } catch (err) {
                        console.error("switch project failed", err)
                      }
                    }}
                  >
                    <span className="project-list-color" style={{ backgroundColor: p.iconColor || "#666" }} />
                    <span className="project-list-name" title={p.worktree}>
                      {p.name || p.worktree.split(/[\\/]/).pop()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="project-root">{root || "프로젝트 경로 없음"}</div>
          </div>
        </div>
        <div className="sidebar-scrollable-tree">{render(tree)}</div>

        <div
          className="sidebar-path-bar"
          title={hoveredPath || currentPath}
        >
          {relPath(hoveredPath || currentPath)}
        </div>

        {!isMobile && (
          <div className="sidebar-resize-handle" onMouseDown={startResize} />
        )}
      </div>

      <div
        className="main"
        onClick={() => window.innerWidth <= 768 && sidebarVisible && setSidebarVisible(false)}
      >
        <div className="titlebar">
          <div className="title">{title || "Select File"}</div>
          {renderToggle && (
            <div className="toolbar">
              <button
                className={viewMode === "render" ? "toolbar-btn active" : "toolbar-btn"}
                onClick={() => setViewMode("render")}
              >
                Render
              </button>
              <button
                className={viewMode === "text" ? "toolbar-btn active" : "toolbar-btn"}
                onClick={() => setViewMode("text")}
              >
                Text
              </button>
            </div>
          )}
        </div>
        <div className="preview">{renderPreview()}</div>
      </div>
    </div>
  )
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
