import express from "express";
import cors from "cors";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { extractCppSymbols } from "./symbolExtractor.js";
import { WebSocketServer } from 'ws';
import { deflateRawSync } from "zlib";
import { execSync } from "child_process";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import { createHighlighter } from "shiki";
// @ts-ignore
import { DatabaseSync } from "node:sqlite";
const OPENCODE_DB_CANDIDATES = [
    process.env.OPENCODE_DB_PATH,
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
    path.join(os.homedir(), "AppData", "Local", "opencode", "opencode.db"),
].filter(Boolean);
function findOpencodeDbPath() {
    for (const p of OPENCODE_DB_CANDIDATES) {
        try {
            fs.accessSync(p, fs.constants.R_OK);
            return p;
        }
        catch { }
    }
    return null;
}
function listOpencodeProjects() {
    if (!DatabaseSync) {
        return {
            ok: false,
            error: "node:sqlite unavailable",
            projects: [],
        };
    }
    const dbPath = findOpencodeDbPath();
    if (!dbPath) {
        return {
            ok: false,
            error: "opencode.db not found",
            projects: [],
        };
    }
    let db = null;
    try {
        // @ts-ignore
        db =
            new DatabaseSync(dbPath, { readOnly: true });
        const rows = db.prepare("SELECT id, worktree, vcs, name, icon_color, time_updated, time_created FROM project ORDER BY time_updated DESC").all();
        const projects = rows
            .filter(r => typeof r.worktree === "string" &&
            r.worktree.trim().length > 0)
            .map(r => ({
            id: r.id,
            worktree: r.worktree,
            name: r.name ||
                path.basename(r.worktree),
            vcs: r.vcs || null,
            iconColor: r.icon_color || null,
            timeUpdated: Number(r.time_updated) || 0,
            timeCreated: Number(r.time_created) || 0,
        }));
        return {
            ok: true,
            dbPath,
            projects,
        };
    }
    catch (err) {
        return {
            ok: false,
            error: String(err?.message || err),
            projects: [],
        };
    }
    finally {
        if (db) {
            try {
                db.close();
            }
            catch { }
        }
    }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "../../apps/client/dist");
const INDEX_HTML = path.join(DIST_DIR, "index.html");
const PLANTUML_SERVER_URL = (process.env.PLANTUML_SERVER_URL ||
    "https://www.plantuml.com/plantuml").replace(/\/$/, "");
const PLANTUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
export const app = express();
app.use(cors());
app.use(express.json());
let parentWatchTimer = null;
let httpServer = null;
let wss = null;
let shuttingDown = false;
// Server cleanup
function shutdownServer(reason, details) {
    if (shuttingDown) {
        return;
    }
    shuttingDown =
        true;
    console.log("[viewer] shutdown:", reason, details || "");
    for (const client of wss.clients) {
        try {
            client.send(JSON.stringify({ type: "closing" }));
            client.close();
        }
        catch (err) {
            console.error("[viewer:ws client close failed]", err);
        }
    }
    try {
        if (parentWatchTimer) {
            clearInterval(parentWatchTimer);
            parentWatchTimer =
                null;
        }
    }
    catch (err) {
        console.error("[viewer:parent watch cleanup failed]", err);
    }
    const forceTimer = setTimeout(() => {
        process.exit(0);
    }, 1500);
    forceTimer.unref?.();
    try {
        if (httpServer) {
            httpServer.close(() => {
                process.exit(0);
            });
            return;
        }
    }
    catch (err) {
        console.error("[viewer:http server close failed]", err);
    }
    process.exit(0);
}
const PORT = Number(process.env.PORT) || 4310;
const PARENT_PID = Number(process.env.PARENT_PID) || 0;
let ROOT = process.env.PROJECT_ROOT ||
    process.cwd();
let lastRefreshAt = Date.now();
function broadcastWsEvent(payload) {
    if (!wss)
        return;
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    }
}
function publishRefresh(source) {
    lastRefreshAt =
        Date.now();
    broadcastWsEvent({
        type: source,
        root: ROOT,
        refreshAt: lastRefreshAt,
    });
}
function publishProjectChanged() {
    publishRefresh("project.changed");
}
function publishTreeChanged() {
    publishRefresh("tree.changed");
}
const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(code, lang) {
        if (lang &&
            hljs.getLanguage(lang)) {
            try {
                return hljs.highlight(code, {
                    language: lang,
                }).value;
            }
            catch { }
        }
        return hljs
            .highlightAuto(code)
            .value;
    },
});
let highlighter = null;
async function ensureHighlighter() {
    if (highlighter) {
        return highlighter;
    }
    try {
        highlighter =
            await createHighlighter({
                themes: [
                    "monokai",
                    "dracula",
                    "vitesse-dark",
                ],
                langs: [
                    // Native/System
                    "c", "cpp", "csharp", "objective-c", "objective-cpp",
                    // Scripting
                    "python", "ruby", "php", "perl", "lua", "r",
                    // JavaScript ecosystem
                    "javascript", "typescript", "jsx", "tsx",
                    // JVM
                    "java", "kotlin", "scala", "groovy",
                    // Modern systems
                    "rust", "go", "swift", "dart",
                    // Functional
                    "haskell", "elixir", "erlang", "fsharp", "clojure",
                    // Data formats
                    "json", "jsonc", "yaml", "toml", "xml", "csv",
                    // Web
                    "html", "css", "scss", "sass", "less",
                    // Shell
                    "bash", "shellscript", "powershell", "bat",
                    // Database
                    "sql", "graphql",
                    // Config/Build
                    "ini", "dockerfile", "docker", "makefile", "cmake",
                    // VCS
                    "diff", "git-commit", "git-rebase",
                    // Documentation
                    "markdown", "latex",
                    // Fallback
                    "plaintext",
                ],
            });
    }
    catch (err) {
        console.error("[viewer:highlighter init failed]", err);
        highlighter = null;
    }
    return highlighter;
}
function safeResolve(file) {
    if (!file)
        throw new Error("Path required");
    const resolved = path.resolve(ROOT, file);
    // Check if the path is actually inside ROOT
    // Note: On Windows, drive letters might be case-insensitive, so we normalize.
    const normalizedRoot = path.normalize(ROOT).toLowerCase();
    const normalizedResolved = path.normalize(resolved).toLowerCase();
    if (!normalizedResolved.startsWith(normalizedRoot)) {
        throw new Error("Access denied: Path traversal detected");
    }
    // Ensure file exists and is within ROOT
    if (!fs.existsSync(resolved)) {
        throw new Error("File not found");
    }
    return resolved;
}
function walk(dir) {
    const result = [];
    let entries = [];
    try {
        entries =
            fs.readdirSync(dir);
    }
    catch (err) {
        if (err?.code === "EPERM" ||
            err?.code === "EACCES") {
            return result;
        }
        throw err;
    }
    for (const file of entries) {
        if ([
            ".git",
            "node_modules",
            "dist",
            ".next",
            ".turbo",
            ".cache",
            ".pytest_cache",
        ].includes(file)) {
            continue;
        }
        const full = path.join(dir, file);
        let stat;
        try {
            stat =
                fs.statSync(full);
        }
        catch (err) {
            if (err?.code === "EPERM" ||
                err?.code === "EACCES" ||
                err?.code === "ENOENT") {
                continue;
            }
            throw err;
        }
        if (stat.isDirectory()) {
            result.push({
                type: "dir",
                name: file,
                path: full,
                children: walk(full),
            });
        }
        else {
            result.push({
                type: "file",
                name: file,
                path: full,
            });
        }
    }
    result.sort((a, b) => {
        if (a.type === "dir" &&
            b.type !== "dir") {
            return -1;
        }
        if (a.type !== "dir" &&
            b.type === "dir") {
            return 1;
        }
        return a.name.localeCompare(b.name);
    });
    return result;
}
app.get("/api/ping", (_, res) => {
    res.json({
        ok: true,
    });
});
app.get("/api/root", (_, res) => {
    res.json({
        root: ROOT,
    });
});
app.get("/api/projects", (_, res) => {
    const result = listOpencodeProjects();
    res.json({
        ok: result.ok,
        error: result.error || null,
        dbPath: result.dbPath || null,
        currentRoot: ROOT,
        projects: result.projects,
    });
});
app.get("/api/events", (req, res) => {
    res.status(404).send("SSE endpoint removed. Use WebSocket.");
});
app.post("/api/open-project", (req, res) => {
    if (typeof req.body?.path !== "string" ||
        !req.body.path.trim()) {
        return res
            .status(400)
            .json({
            error: "path is required",
        });
    }
    ROOT =
        path.resolve(req.body.path);
    publishProjectChanged();
    console.log("[viewer] root:", ROOT);
    res.json({
        ok: true,
        root: ROOT,
        refreshAt: lastRefreshAt,
    });
});
app.post("/api/refresh", (_, res) => {
    publishTreeChanged();
    res.json({
        ok: true,
        refreshAt: lastRefreshAt,
    });
});
app.get("/api/refresh", (_, res) => {
    res.json({
        refreshAt: lastRefreshAt,
    });
});
app.get("/api/tree", (_, res) => {
    res.json(walk(ROOT));
});
app.get("/api/file", async (req, res) => {
    try {
        const file = safeResolve(req.query.path);
        const ext = path
            .extname(file)
            .toLowerCase();
        // @ts-ignore
        if (ext === ".pdf") {
            return res.json({
                type: "pdf",
                raw: "",
                rendered: "",
                url: `/api/raw?path=${encodeURIComponent(req.query.path)}`,
            });
        }
        const raw = fs.readFileSync(file, "utf8");
        if (ext === ".md") {
            return res.json({
                type: "markdown",
                raw,
                rendered: md.render(raw),
            });
        }
        // @ts-ignore
        if (ext === ".html") {
            return res.json({
                type: "html",
                raw,
                rendered: raw,
                url: `/api/raw?path=${encodeURIComponent(req.query.path)}`,
            });
        }
        if (ext === ".puml") {
            return res.json({
                type: "plantuml",
                raw,
                rendered: "",
                url: `${PLANTUML_SERVER_URL}/svg/${encodePlantUml(raw)}`,
            });
        }
        if (ext === ".mmd") {
            return res.json({
                type: "mermaid",
                raw,
                rendered: `
<pre class="language-mermaid">
${escapeHtml(raw)}
</pre>
`,
            });
        }
        const IMAGE_EXTENSIONS = [
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".bmp",
            ".webp",
            ".ico",
            ".svg",
        ];
        // @ts-ignore
        if (IMAGE_EXTENSIONS.includes(ext)) {
            return res.json({
                type: "image",
                raw,
                url: `/api/raw?path=${encodeURIComponent(req.query.path)}`,
            });
        }
        const langMap = {
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
            ".html": "html",
            ".css": "css",
            ".sh": "bash",
            ".sql": "sql",
            ".rs": "rust",
            ".go": "go",
            ".java": "java",
            ".swift": "swift",
            ".kt": "kotlin",
            ".txt": "plaintext",
        };
        const lang = langMap[ext];
        console.log(`[viewer] file: ${file}, ext: ${ext}, lang: ${lang}`);
        if (lang) {
            const activeHighlighter = await ensureHighlighter();
            if (activeHighlighter) {
                const rendered = activeHighlighter
                    .codeToHtml(raw, {
                    lang,
                    theme: "vitesse-dark",
                    lineNumbers: true,
                });
                let symbols = [];
                if (lang === 'cpp') {
                    symbols = extractCppSymbols(raw);
                }
                return res.json({
                    type: "code",
                    raw,
                    rendered,
                    symbols
                });
            }
            return res.json({
                type: "code",
                raw,
                rendered: `<pre><code>${md.utils.escapeHtml(raw)}</code></pre>`,
            });
        }
        return res.json({
            type: "text",
            raw,
            rendered: `
<pre>${escapeHtml(raw)}</pre>
`,
        });
    }
    catch (err) {
        res
            .status(403)
            .json({
            error: err.message,
        });
    }
});
app.get("/api/raw", (req, res) => {
    try {
        const file = safeResolve(req.query.path);
        if (!fs.existsSync(file)) {
            return res
                .status(404)
                .json({
                error: "not found",
            });
        }
        return res.sendFile(file);
    }
    catch (err) {
        return res
            .status(403)
            .json({
            error: err.message,
        });
    }
});
function encodePlantUml6Bit(value) {
    return PLANTUML_ALPHABET[value & 0x3f];
}
function appendPlantUmlEncodedBytes(b1, b2, b3) {
    const c1 = b1 >> 2;
    const c2 = ((b1 & 0x3) << 4) |
        (b2 >> 4);
    const c3 = ((b2 & 0xf) << 2) |
        (b3 >> 6);
    const c4 = b3 & 0x3f;
    return (encodePlantUml6Bit(c1) +
        encodePlantUml6Bit(c2) +
        encodePlantUml6Bit(c3) +
        encodePlantUml6Bit(c4));
}
function encodePlantUml(text) {
    const source = /@start\w+/i.test(text)
        ? text
        : `@startuml\n${text}\n@enduml`;
    const compressed = deflateRawSync(Buffer.from(source, "utf8"));
    let encoded = "";
    for (let i = 0; i < compressed.length; i += 3) {
        encoded +=
            appendPlantUmlEncodedBytes(compressed[i], compressed[i + 1] || 0, compressed[i + 2] || 0);
    }
    return encoded;
}
function escapeHtml(text) {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
app.use(express.static(DIST_DIR));
app.get("*", (_, res) => {
    res.sendFile(INDEX_HTML);
});
process.on("SIGINT", () => {
    shutdownServer("SIGINT", null);
});
process.on("SIGTERM", () => {
    shutdownServer("SIGTERM", null);
});
if (process.platform ===
    "win32") {
    process.on("SIGBREAK", () => {
        shutdownServer("SIGBREAK", null);
    });
}
process.on("uncaughtException", err => {
    console.error("[viewer:uncaughtException]", err);
    shutdownServer("uncaughtException", err?.message);
});
process.on("unhandledRejection", reason => {
    console.error("[viewer:unhandledRejection]", reason);
    shutdownServer("unhandledRejection", String(reason));
});
if (PARENT_PID > 0) {
    parentWatchTimer =
        setInterval(() => {
            try {
                process.kill(PARENT_PID, 0);
            }
            catch (err) {
                if (err?.code === "ESRCH") {
                    clearInterval(parentWatchTimer);
                    parentWatchTimer = null;
                    return;
                }
            }
        }, 1000);
    parentWatchTimer.unref?.();
}
function killProcessOnPort(port, host = "0.0.0.0") {
    try {
        if (process.platform === "win32") {
            const { execSync } = require("child_process");
            try {
                const output = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
                const lines = output.split("\n");
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.includes("LISTENING"))
                        continue;
                    const parts = trimmed.split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && /^\d+$/.test(pid)) {
                        console.log("[viewer:kill existing]", { port, pid });
                        try {
                            execSync(`taskkill /pid ${pid} /f /t`, { stdio: "ignore" });
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }
        else {
            try {
                execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
            }
            catch { }
        }
    }
    catch { }
}
function startServer(retry = true) {
    httpServer = app.listen(PORT, "0.0.0.0", () => {
        // @ts-ignore
        wss = new WebSocketServer({
            server: httpServer,
            verifyClient: (info, cb) => {
                const origin = info.origin;
                if (!origin || (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`)) {
                    return cb(false, 403, 'Forbidden');
                }
                cb(true);
            }
        });
        // @ts-ignore
        wss.on('connection', (ws) => {
            ws.isAlive = true;
            // @ts-ignore
            ws.on('pong', () => { ws.isAlive = true; });
            ws.send(JSON.stringify({
                type: "connected",
                root: ROOT,
                refreshAt: lastRefreshAt,
            }));
        });
        // @ts-ignore
        const interval = setInterval(() => {
            wss.clients.forEach((ws) => {
                if (ws.isAlive === false)
                    return ws.terminate();
                ws.isAlive = false;
                // @ts-ignore
                ws.ping();
            });
        }, 30000);
        // @ts-ignore
        wss.on('close', () => {
            clearInterval(interval);
        });
        console.log(`[viewer] running at http://0.0.0.0:${PORT} (also http://127.0.0.1:${PORT})`);
        if (PARENT_PID > 0) {
            console.log("[viewer] parent pid:", PARENT_PID);
        }
    });
    httpServer.on("error", err => {
        console.error("[viewer:listen error]", err);
        if (retry && err?.code === "EADDRINUSE") {
            console.log("[viewer:retry after kill]", { port: PORT });
            killProcessOnPort(PORT);
            setTimeout(() => {
                startServer(false);
            }, 1000);
            return;
        }
        shutdownServer("listen error", err?.message);
    });
}
killProcessOnPort(PORT);
startServer();
