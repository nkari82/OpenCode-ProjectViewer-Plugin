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
import * as pdfjsLib from "pdfjs-dist"
import "./styles.css"
import "katex/dist/katex.min.css"

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href

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

async function fetchJson<T>(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS)

  // Combine caller's signal with the timeout signal
  const combined = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal

  try {
    const headers = new Headers(init.headers as HeadersInit)
    headers.set("X-Session-Id", SESSION_ID)
    const response = await fetch(url, { ...init, headers, signal: combined })
    if (!response.ok) {
      throw new Error(`${url} failed (${response.status})`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

interface SearchResult {
  path: string
  name: string
  dir: string
  matches?: { line: number; text: string }[]
}

interface TreeNode {
  type: "dir" | "file"
  name: string
  path: string
  truncated?: true
  total?: number
  offset?: number
  parentPath?: string
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
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif", ".svg",
  ".wav", ".mp3", ".ogg", ".flac", ".aac", ".m4a", ".opus", ".weba", ".wma", ".aiff", ".au",
  ".mp4", ".avi", ".mkv",
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
  if ([".wav", ".mp3", ".ogg", ".flac", ".aac", ".m4a", ".opus", ".weba", ".wma", ".aiff", ".au"].includes(ext)) return "audio"
  if ([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".avif", ".ico", ".svg", ".mp4", ".avi", ".mkv"].includes(ext)) return "media"
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
  page: number
}

function useMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth <= 768)
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth <= 768)
    window.addEventListener("resize", handler)
    return () => window.removeEventListener("resize", handler)
  }, [])
  return mobile
}

function PdfPageCanvas({ pdfPage, scale }: { pdfPage: any; scale: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [shouldRender, setShouldRender] = useState(false)
  const vp = useMemo(() => pdfPage.getViewport({ scale }), [pdfPage, scale])

  // Trigger render only when page enters viewport (+ 400px margin)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (shouldRender) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setShouldRender(true) },
      { rootMargin: "400px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [shouldRender])

  useEffect(() => {
    if (!shouldRender) return
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = vp.width
    canvas.height = vp.height
    const task = pdfPage.render({ canvasContext: canvas.getContext("2d")!, viewport: vp })
    task.promise.catch(() => {})
    return () => { try { task.cancel() } catch {} }
  }, [shouldRender, pdfPage, vp])

  return (
    <div ref={containerRef} style={{ width: vp.width, height: vp.height, flexShrink: 0 }}>
      {shouldRender && (
        <canvas ref={canvasRef} style={{ display: "block", boxShadow: "0 2px 12px rgba(0,0,0,0.6)" }} />
      )}
    </div>
  )
}

function formatTime(s: number): string {
  if (!isFinite(s)) return "0:00"
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

function AudioPlayer({ url, title }: { url: string; title: string }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [waveform, setWaveform] = useState<Float32Array | null>(null)
  const rafRef = useRef(0)

  const ext = title.split(".").pop()?.toUpperCase() ?? ""

  // Decode audio and build peak waveform
  useEffect(() => {
    let cancelled = false
    fetch(url, { headers: { "X-Session-Id": SESSION_ID } })
      .then(r => r.arrayBuffer())
      .then(buf => {
        if (cancelled) return null
        return new AudioContext().decodeAudioData(buf)
      })
      .then(decoded => {
        if (!decoded || cancelled) return
        const data = decoded.getChannelData(0)
        const buckets = 900
        const step = Math.max(1, Math.floor(data.length / buckets))
        const peaks = new Float32Array(buckets)
        for (let i = 0; i < buckets; i++) {
          let max = 0
          for (let j = 0; j < step; j++) {
            const v = Math.abs(data[i * step + j] ?? 0)
            if (v > max) max = v
          }
          peaks[i] = max
        }
        if (!cancelled) setWaveform(peaks)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [url])

  // Draw waveform on canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")!
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)

    if (!waveform) {
      ctx.fillStyle = "#21262d"
      ctx.fillRect(0, H / 2 - 1, W, 2)
      return
    }

    const playedFrac = duration > 0 ? currentTime / duration : 0
    const playedX = Math.floor(W * playedFrac)
    const barW = W / waveform.length

    for (let i = 0; i < waveform.length; i++) {
      const x = i * barW
      const h = Math.max(2, waveform[i] * H * 0.88)
      const y = (H - h) / 2
      ctx.fillStyle = x < playedX ? "#3b82f6" : "#30363d"
      ctx.fillRect(x + 0.5, y, Math.max(1, barW - 1), h)
    }

    // Playhead line
    if (playedX > 0) {
      ctx.fillStyle = "#60a5fa"
      ctx.fillRect(playedX - 1, 0, 2, H)
    }
  }, [waveform, currentTime, duration])

  // RAF loop for smooth playhead during playback
  useEffect(() => {
    if (!playing) return
    const tick = () => {
      if (audioRef.current) setCurrentTime(audioRef.current.currentTime)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) { audio.pause(); setPlaying(false) }
    else { void audio.play(); setPlaying(true) }
  }

  const seekByClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const audio = audioRef.current
    if (!canvas || !audio || !duration) return
    const rect = canvas.getBoundingClientRect()
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * duration
    setCurrentTime(audio.currentTime)
  }

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        src={url}
        onLoadedMetadata={() => audioRef.current && setDuration(audioRef.current.duration)}
        onEnded={() => setPlaying(false)}
      />
      <div className="audio-header">
        <span className="audio-note">♪</span>
        <span className="audio-title">{title}</span>
        <span className="audio-badge">{ext}</span>
      </div>
      <canvas ref={canvasRef} className="audio-waveform" width={900} height={88} onClick={seekByClick} />
      <div className="audio-controls">
        <button className="audio-play-btn" onClick={togglePlay} aria-label={playing ? "일시정지" : "재생"}>
          {playing ? "⏸" : "▶"}
        </button>
        <span className="audio-time">{formatTime(currentTime)}</span>
        <input
          type="range" className="audio-seek" min={0} max={duration || 1} step={0.01} value={currentTime}
          onChange={e => {
            const t = Number(e.target.value)
            if (audioRef.current) audioRef.current.currentTime = t
            setCurrentTime(t)
          }}
        />
        <span className="audio-time">{formatTime(duration)}</span>
        <span className="audio-vol-icon">{volume === 0 ? "🔇" : "🔊"}</span>
        <input
          type="range" className="audio-vol" min={0} max={1} step={0.01} value={volume}
          onChange={e => {
            const v = Number(e.target.value)
            if (audioRef.current) audioRef.current.volume = v
            setVolume(v)
          }}
        />
      </div>
    </div>
  )
}


function PdfViewer({ url, title, filePath }: { url: string; title: string; filePath: string }) {
  const [pages, setPages] = useState<any[]>([])
  const [scale, setScale] = useState(1.5)
  const [loadError, setLoadError] = useState("")
  const [translateOn, setTranslateOn] = useState(false)
  const [targetLang, setTargetLang] = useState("ko")
  const [activeTab, setActiveTab] = useState<"pdf" | "trans">("pdf")
  const [segments, setSegments] = useState<PdfSegment[]>([])
  const [translations, setTranslations] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState("")
  const runRef = useRef("")
  const isMobile = useMobile()

  // Load PDF pages
  useEffect(() => {
    setPages([]); setLoadError("")
    const task = pdfjsLib.getDocument({ url })
    task.promise
      .then(async doc => {
        const ps: any[] = []
        for (let i = 1; i <= doc.numPages; i++) ps.push(await doc.getPage(i))
        setPages(ps)
      })
      .catch((e: any) => setLoadError(e.message || "PDF 로드 실패"))
    return () => { task.destroy() }
  }, [url])

  // Load segments
  useEffect(() => {
    if (!translateOn) { setSegments([]); setTranslations({}); return }
    setLoading(true); setFetchError(""); setSegments([]); setTranslations({}); runRef.current = ""
    fetch(`/api/pdf-text?path=${encodeURIComponent(filePath)}`, { headers: { "X-Session-Id": SESSION_ID } })
      .then(async r => {
        const data = await r.json()
        if (!r.ok || data.error) throw new Error(data.error || `오류 ${r.status}`)
        setSegments(data.segments || [])
        setLoading(false)
      })
      .catch((e: any) => { setFetchError(e.message || "추출 실패"); setLoading(false) })
  }, [translateOn, filePath])

  // Translate
  useEffect(() => {
    if (!segments.length || !translateOn) return
    const key = `${segments.length}-${targetLang}`
    if (runRef.current === key) return
    runRef.current = key
    let cancelled = false
    setTranslations({})
    ;(async () => {
      for (let i = 0; i < segments.length; i++) {
        if (cancelled || segments[i].isMath) continue
        try {
          const r = await fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
            body: JSON.stringify({ text: segments[i].text, from: "auto", to: targetLang }),
          })
          if (cancelled) break
          const d: any = await r.json()
          setTranslations(prev => ({ ...prev, [i]: d.translated || segments[i].text }))
        } catch {}
      }
    })()
    return () => { cancelled = true }
  }, [segments, targetLang, translateOn])

  // Group segments by page
  const pageGroups = useMemo(() => {
    const map = new Map<number, { idx: number; seg: PdfSegment }[]>()
    segments.forEach((seg, idx) => {
      if (!map.has(seg.page)) map.set(seg.page, [])
      map.get(seg.page)!.push({ idx, seg })
    })
    return map
  }, [segments])

  const handleTranslateToggle = () => {
    const next = !translateOn
    setTranslateOn(next)
    if (next && isMobile) setActiveTab("trans")
    if (!next && isMobile) setActiveTab("pdf")
  }

  const controls = (
    <div className="pdf-viewer-controls">
      {isMobile && translateOn && (
        <div className="pdf-tab-bar">
          <button className={`pdf-tab${activeTab === "pdf" ? " active" : ""}`} onClick={() => setActiveTab("pdf")}>원본</button>
          <button className={`pdf-tab${activeTab === "trans" ? " active" : ""}`} onClick={() => setActiveTab("trans")}>번역</button>
        </div>
      )}
      <button className="toolbar-btn" onClick={() => setScale(s => Math.max(0.5, s - 0.25))}>−</button>
      <span style={{ fontSize: 13, color: "#8b949e", minWidth: 40, textAlign: "center" }}>{Math.round(scale * 100)}%</span>
      <button className="toolbar-btn" onClick={() => setScale(s => Math.min(4, s + 0.25))}>+</button>
      <span className="plantuml-controls-sep" />
      <button className={`toolbar-btn${translateOn ? " active" : ""}`} onClick={handleTranslateToggle}>번역</button>
      {translateOn && (
        <select className="pdf-lang-select" value={targetLang} onChange={e => { setTargetLang(e.target.value); runRef.current = "" }}>
          {LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  )

  const renderPageRows = (withTrans: boolean) => (
    <>
      {loadError && <div className="pdf-translate-error" style={{ padding: 16 }}>{loadError}</div>}
      {!pages.length && !loadError && <div className="pdf-translate-status">로딩 중…</div>}
      {pages.map((page, i) => {
        const pageNum = i + 1
        const items = pageGroups.get(pageNum) || []
        return (
          <div key={i} className={`pdf-row${withTrans ? " pdf-row--split" : ""}`}>
            <div className="pdf-row-canvas">
              <PdfPageCanvas pdfPage={page} scale={scale} />
            </div>
            {withTrans && (
              <div className="pdf-row-trans">
                {loading && pageNum === 1 && <div className="pdf-translate-status">텍스트 추출 중…</div>}
                {fetchError && pageNum === 1 && <div className="pdf-translate-error">{fetchError}</div>}
                {!loading && !fetchError && segments.length === 0 && pageNum === 1 && (
                  <div className="pdf-translate-status">텍스트를 추출할 수 없습니다<br />(스캔된 PDF일 수 있습니다)</div>
                )}
                {items.map(({ idx, seg }) =>
                  seg.isMath ? (
                    <p key={idx} className="pdf-math-seg">{seg.text}</p>
                  ) : (
                    <p key={idx} className="pdf-trans-para">
                      {translations[idx] !== undefined
                        ? translations[idx]
                        : <span className="pdf-trans-pending" />}
                    </p>
                  )
                )}
              </div>
            )}
          </div>
        )
      })}
    </>
  )

  // Mobile: tabs
  if (isMobile) {
    return (
      <div className="pdf-viewer">
        {controls}
        <div className="pdf-scroll-area">
          {(!translateOn || activeTab === "pdf") && renderPageRows(false)}
          {translateOn && activeTab === "trans" && (
            <div className="pdf-mobile-trans">
              {loading && <div className="pdf-translate-status">텍스트 추출 중…</div>}
              {fetchError && <div className="pdf-translate-error">{fetchError}</div>}
              {!loading && !fetchError && segments.length === 0 && (
                <div className="pdf-translate-status">텍스트를 추출할 수 없습니다<br />(스캔된 PDF일 수 있습니다)</div>
              )}
              {segments.map((seg, i) =>
                seg.isMath ? (
                  <div key={i} className="pdf-math-seg">{seg.text}</div>
                ) : (
                  <p key={i} className="pdf-trans-para">
                    {translations[i] !== undefined ? translations[i] : <span className="pdf-trans-pending" />}
                  </p>
                )
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Desktop: single scroll area, per-page rows [canvas | translation]
  return (
    <div className="pdf-viewer">
      {controls}
      <div className="pdf-scroll-area">
        {renderPageRows(translateOn)}
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
  const scaleRef = useRef(1)
  const translateRef = useRef({ x: 0, y: 0 })
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null)
  const touchPanRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
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
    if (e.button !== 0 && e.button !== 1) return
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

  // Keep refs in sync so touch handlers always see current values
  useEffect(() => { scaleRef.current = scale }, [scale])
  useEffect(() => { translateRef.current = translate }, [translate])

  // Pinch-to-zoom + single-finger pan (non-passive to allow preventDefault)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const t1 = e.touches[0], t2 = e.touches[1]
        pinchRef.current = {
          dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
          scale: scaleRef.current,
        }
        touchPanRef.current = null
      } else if (e.touches.length === 1) {
        touchPanRef.current = {
          x: e.touches[0].clientX, y: e.touches[0].clientY,
          tx: translateRef.current.x, ty: translateRef.current.y,
        }
        pinchRef.current = null
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault()
        const t1 = e.touches[0], t2 = e.touches[1]
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)
        const next = Math.max(0.1, Math.min(10, pinchRef.current.scale * (dist / pinchRef.current.dist)))
        setScale(next)
      } else if (e.touches.length === 1 && touchPanRef.current) {
        e.preventDefault()
        setTranslate({
          x: touchPanRef.current.tx + (e.touches[0].clientX - touchPanRef.current.x),
          y: touchPanRef.current.ty + (e.touches[0].clientY - touchPanRef.current.y),
        })
      }
    }

    const onTouchEnd = () => { pinchRef.current = null; touchPanRef.current = null }

    el.addEventListener("touchstart", onTouchStart, { passive: false })
    el.addEventListener("touchmove", onTouchMove, { passive: false })
    el.addEventListener("touchend", onTouchEnd)
    return () => {
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("touchend", onTouchEnd)
    }
  }, [])

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
        style={dragging ? { cursor: "grabbing" } : undefined}
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
      ADD_TAGS: ["pre", "code", "span", "div", "input", "img"],
      ADD_ATTR: ["class", "id", "style", "checked", "disabled", "type", "src", "alt"],
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

async function renderNoteMarkdown(content: string): Promise<string> {
  try {
    const resp = await fetch("/api/render-markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    })
    if (!resp.ok) throw new Error(`status ${resp.status}`)
    const data = await resp.json()
    return data.html ?? ""
  } catch {
    return ""
  }
}

function NoteToolbar({
  onInsert,
  onPrefix,
  showDivider = false,
}: {
  onInsert: (before: string, after: string, placeholder: string) => void
  onPrefix: (prefix: string) => void
  showDivider?: boolean
}) {
  return (
    <div className="note-toolbar">
      <button onMouseDown={e => { e.preventDefault(); onPrefix("# ") }} title="제목 1">H1</button>
      <button onMouseDown={e => { e.preventDefault(); onPrefix("## ") }} title="제목 2">H2</button>
      <button onMouseDown={e => { e.preventDefault(); onPrefix("### ") }} title="제목 3">H3</button>
      <span className="note-toolbar-sep" />
      <button className="tb-bold" onMouseDown={e => { e.preventDefault(); onInsert("**", "**", "굵게") }} title="굵게">B</button>
      <button className="tb-italic" onMouseDown={e => { e.preventDefault(); onInsert("*", "*", "기울임") }} title="기울임">I</button>
      <button className="tb-strike" onMouseDown={e => { e.preventDefault(); onInsert("~~", "~~", "취소선") }} title="취소선">S</button>
      <span className="note-toolbar-sep" />
      <button onMouseDown={e => { e.preventDefault(); onInsert("`", "`", "코드") }} title="인라인 코드">{"<>"}</button>
      <button onMouseDown={e => { e.preventDefault(); onInsert("\n```\n", "\n```", "코드") }} title="코드 블록">{"```"}</button>
      <span className="note-toolbar-sep" />
      <button onMouseDown={e => { e.preventDefault(); onPrefix("- ") }} title="목록">•</button>
      <button onMouseDown={e => { e.preventDefault(); onPrefix("1. ") }} title="번호 목록">1.</button>
      <button onMouseDown={e => { e.preventDefault(); onPrefix("> ") }} title="인용">❝</button>
      <button onMouseDown={e => { e.preventDefault(); onPrefix("- [ ] ") }} title="체크 항목">☑</button>
      <span className="note-toolbar-sep" />
      <button onMouseDown={e => { e.preventDefault(); onInsert("[", "](url)", "링크") }} title="링크">🔗</button>
      {showDivider && (
        <button onMouseDown={e => { e.preventDefault(); onPrefix("---\n") }} title="구분선">—</button>
      )}
    </div>
  )
}

function noteEditActions(
  content: string,
  setContent: (v: string) => void,
  scheduleSave: (v: string) => void,
  textareaRef: { current: HTMLTextAreaElement | null },
) {
  function insertMarkdown(before: string, after = "", placeholder = "") {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = content.slice(start, end) || placeholder
    const newValue = content.slice(0, start) + before + selected + after + content.slice(end)
    setContent(newValue)
    scheduleSave(newValue)
    setTimeout(() => {
      ta.focus()
      ta.setSelectionRange(start + before.length, start + before.length + selected.length)
    }, 0)
  }

  function insertLinePrefix(prefix: string) {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const lineStart = content.lastIndexOf("\n", start - 1) + 1
    if (content.slice(lineStart, lineStart + prefix.length) === prefix) {
      const newValue = content.slice(0, lineStart) + content.slice(lineStart + prefix.length)
      setContent(newValue)
      scheduleSave(newValue)
      setTimeout(() => { ta.focus(); ta.setSelectionRange(Math.max(lineStart, start - prefix.length), Math.max(lineStart, start - prefix.length)) }, 0)
    } else {
      const newValue = content.slice(0, lineStart) + prefix + content.slice(lineStart)
      setContent(newValue)
      scheduleSave(newValue)
      setTimeout(() => { ta.focus(); ta.setSelectionRange(start + prefix.length, start + prefix.length) }, 0)
    }
  }

  return { insertMarkdown, insertLinePrefix }
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

  const [dirChildren, setDirChildren] = useState(new Map<string, TreeNode[]>())
  const [searchQuery, setSearchQuery] = useState("")
  const [searchType, setSearchType] = useState<"name" | "content">("name")
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncTokenRef = useRef(0)
  const rootRef = useRef(root)
  const checkRootPendingRef = useRef(false)
  const isSwitchingProjectRef = useRef(false)
  const fileCacheRef = useRef(new Map<string, FileData>())
  const refreshSeqRef = useRef(-1)
  const fileLoadAbortRef = useRef<AbortController | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [treeRefreshing, setTreeRefreshing] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteContent, setNoteContent] = useState("")
  const [noteRendered, setNoteRendered] = useState("")
  const [noteEditing, setNoteEditing] = useState(true)
  const [noteSaved, setNoteSaved] = useState(true)
  const [notePos, setNotePos] = useState<{ x: number; y: number } | null>(null)
  const [noteSize, setNoteSize] = useState({ w: 400, h: 440 })
  const [projectNoteOpen, setProjectNoteOpen] = useState(false)
  const [projectNoteContent, setProjectNoteContent] = useState("")
  const [projectNoteRendered, setProjectNoteRendered] = useState("")
  const [projectNoteEditing, setProjectNoteEditing] = useState(true)
  const [projectNoteSaved, setProjectNoteSaved] = useState(true)
  const [projectNoteHeight, setProjectNoteHeight] = useState(260)
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notePathRef = useRef("")
  const projectNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noteDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const noteResizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number; mode: string } | null>(null)
  const projectNoteResizeRef = useRef<{ startY: number; origH: number } | null>(null)
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null)
  const projectNoteTextareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { rootRef.current = root }, [root])

  useEffect(() => {
    if (!root) return
    setProjectNoteContent("")
    setProjectNoteRendered("")
    setProjectNoteEditing(true)
    setProjectNoteSaved(true)
    void fetchJson<{ content: string | null }>("/api/notes/project")
      .then(async data => {
        const content = data.content ?? ""
        setProjectNoteContent(content)
        if (content) {
          const html = await renderNoteMarkdown(content)
          setProjectNoteRendered(html)
          setProjectNoteEditing(false)
        }
      })
      .catch(() => {})
  }, [root])

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

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (noteDragRef.current) {
        const dx = e.clientX - noteDragRef.current.startX
        const dy = e.clientY - noteDragRef.current.startY
        setNotePos({
          x: Math.max(0, Math.min(window.innerWidth - 280, noteDragRef.current.origX + dx)),
          y: Math.max(0, Math.min(window.innerHeight - 48, noteDragRef.current.origY + dy)),
        })
      }
      if (noteResizeRef.current) {
        const { startX, startY, origW, origH, mode } = noteResizeRef.current
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        setNoteSize({
          w: mode.includes("e") ? Math.max(280, Math.min(900, origW + dx)) : origW,
          h: mode.includes("s") ? Math.max(200, Math.min(800, origH + dy)) : origH,
        })
      }
      if (projectNoteResizeRef.current) {
        const { startY, origH } = projectNoteResizeRef.current
        setProjectNoteHeight(Math.max(120, Math.min(600, origH + (e.clientY - startY))))
      }
    }
    const onUp = () => {
      noteDragRef.current = null
      noteResizeRef.current = null
      projectNoteResizeRef.current = null
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [])

  function startNoteDrag(e: React.MouseEvent) {
    if (isMobile) return
    noteDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: notePos?.x ?? Math.max(0, window.innerWidth - 384),
      origY: notePos?.y ?? Math.max(0, window.innerHeight - 364),
    }
    e.preventDefault()
  }

  function relPath(full: string): string {
    if (!full) return ""
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "")
    const rel = norm(full).slice(norm(root).length).replace(/^\//, "")
    return rel || full
  }

  async function refreshTree() {
    if (!root || treeRefreshing) return
    setTreeRefreshing(true)
    fileCacheRef.current.clear()
    setDirChildren(new Map())
    await loadTree(root)
    setTreeRefreshing(false)
  }

  async function refreshCurrentFile() {
    if (!currentPath || fileLoading) return
    fileCacheRef.current.delete(currentPath)
    await openFile(currentPath, title)
  }

  async function loadTree(expectedRoot: string): Promise<boolean> {
    const token = ++syncTokenRef.current

    try {
      const [data, rootData] = await Promise.all([
        fetchJson<TreeNode[]>("/api/tree"),
        fetchJson<{ root: string }>("/api/root"),
      ])

      if (token !== syncTokenRef.current || (expectedRoot && rootData.root !== expectedRoot)) {
        return false
      }

      setTree(data)
      setDirChildren(new Map())
      return true
    } catch (err) {
      console.error("loadTree failed", err)
      return false
    }
  }

  async function loadDirChildren(dirPath: string) {
    try {
      const children = await fetchJson<TreeNode[]>(`/api/tree?path=${encodeURIComponent(dirPath)}`)
      setDirChildren(prev => new Map(prev).set(dirPath, children))
    } catch {
      setDirChildren(prev => new Map(prev).set(dirPath, []))
    }
  }

  function runSearch(q: string, type: "name" | "content") {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!q.trim()) { setSearchResults([]); setSearching(false); return }
    setSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const data = await fetchJson<{ results: SearchResult[] }>(
          `/api/search?q=${encodeURIComponent(q)}&type=${type}`
        )
        setSearchResults(data.results)
      } catch {}
      setSearching(false)
    }, 300)
  }

  async function loadMore(node: TreeNode) {
    const parentPath = node.parentPath!
    const offset = node.offset!
    try {
      const more = await fetchJson<TreeNode[]>(
        `/api/tree?path=${encodeURIComponent(parentPath)}&offset=${offset}`
      )
      setDirChildren(prev => {
        const current = prev.get(parentPath) ?? []
        const withoutTruncated = current.filter(n => !n.truncated)
        return new Map(prev).set(parentPath, [...withoutTruncated, ...more])
      })
    } catch {}
  }

  async function checkRoot() {
    if (checkRootPendingRef.current) return
    checkRootPendingRef.current = true
    try {
      const data = await fetchJson<{ root: string; refreshSeq?: number }>("/api/root")
      if (isSwitchingProjectRef.current) return
      const rootValue = data.root || ""
      // Invalidate file cache when server signals files changed
      if (data.refreshSeq !== undefined && data.refreshSeq !== refreshSeqRef.current) {
        if (refreshSeqRef.current !== -1) {
          fileCacheRef.current.clear()
          setDirChildren(new Map())
        }
        refreshSeqRef.current = data.refreshSeq
      }
      if (rootValue && rootValue !== rootRef.current) {
        fileCacheRef.current.clear()
        setDirChildren(new Map())
        setTree([])          // 이전 프로젝트 트리가 새 루트와 함께 보이지 않도록 먼저 비움
        setRoot(rootValue)
        setTitle("")
        setFileData(EMPTY_FILE_DATA)
        setViewMode("render")
        setOpenDirs(new Set())
        const treeOk = await loadTree(rootValue)
        if (!treeOk) {
          // 서버가 아직 초기화 중(Shiki 등)이거나 타임아웃 → 3초 후 한 번 재시도
          setTimeout(() => {
            if (rootRef.current === rootValue) loadTree(rootValue).catch(() => {})
          }, 3000)
        }
      }
    } catch (err) {
      console.error("checkRoot failed", err)
    } finally {
      checkRootPendingRef.current = false
    }
  }

  async function loadNote(filePath: string) {
    notePathRef.current = filePath
    setNoteContent("")
    setNoteRendered("")
    setNoteEditing(true)
    setNoteSaved(true)
    try {
      const data = await fetchJson<{ content: string | null }>(`/api/notes?path=${encodeURIComponent(filePath)}`)
      const content = data.content ?? ""
      setNoteContent(content)
      if (content) {
        const html = await renderNoteMarkdown(content)
        setNoteRendered(html)
        setNoteEditing(false)
      }
    } catch {}
  }

  async function openProjectNote() {
    if (projectNoteOpen) { setProjectNoteOpen(false); return }
    setProjectNoteContent("")
    setProjectNoteRendered("")
    setProjectNoteEditing(true)
    setProjectNoteSaved(true)
    setProjectNoteOpen(true)
    try {
      const data = await fetchJson<{ content: string | null }>("/api/notes/project")
      const content = data.content ?? ""
      setProjectNoteContent(content)
      if (content) {
        const html = await renderNoteMarkdown(content)
        setProjectNoteRendered(html)
        setProjectNoteEditing(false)
      }
    } catch {}
  }

  function scheduleNoteSave(value: string) {
    setNoteSaved(false)
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
    noteTimerRef.current = setTimeout(async () => {
      try {
        await fetch("/api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
          body: JSON.stringify({ path: notePathRef.current, content: value }),
        })
        setNoteSaved(true)
      } catch {}
    }, 800)
  }

  function scheduleProjectNoteSave(value: string) {
    setProjectNoteSaved(false)
    if (projectNoteTimerRef.current) clearTimeout(projectNoteTimerRef.current)
    projectNoteTimerRef.current = setTimeout(async () => {
      try {
        await fetch("/api/notes/project", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
          body: JSON.stringify({ content: value }),
        })
        setProjectNoteSaved(true)
      } catch {}
    }, 800)
  }

  async function saveAndPreview() {
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
    try {
      await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
        body: JSON.stringify({ path: notePathRef.current, content: noteContent }),
      })
      setNoteSaved(true)
    } catch {}
    if (noteContent.trim()) {
      const html = await renderNoteMarkdown(noteContent)
      setNoteRendered(html)
      setNoteEditing(false)
    } else {
      setNoteContent("")
      setNoteEditing(true)
    }
  }

  async function saveProjectNoteAndPreview() {
    if (projectNoteTimerRef.current) clearTimeout(projectNoteTimerRef.current)
    try {
      await fetch("/api/notes/project", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
        body: JSON.stringify({ content: projectNoteContent }),
      })
      setProjectNoteSaved(true)
    } catch {}
    if (projectNoteContent.trim()) {
      const html = await renderNoteMarkdown(projectNoteContent)
      setProjectNoteRendered(html)
      setProjectNoteEditing(false)
    } else {
      setProjectNoteContent("")
      setProjectNoteEditing(true)
    }
  }

  const { insertMarkdown, insertLinePrefix } = noteEditActions(noteContent, setNoteContent, scheduleNoteSave, noteTextareaRef)
  const { insertMarkdown: insertProjectMarkdown, insertLinePrefix: insertProjectLinePrefix } = noteEditActions(projectNoteContent, setProjectNoteContent, scheduleProjectNoteSave, projectNoteTextareaRef)

  async function loadProjects(forceRefresh = false) {
    setProjectsLoading(true)
    setProjectsError("")
    try {
      const url = forceRefresh ? "/api/projects?refresh=1" : "/api/projects"
      const data = await fetchJson<any>(url)
      // DB 오류여도 서버가 현재 ROOT를 projects 배열에 포함시켜 반환하므로
      // ok 여부와 무관하게 배열이 있으면 표시.
      if (Array.isArray(data.projects)) {
        setProjects(data.projects)
      }
      // DB 자체를 읽지 못했고 목록도 비어있을 때만 에러 표시
      if (!data.ok && (!Array.isArray(data.projects) || data.projects.length === 0)) {
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
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault()
        setSidebarVisible(true)
        setTimeout(() => searchInputRef.current?.focus(), 50)
      }
      if (e.key === "Escape" && document.activeElement === searchInputRef.current) {
        setSearchQuery("")
        setSearchResults([])
        searchInputRef.current?.blur()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

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
    // Cancel any in-flight file load
    fileLoadAbortRef.current?.abort()
    const abortController = new AbortController()
    fileLoadAbortRef.current = abortController

    setTitle(name)
    setCurrentPath(filePath)
    void loadNote(filePath)

    const cached = fileCacheRef.current.get(filePath)
    if (cached) {
      setFileData(cached)
      setViewMode("render")
      setFileLoading(false)
      return
    }

    setFileLoading(true)
    setFileData(EMPTY_FILE_DATA)

    try {
      const data = await fetchJson<FileData>(
        `/api/file?path=${encodeURIComponent(filePath)}`,
        {},
        abortController.signal,
      )
      if (abortController.signal.aborted) return
      fileCacheRef.current.set(filePath, data)
      setFileData(data)
      setViewMode("render")
    } catch (err: any) {
      if (abortController.signal.aborted) return
      setFileData({ type: "text", raw: String(err), rendered: "" })
      setViewMode("text")
    } finally {
      if (!abortController.signal.aborted) setFileLoading(false)
    }
  }

  function toggleDir(dirPath: string) {
    setOpenDirs(prev => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
        if (!dirChildren.has(dirPath)) void loadDirChildren(dirPath)
      }
      return next
    })
  }

  function render(nodes: TreeNode[]) {
    return nodes.map(node => {
      if (node.truncated) {
        return (
          <div key={node.path} className="tree-item">
            <button className="tree-load-more" onClick={() => void loadMore(node)}>
              {node.name}
            </button>
          </div>
        )
      }

      const isDir = node.type === "dir"
      const isOpen = openDirs.has(node.path)
      const children = dirChildren.get(node.path)
      const isLoading = isDir && isOpen && children === undefined
      const hasChildren = isDir && (children === undefined || children.length > 0)
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
                if (window.innerWidth <= 768) setSidebarVisible(false)
                openFile(node.path, node.name)
              }}
            >
              {isDir && (
                <span className="tree-chevron">
                  {isLoading ? "…" : hasChildren ? (isOpen ? "▼" : "▶") : "•"}
                </span>
              )}
              <span className="tree-icon">{isDir ? (isOpen ? "📂" : "📁") : "📄"}</span>
              <span className="tree-label">{node.name}</span>
            </div>
          </div>

          {isOpen && children !== undefined && children.length > 0 && (
            <div className="children">{render(children)}</div>
          )}
        </div>
      )
    })
  }

  const renderToggle = useMemo(() => getFileCategory(title) === "renderable", [title])

  function renderPreview() {
    if (fileLoading) {
      return (
        <div className="file-loading">
          <div className="file-loading-bar" />
          <div className="file-loading-name">{title}</div>
        </div>
      )
    }

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

    if (cat === "audio") {
      return <AudioPlayer url={fileData.url!} title={title} />
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
            <div className="project-header-row">
              <div
                className="project-name project-name-clickable"
                onClick={() => setShowProjectList(!showProjectList)}
                title="클릭하여 프로젝트 선택"
              >
                {projectName || "프로젝트 선택"}
                <span className="project-arrow">{showProjectList ? "▲" : "▼"}</span>
              </div>
              {root && (
                <>
                  <button
                    className="project-note-btn"
                    onClick={async (e) => {
                      const btn = e.currentTarget
                      btn.disabled = true
                      try {
                        const resp = await fetch("/api/open-in-explorer", { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID }, body: JSON.stringify({ path: root }) })
                        const data = await resp.json().catch(() => ({}))
                        if (!resp.ok) alert(`파일 탐색기를 열 수 없습니다: ${data.error || resp.statusText}`)
                        else if (data.uri) { const a = document.createElement("a"); a.href = data.uri; a.click() }
                      } catch {
                        alert("파일 탐색기를 열 수 없습니다.")
                      } finally {
                        btn.disabled = false
                      }
                    }}
                    title="파일 탐색기로 열기"
                  >
                    📂
                  </button>
                  <button
                    className="project-note-btn"
                    onClick={async (e) => {
                      const btn = e.currentTarget
                      btn.disabled = true
                      try {
                        const resp = await fetch("/api/open-terminal", { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID }, body: JSON.stringify({ path: root }) })
                        const data = await resp.json().catch(() => ({}))
                        if (!resp.ok) alert(`터미널을 열 수 없습니다: ${data.error || resp.statusText}`)
                        else if (data.uri) { const a = document.createElement("a"); a.href = data.uri; a.click() }
                      } catch {
                        alert("터미널을 열 수 없습니다.")
                      } finally {
                        btn.disabled = false
                      }
                    }}
                    title="터미널로 열기"
                  >
                    ⌨️
                  </button>
                  <button
                    className="project-note-btn"
                    onClick={async (e) => {
                      const btn = e.currentTarget
                      btn.disabled = true
                      try {
                        const resp = await fetch("/api/open-vscode", { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID }, body: JSON.stringify({ path: root }) })
                        const data = await resp.json().catch(() => ({}))
                        if (!resp.ok) alert(`VS Code를 열 수 없습니다: ${data.error || resp.statusText}`)
                        else if (data.uri) { const a = document.createElement("a"); a.href = data.uri; a.click() }
                      } catch {
                        alert("VS Code를 열 수 없습니다.")
                      } finally {
                        btn.disabled = false
                      }
                    }}
                    title="VS Code로 열기"
                  >
                    {'</>'}
                  </button>
                  <button
                    className={`project-note-btn${treeRefreshing ? " spinning" : ""}`}
                    onClick={() => void refreshTree()}
                    title="파일 트리 새로고침"
                    disabled={treeRefreshing}
                  >
                    ↺
                  </button>
                  <button
                    className={`project-note-btn${projectNoteOpen ? " active" : ""}`}
                    onClick={() => void openProjectNote()}
                    title="프로젝트 노트"
                  >
                    📓
                  </button>
                </>
              )}
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
                      isSwitchingProjectRef.current = true
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
                          setDirChildren(new Map())
                          fileCacheRef.current.clear()
                          await loadTree(resolvedRoot)
                        }
                      } catch (err) {
                        console.error("switch project failed", err)
                      } finally {
                        isSwitchingProjectRef.current = false
                      }
                    }}
                  >
                    <span className="project-list-color" style={{ backgroundColor: p.iconColor || "#666" }} />
                    <span className="project-list-name" title={p.worktree}>
                      {p.name || p.worktree.split(/[\\/]/).pop()}
                    </span>
                    <button
                      className="project-list-explorer-btn"
                      title={`탐색기로 열기: ${p.worktree}`}
                      onClick={async (e) => {
                        e.stopPropagation()
                        try {
                          const resp = await fetch("/api/open-in-explorer", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
                            body: JSON.stringify({ path: p.worktree }),
                          })
                          const data = await resp.json().catch(() => ({}))
                          if (!resp.ok) alert(`탐색기를 열 수 없습니다: ${data.error || resp.statusText}`)
                          else if (data.uri) { const a = document.createElement("a"); a.href = data.uri; a.click() }
                        } catch {
                          alert("탐색기를 열 수 없습니다.")
                        }
                      }}
                    >📂</button>
                  </div>
                ))}
              </div>
            )}

            <div className="project-root">{root || "프로젝트 경로 없음"}</div>
          </div>
        </div>

        {projectNoteOpen && (
          <div className="sidebar-project-note" style={{ height: projectNoteHeight }}>
            {projectNoteEditing ? (
              <>
                <NoteToolbar onInsert={insertProjectMarkdown} onPrefix={insertProjectLinePrefix} />
                <textarea
                  ref={projectNoteTextareaRef}
                  className="note-textarea"
                  placeholder="프로젝트 메모를 Markdown으로 작성하세요…"
                  value={projectNoteContent}
                  onChange={e => { setProjectNoteContent(e.target.value); scheduleProjectNoteSave(e.target.value) }}
                  onBlur={() => { void saveProjectNoteAndPreview() }}
                  autoFocus
                  spellCheck={false}
                />
              </>
            ) : (
              <div
                className="note-preview project-note-preview"
                title="더블 클릭하여 편집"
                onDoubleClick={() => setProjectNoteEditing(true)}
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(projectNoteRendered, {
                    ADD_TAGS: ["pre", "code", "span", "div", "input", "table", "thead", "tbody", "tr", "th", "td"],
                    ADD_ATTR: ["class", "id", "style", "checked", "disabled", "type", "data-line"],
                  }),
                }}
              />
            )}

          </div>
        )}

        {projectNoteOpen && (
          <div
            className="sidebar-note-search-resize"
            onMouseDown={e => { projectNoteResizeRef.current = { startY: e.clientY, origH: projectNoteHeight }; e.preventDefault() }}
          />
        )}

        <div className="search-bar" style={!projectNoteOpen ? { marginTop: '-14px' } : undefined}>
          <div className="search-input-row">
            <span className="search-icon">🔍</span>
            <input
              ref={searchInputRef}
              className="search-input"
              placeholder="검색... (Ctrl+K)"
              value={searchQuery}
              onChange={e => {
                const q = e.target.value
                setSearchQuery(q)
                runSearch(q, searchType)
              }}
            />
            {searchQuery && (
              <button className="search-clear" onClick={() => { setSearchQuery(""); setSearchResults([]) }}>×</button>
            )}
          </div>
          {searchQuery && (
            <div className="search-type-row">
              <button className={`search-type-btn${searchType === "name" ? " active" : ""}`} onClick={() => { setSearchType("name"); runSearch(searchQuery, "name") }}>파일명</button>
              <button className={`search-type-btn${searchType === "content" ? " active" : ""}`} onClick={() => { setSearchType("content"); runSearch(searchQuery, "content") }}>내용</button>
            </div>
          )}
        </div>

        {searchQuery ? (
          <div className="sidebar-scrollable-tree">
            {searching && <div className="search-status">검색 중…</div>}
            {!searching && searchResults.length === 0 && <div className="search-status">결과 없음</div>}
            {searchResults.map(r => (
              <div key={r.path} className="search-result" onClick={() => { openFile(r.path, r.name); if (isMobile) setSidebarVisible(false) }}>
                <div className="search-result-name">
                  <span className="tree-icon">📄</span>
                  <span className="search-result-filename">{r.name}</span>
                </div>
                <div className="search-result-dir">{r.dir}</div>
                {r.matches?.map((m, i) => (
                  <div key={i} className="search-match">
                    <span className="search-match-line">{m.line}</span>
                    <span className="search-match-text">{m.text}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="sidebar-scrollable-tree">{render(tree)}</div>
        )}

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
          <div className="titlebar-actions">
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
            {currentPath && (
              <button
                className={`toolbar-btn${fileLoading ? " spinning" : ""}`}
                onClick={() => void refreshCurrentFile()}
                title="현재 파일 새로고침"
                disabled={fileLoading}
              >
                ↺
              </button>
            )}
            {currentPath && (
              <button
                className={`note-btn${noteContent ? " has-note" : ""}`}
                onClick={() => {
                  if (noteOpen) { setNoteOpen(false); return }
                  if (!notePos) setNotePos({ x: Math.max(0, window.innerWidth - 384), y: Math.max(0, window.innerHeight - 364) })
                  void loadNote(currentPath)
                  setNoteOpen(true)
                }}
                title="파일 노트 (Markdown)"
              >
                📝
              </button>
            )}
          </div>
        </div>
        <div className="preview">{renderPreview()}</div>
      </div>

      {noteOpen && currentPath && (
        <>
          {isMobile && <div className="note-backdrop" onClick={() => setNoteOpen(false)} />}
          <div
            className="note-panel"
            style={!isMobile ? {
              ...(notePos ? { left: notePos.x, top: notePos.y, bottom: "auto", right: "auto" } : {}),
              width: noteSize.w,
              height: noteSize.h,
            } : undefined}
          >
            <div
              className={`note-panel-header${!isMobile ? " draggable" : ""}`}
              onMouseDown={startNoteDrag}
            >
              <span className="note-panel-title">📝 {title}</span>
              <div className="note-panel-meta">
                {noteEditing && !noteSaved && <span className="note-status saving">저장 중…</span>}
                {noteEditing && noteSaved && noteContent && <span className="note-status saved">✓</span>}
                {!noteEditing && <button className="note-mode-btn" onClick={() => setNoteEditing(true)}>편집</button>}
                <button className="note-close-btn" onClick={() => setNoteOpen(false)}>×</button>
              </div>
            </div>

            {noteEditing ? (
              <>
                <NoteToolbar onInsert={insertMarkdown} onPrefix={insertLinePrefix} showDivider />
                <textarea
                  ref={noteTextareaRef}
                  className="note-textarea"
                  placeholder="이 파일에 대한 메모를 Markdown으로 작성하세요…"
                  value={noteContent}
                  onChange={e => {
                    setNoteContent(e.target.value)
                    scheduleNoteSave(e.target.value)
                  }}
                  autoFocus
                  spellCheck={false}
                />
              </>
            ) : (
              <div
                className="note-preview"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(noteRendered, {
                    ADD_TAGS: ["pre", "code", "span", "div", "input", "table", "thead", "tbody", "tr", "th", "td"],
                    ADD_ATTR: ["class", "id", "style", "checked", "disabled", "type", "data-line"],
                  }),
                }}
              />
            )}

            <div className="note-panel-footer">
              <span className="note-path">{`.notes/${relPath(currentPath)}.md`}</span>
              <div className="note-footer-actions">
                {noteContent && (
                  <button
                    className="note-delete-btn"
                    onClick={async () => {
                      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
                      await fetch(`/api/notes?path=${encodeURIComponent(currentPath)}`, { method: "DELETE", headers: { "X-Session-Id": SESSION_ID } })
                      setNoteContent("")
                      setNoteRendered("")
                      setNoteEditing(true)
                      setNoteSaved(true)
                    }}
                  >
                    삭제
                  </button>
                )}
                {noteEditing && (
                  <button className="note-save-btn" onClick={saveAndPreview}>
                    저장
                  </button>
                )}
              </div>
            </div>

            {!isMobile && (<>
              <div className="note-resize-e" onMouseDown={e => { noteResizeRef.current = { startX: e.clientX, startY: e.clientY, origW: noteSize.w, origH: noteSize.h, mode: "e" }; e.preventDefault() }} />
              <div className="note-resize-s" onMouseDown={e => { noteResizeRef.current = { startX: e.clientX, startY: e.clientY, origW: noteSize.w, origH: noteSize.h, mode: "s" }; e.preventDefault() }} />
              <div className="note-resize-se" onMouseDown={e => { noteResizeRef.current = { startX: e.clientX, startY: e.clientY, origW: noteSize.w, origH: noteSize.h, mode: "se" }; e.preventDefault() }} />
            </>)}
          </div>
        </>
      )}
    </div>
  )
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
