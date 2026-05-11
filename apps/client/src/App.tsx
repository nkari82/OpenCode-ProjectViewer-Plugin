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

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
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

interface PlantUmlViewerProps {
  url: string
  title: string
}

function PlantUmlViewer({ url, title }: PlantUmlViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svgHtml, setSvgHtml] = useState("")
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 })

  useEffect(() => {
    if (!url) return
    let cancelled = false
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.text()
      })
      .then(text => {
        if (!cancelled) setSvgHtml(text)
      })
      .catch(() => {
        if (!cancelled) setSvgHtml("")
      })
    return () => { cancelled = true }
  }, [url])

  useEffect(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [url])

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

  return (
    <div className="plantuml-viewer">
      <div className="plantuml-controls">
        <button onClick={() => setScale(s => Math.min(10, s + 0.2))}>+</button>
        <span className="plantuml-scale">{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale(s => Math.max(0.1, s - 0.2))}>−</button>
        <button onClick={resetView}>Reset</button>
      </div>
      <div
        className="plantuml-canvas"
        ref={containerRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        style={{ cursor: dragging ? "grabbing" : "default" }}
      >
        {svgHtml ? (
          <div
            className="plantuml-svg-wrapper"
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: "center center",
            }}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(svgHtml) }}
          />
        ) : (
          <div className="plantuml-loading">Loading diagram…</div>
        )}
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
    () => DOMPurify.sanitize(rendered, { ADD_TAGS: ["pre", "code", "span", "div"], ADD_ATTR: ["class", "id"] }),
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
      <div className="code-block-content" style={{ maxHeight: "calc(100vh - 120px)", overflowY: "auto" }}>
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
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(0)
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
  const refreshRef = useRef(lastRefreshAt)

  useEffect(() => { rootRef.current = root }, [root])
  useEffect(() => { refreshRef.current = lastRefreshAt }, [lastRefreshAt])

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

  async function syncFromSnapshot(snapshot: { root?: string; refreshAt?: number }) {
    const rootValue = typeof snapshot.root === "string" ? snapshot.root : ""
    const refreshAt = Number(snapshot.refreshAt) || 0

    if (rootValue && rootValue !== rootRef.current) {
      setRoot(rootValue)
      setLastRefreshAt(refreshAt)
      setTitle("")
      setFileData(EMPTY_FILE_DATA)
      setViewMode("render")
      setOpenDirs(new Set())
      await loadTree(rootValue)
      return
    }

    if (refreshAt > 0 && refreshAt !== refreshRef.current) {
      setLastRefreshAt(refreshAt)
      await loadTree(rootValue || rootRef.current)
    }
  }

  async function checkRoot() {
    try {
      const [rootData, refreshData] = await Promise.all([
        fetchJson<{ root: string }>("/api/root"),
        fetchJson<{ refreshAt: number }>("/api/refresh"),
      ])
      await syncFromSnapshot({ root: rootData.root, refreshAt: refreshData.refreshAt })
    } catch (err) {
      console.error("checkRoot failed", err)
    }
  }

  async function loadProjects() {
    setProjectsLoading(true)
    setProjectsError("")
    try {
      const data = await fetchJson<any>("/api/projects")
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
  }, [])

  useEffect(() => { void loadProjects() }, [])

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
                    onClick={(e) => { e.stopPropagation(); void loadProjects() }}
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
                          headers: { "Content-Type": "application/json" },
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
