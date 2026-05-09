import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import mermaid from "mermaid"
// @ts-ignore
import DOMPurify from "dompurify"

import "./styles.css"

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
})

interface Symbol {
  name: string;
  line: number;
}

interface FileData {
  type: string;
  raw: string;
  rendered: string;
  url: string;
  symbols?: Symbol[];
}

const EMPTY_FILE_DATA: FileData = {
  type: "",
  raw: "",
  rendered: "",
  url: "",
}

const REQUEST_TIMEOUT_MS =
  5000

const POLL_INTERVAL_MS =
  5000

async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const controller =
    new AbortController()

  const timer =
    setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    )

  try {
    const response =
      await fetch(
        url,
        {
          ...init,
          signal:
            controller.signal,
        },
      )

    if (!response.ok) {
      throw new Error(
        `${url} failed (${response.status})`,
      )
    }

    return await response.json()
  }
  finally {
    clearTimeout(timer)
  }
}

interface TreeNode {
  type: "dir" | "file";
  name: string;
  path: string;
  children?: TreeNode[];
}

interface Project {
  id: string;
  worktree: string;
  name?: string;
  iconColor?: string;
}

// ... 내부에 타입 적용

const PREVIEWABLE_EXTENSIONS =
  new Set([
    ".md",
    ".markdown",
    ".mmd",
    ".puml",
    ".pdf",
    ".txt",
    ".log",
    ".cs",
    ".c",
    ".cpp",
    ".cc",
    ".h",
    ".hpp",
    ".m",
    ".mm",
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".json",
    ".yaml",
    ".yml",
    ".xml",
    ".html",
    ".css",
    ".sh",
    ".sql",
    ".rs",
    ".go",
    ".java",
    ".swift",
    ".kt",
  ])

const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".webm", ".flac", ".wav",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".db", ".sqlite", ".sqlite3",
  ".o", ".obj", ".a", ".lib",
])

function isPreviewableFile(
  fileName,
) {
  const dotIndex =
    fileName.lastIndexOf(".")

  if (dotIndex < 0) {
    return true
  }

  const ext =
    fileName
      .slice(dotIndex)
      .toLowerCase()

  if (BINARY_EXTENSIONS.has(ext)) {
    return false
  }

  return true
}

interface PlantUmlViewerProps {
  url: string;
  title: string;
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

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setScale(s => Math.max(0.1, Math.min(10, s + delta)))
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setDragging(true)
    dragStart.current = {
      x: e.clientX, y: e.clientY,
      tx: translate.x, ty: translate.y,
    }
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
        onWheel={handleWheel as any}
        onMouseDown={handleMouseDown}
        style={{ cursor: dragging ? "grabbing" : "grab" }}
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
  rendered: string;
  symbols?: Symbol[];
}

function CodeBlock({ rendered, symbols }: CodeBlockProps) {
  const sanitizedHtml = useMemo(() => DOMPurify.sanitize(rendered), [rendered]);

  const scrollToLine = (line: number) => {
    const container = document.querySelector('.code-block-content');
    if (!container) return;
    
    // shiki/monokai 등 테마에 따라 행 번호가 포함된 스팬 구조를 타겟팅합니다.
    // 보통 line 클래스를 가진 요소들이 줄 단위로 존재합니다.
    const lineSpans = container.querySelectorAll('.line');
    
    // 1-based index를 0-based index로 변환
    const targetLine = lineSpans[line - 1];
    
    if (targetLine) {
        targetLine.scrollIntoView({ behavior: 'smooth', block: 'start' });
        
        // 시각적 피드백: 잠시 하이라이트 효과
        targetLine.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
        setTimeout(() => {
            targetLine.style.backgroundColor = 'transparent';
        }, 1000);
    }
  };

  return (
    <div className="code-block">
      {symbols && symbols.length > 0 && (
        <div className="function-bar">
          <select 
            onChange={(e) => {
              const line = parseInt(e.target.value);
              if (!isNaN(line)) scrollToLine(line);
            }}
            defaultValue=""
          >
            <option value="" disabled>함수 선택</option>
            {symbols.map(s => (
              <option key={s.name + s.line} value={s.line}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="code-block-content" style={{ maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' }}>
        <div
          className="preview-html"
          dangerouslySetInnerHTML={{
            __html: sanitizedHtml,
          }}
        />
      </div>
    </div>
  );
}

export default function App() {

  const [tree, setTree] =
    useState<TreeNode[]>([])

  const [title, setTitle] =
    useState<string>("")

  const [root, setRoot] =
    useState<string>("")

  const [lastRefreshAt, setLastRefreshAt] =
    useState<number>(0)

  const [viewMode, setViewMode] =
    useState<"render" | "text">("render")

  const [fileData, setFileData] =
    useState<FileData>(EMPTY_FILE_DATA)

  const [openDirs, setOpenDirs] =
    useState<Set<string>>(() => new Set())

  const [projects, setProjects] =
    useState<Project[]>([])

  const [showProjectList, setShowProjectList] =
    useState<boolean>(false)

  const [copied, setCopied] =
    useState(false)

  // Remove codeFolded state

  const projectName =
    useMemo(() => {

      if (!root) {
        return "No Project"
      }

      const parts =
        root
          .split(/[\\/]+/)
          .filter(Boolean)

      return (
        parts.at(-1) ||
        root
      )

    }, [root])

  const syncTokenRef =
    useRef(0)

  const rootRef =
    useRef(root)

  const refreshRef =
    useRef(lastRefreshAt)

  const pollInFlightRef =
    useRef(false)

  useEffect(() => {
    rootRef.current = root
  }, [root])

  useEffect(() => {
    refreshRef.current = lastRefreshAt
  }, [lastRefreshAt])

  async function loadTree(expectedRoot) {
    const token =
      ++syncTokenRef.current

    try {
      const [data, rootData] =
        await Promise.all([
          fetchJson("/api/tree"),
          fetchJson("/api/root"),
        ])

      if (
        token !== syncTokenRef.current ||
        (
          expectedRoot &&
          rootData.root !== expectedRoot
        )
      ) {
        return
      }

      setTree(data)
    }
    catch (err) {
      console.error(
        "loadTree failed",
        err,
      )
    }
  }

  async function syncFromSnapshot(snapshot) {
    const rootValue =
      typeof snapshot.root === "string"
        ? snapshot.root
        : ""

    const refreshAt =
      Number(
        snapshot.refreshAt,
      ) || 0

    if (
      rootValue &&
      rootValue !== rootRef.current
    ) {
      setRoot(rootValue)
      setLastRefreshAt(refreshAt)
      setTitle("")
      setFileData(EMPTY_FILE_DATA)
      setViewMode("render")
      setOpenDirs(new Set())
      await loadTree(rootValue)
      return
    }

    if (
      refreshAt > 0 &&
      refreshAt !== refreshRef.current
    ) {
      setLastRefreshAt(refreshAt)
      await loadTree(
        rootValue || rootRef.current,
      )
    }
  }

  async function checkRoot() {
    if (pollInFlightRef.current) {
      return
    }

    pollInFlightRef.current =
      true

    try {
      const [rootData, refreshData] =
        await Promise.all([
          fetchJson("/api/root"),
          fetchJson("/api/refresh"),
        ])

      await syncFromSnapshot({
        root: rootData.root,
        refreshAt:
          refreshData.refreshAt,
      })
    }
    catch (err) {
      console.error(
        "checkRoot failed",
        err,
      )
    }
    finally {
      pollInFlightRef.current =
        false
    }
  }

  async function loadProjects() {
    try {
      const data = await fetchJson("/api/projects")
      if (data.ok && Array.isArray(data.projects)) {
        setProjects(data.projects)
      }
    } catch (err) {
      console.error("loadProjects failed", err)
    }
  }

  useEffect(() => {

    let disposed =
      false

    void checkRoot()

    const port = window.location.port === "5173" ? "4310" : window.location.port
    const host = window.location.hostname
    const protocol = window.location.protocol === "https:" ? "wss" : "ws"
    
    const ws = new WebSocket(
      `${protocol}://${host}:${port}`,
    )

    ws.onmessage =
      event => {
        if (disposed) {
          return
        }

        try {
          const payload =
            JSON.parse(event.data)

          if (payload.type === "heartbeat") return

          void syncFromSnapshot(payload)
            .catch(err => {
              console.error(
                "syncFromSnapshot failed",
                err,
              )
            })
        }
        catch (err) {
          console.error(err)
        }
      }

    ws.onerror =
      () => {
        void checkRoot()
      }

    const timer =
      setInterval(
        () => {
          void checkRoot()
        },
        POLL_INTERVAL_MS,
      )

    return () => {
      disposed =
        true
      ws.close()
      clearInterval(timer)
    }

  }, [])

  useEffect(() => {
    void loadProjects()
  }, [])

  useEffect(() => {

    if (
      viewMode !== "render" ||
      fileData.type !== "mermaid"
    ) {
      return
    }

    async function renderMermaid() {

      const blocks =
        document.querySelectorAll(
          ".language-mermaid",
        )

      for (const block of blocks) {

        try {

          const id =
            "m-" +
            Math.random()
              .toString(36)
              .slice(2)

          const code =
            block.textContent

          const { svg } =
            await mermaid.render(
              id,
              code,
            )

          const wrapper =
            document.createElement(
              "div",
            )

          wrapper.className =
            "diagram-frame"

          wrapper.innerHTML =
            svg

          block.parentElement.replaceWith(
            wrapper,
          )
        }
        catch (err) {
          console.error(err)
        }
      }
    }

    renderMermaid()

  }, [fileData, viewMode])

  async function openFile(
    path,
    name,
  ) {

    setTitle(name)

    try {
      const data =
        await fetchJson(
          `/api/file?path=${encodeURIComponent(path)}`,
        )

      setFileData(data)

      if (
        data.type === "markdown" ||
        data.type === "plantuml" ||
        data.type === "mermaid" ||
        data.type === "pdf" ||
        data.type === "html"
      ) {
        setViewMode("render")
      }
      else {
        setViewMode("text")
      }
    }
    catch (err) {
      console.error(
        "openFile failed",
        err,
      )
      setFileData({
        type: "text",
        raw: String(err),
        rendered: "",
        url: "",
      })
      setViewMode("text")
    }

    return

  }

  async function deleteFile(path) {

    if (
      !confirm(
        `${path}\n삭제할까?`,
      )
    ) {
      return
    }

    try {
      await fetchJson(
        `/api/file?path=${encodeURIComponent(path)}`,
        {
          method: "DELETE",
        },
      )

      await loadTree(rootRef.current)

      setTitle("")

      setFileData(EMPTY_FILE_DATA)
    }
    catch (err) {
      console.error(
        "deleteFile failed",
        err,
      )
    }
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(fileData.raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error("Copy failed", err)
    }
  }

  function toggleDir(path) {
    setOpenDirs(prev => {
      const next =
        new Set(prev)

      if (next.has(path)) {
        next.delete(path)
      }
      else {
        next.add(path)
      }

      return next
    })
  }

  function render(nodes) {

    return nodes.map(node => {
      const hasChildren =
        Array.isArray(node.children) &&
        node.children.length > 0

      const isDir =
        node.type === "dir"

      const isOpen =
        openDirs.has(node.path)

      const isSelectable =
        isDir ||
        isPreviewableFile(
          node.name,
        )

      return (
        <div
          key={node.path}
          className="tree-item"
        >

          <div className="row">

            <div
              className={
                isDir
                  ? "node dir-node"
                  : isSelectable
                    ? "node"
                    : "node disabled"
              }
              onClick={() => {
                if (isDir) {
                  toggleDir(node.path)
                  return
                }

                if (!isSelectable) {
                  return
                }

                if (window.innerWidth <= 768) {
                  setSidebarVisible(false)
                }
                
                openFile(
                  node.path,
                  node.name,
                )
              }}
            >
              {isDir && (
                <span className="tree-chevron">
                  {hasChildren
                    ? isOpen
                      ? "▼"
                      : "▶"
                    : "•"}
                </span>
              )}

              <span className="tree-icon">
                {isDir
                  ? isOpen
                    ? "📂"
                    : "📁"
                  : "📄"}
              </span>

              <span className="tree-label">
                {node.name}
              </span>
            </div>

            {node.type === "file" && (
              <span className="file-padding"></span>
            )}

          </div>

          {hasChildren && isOpen && (
            <div className="children">
              {render(
                node.children,
              )}
            </div>
          )}

        </div>
      )
    })
  }

  const previewHtml =
    useMemo(() => {

      if (
        viewMode === "text"
      ) {

        return `
<pre><code>${escapeHtml(fileData.raw)}</code></pre>
`
      }

      return (
        fileData.rendered ||
        ""
      )

    }, [
      fileData,
      viewMode,
    ])

  const renderToggle =
    fileData.type === "markdown" ||
    fileData.type === "html" ||
    fileData.type === "plantuml" ||
    fileData.type === "mermaid"

  function renderPreview() {
    if (
      viewMode === "render" &&
      fileData.type === "pdf" &&
      fileData.url
    ) {
      return (
        <iframe
          src={fileData.url}
          className="viewer-frame"
          title={title || "PDF Preview"}
        />
      )
    }

    if (
      viewMode === "render" &&
      fileData.type === "html" &&
      fileData.url
    ) {
      return (
        <iframe
          src={fileData.url}
          className="viewer-frame"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          title={title || "HTML Preview"}
        />
      )
    }

    if (
      viewMode === "render" &&
      fileData.type === "plantuml" &&
      fileData.url
    ) {
      return (
        <PlantUmlViewer
          url={fileData.url}
          title={title || "PlantUML Preview"}
        />
      )
    }

    if (
      viewMode === "render" &&
      fileData.type === "image" &&
      fileData.url
    ) {
      return (
        <img
          src={fileData.url}
          alt={title || "Image Preview"}
          className="image-preview"
        />
      )
    }

    return (
      <CodeBlock rendered={previewHtml} symbols={fileData.symbols} />
    )
  }

  const [sidebarVisible, setSidebarVisible] = useState(window.innerWidth > 768);

  return (
    <div className="app-container">
      {/* 화면 좌측 끝 감지 영역 및 토글 버튼 */}
      <div className="sidebar-trigger-area" />
      <button 
        className={`sidebar-toggle-btn ${sidebarVisible ? 'hidden' : ''}`}
        onClick={() => setSidebarVisible(true)}
      >
        ▶
      </button>

      <div className={`sidebar ${sidebarVisible ? 'visible' : 'hidden'}`}>
        <div className="sidebar-fixed-header">
          <button 
            className="sidebar-close-btn"
            onClick={() => setSidebarVisible(false)}
          >
            &times;
          </button>
          <div className="sidebar-title">
            OpenCode Viewer
          </div>
          <div className="project-header">
            <div
              className="project-name project-name-clickable"
              onClick={() =>
                setShowProjectList(!showProjectList)
              }
              title="클릭하여 프로젝트 선택"
            >
              {projectName || "프로젝트 선택"}
              <span className="project-arrow">
                {showProjectList ? "▲" : "▼"}
              </span>
            </div>

            {showProjectList && (
              <div className="project-list">
                {projects.length === 0 && (
                  <div className="project-list-empty">
                    프로젝트 없음
                  </div>
                )}
                {projects.map(p => (
                  <div
                    key={p.id}
                    className={
                      p.worktree === root
                        ? "project-list-item active"
                        : "project-list-item"
                    }
                    onClick={async () => {
                      setShowProjectList(false)
                      try {
                        const resp = await fetch(
                          "/api/open-project",
                          {
                            method: "POST",
                            headers: {
                              "Content-Type":
                                "application/json",
                            },
                            body: JSON.stringify(
                              { path: p.worktree },
                            ),
                          },
                        )
                        if (resp.ok) {
                          setRoot(p.worktree)
                          await loadTree(
                            p.worktree,
                          )
                          await loadProjects()
                        }
                      } catch (err) {
                        console.error(
                          "switch project failed",
                          err,
                        )
                      }
                    }}
                  >
                    <span
                      className="project-list-color"
                      style={{
                        backgroundColor:
                          p.iconColor ||
                          "#666",
                      }}
                    />
                    <span className="project-list-name">
                      {p.name ||
                        p.worktree.split(
                          /[\\/]/,
                        ).pop()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="project-root">
              {root || "프로젝트 경로 없음"}
            </div>
          </div>
        </div>
        <div className="sidebar-scrollable-tree">
          {render(tree)}
        </div>
      </div>

      <div className="main" onClick={() => window.innerWidth <= 768 && sidebarVisible && setSidebarVisible(false)}>
        <div className="titlebar">
          <div className="title">
            {title || "Select File"}
          </div>
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
        <div className="preview">
          {renderPreview()}
        </div>
      </div>
    </div>
  )
}

function escapeHtml(text) {

  return text
    .replaceAll(
      "&",
      "&amp;",
    )
    .replaceAll(
      "<",
      "&lt;",
    )
    .replaceAll(
      ">",
      "&gt;",
    )
}
