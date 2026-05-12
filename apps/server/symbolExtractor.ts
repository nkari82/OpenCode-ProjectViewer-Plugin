export interface Symbol {
  name: string
  line: number
}

const KEYWORDS = new Set([
  "if","else","for","while","do","switch","case","default","break","continue","return",
  "try","catch","finally","throw","new","delete","typeof","instanceof","in","of",
  "import","export","from","as","await","yield","async","static","abstract","final",
  "public","private","protected","override","virtual","inline","extern",
  "const","let","var","class","interface","extends","implements","super","this","void",
  "int","long","short","float","double","boolean","char","byte","string","bool","String","object",
  "struct","enum","type","impl","trait","fn","fun","def","func","function",
  "get","set","namespace","using","package","module","require","describe","it","test","expect",
])

export function extractSymbols(code: string, lang: string): Symbol[] {
  if (lang === "markdown") return extractMarkdown(code)
  if (lang === "python")   return extractPython(code)
  if (lang === "go")       return extractGo(code)
  if (lang === "c")        return extractC(code)
  const cfg = LANG_CONFIGS[lang]
  return cfg ? extractBraced(code, cfg) : []
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function extractMarkdown(code: string): Symbol[] {
  return [...code.matchAll(/^#{1,6}\s+(.*)/gm)].map(m => ({
    name: m[1].trim(),
    line: code.substring(0, m.index!).split("\n").length,
  }))
}

// ── Python (indentation-based class tracking) ────────────────────────────────

function extractPython(code: string): Symbol[] {
  const symbols: Symbol[] = []
  const lines = code.split("\n")
  const classStack: { name: string; indent: number }[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0
    while (classStack.length > 0 && indent <= classStack.at(-1)!.indent) classStack.pop()

    const classM = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (classM) {
      classStack.push({ name: classM[2], indent })
      symbols.push({ name: classM[2], line: i + 1 })
      continue
    }
    const defM = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (defM) {
      const cls = classStack.at(-1)
      symbols.push({ name: cls ? `${cls.name}::${defM[1]}` : defM[1], line: i + 1 })
    }
  }
  return symbols
}

// ── Go (explicit receiver syntax) ────────────────────────────────────────────

function extractGo(code: string): Symbol[] {
  const symbols: Symbol[] = []
  // type declarations
  for (const m of code.matchAll(/\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/g))
    symbols.push({ name: m[1], line: code.substring(0, m.index!).split("\n").length })
  // methods with receiver: func (r *TypeName) Method(
  for (const m of code.matchAll(/\bfunc\s+\(\s*\w+\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+([A-Za-z_][A-Za-z0-9_]*)/g))
    symbols.push({ name: `${m[1]}::${m[2]}`, line: code.substring(0, m.index!).split("\n").length })
  // standalone functions
  for (const m of code.matchAll(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/g))
    symbols.push({ name: m[1], line: code.substring(0, m.index!).split("\n").length })
  return symbols.sort((a, b) => a.line - b.line)
}

// ── C (no classes) ───────────────────────────────────────────────────────────

function extractC(code: string): Symbol[] {
  const symbols: Symbol[] = []
  for (const m of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\((?:[^)(]|\([^)(]*\))*\)\s*\{/g))
    if (!KEYWORDS.has(m[1])) symbols.push({ name: m[1], line: code.substring(0, m.index!).split("\n").length })
  return symbols
}

// ── Brace-based languages ─────────────────────────────────────────────────────

type LangConfig = { classRe: RegExp; memberRe: RegExp }

const LANG_CONFIGS: Record<string, LangConfig> = {
  // identifier optionally followed by generic params then (
  typescript: { classRe: /\b(?:class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/, memberRe: /\b([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^>]*>)?\s*\(/ },
  tsx:        { classRe: /\b(?:class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/, memberRe: /\b([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^>]*>)?\s*\(/ },
  javascript: { classRe: /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/,               memberRe: /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/ },
  jsx:        { classRe: /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/,               memberRe: /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/ },
  java:       { classRe: /\b(?:class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/, memberRe: /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  kotlin:     { classRe: /\b(?:class|interface|object)\s+([A-Za-z_][A-Za-z0-9_]*)/, memberRe: /\bfun\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  scala:      { classRe: /\b(?:class|object|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/, memberRe: /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  csharp:     { classRe: /\b(?:class|interface|struct|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/, memberRe: /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  swift:      { classRe: /\b(?:class|struct|enum|protocol|extension)\s+([A-Za-z_][A-Za-z0-9_]*)/, memberRe: /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  // C++: support out-of-class definitions (Foo::method)
  cpp:        { classRe: /\b(?:class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/, memberRe: /\b([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*\(/ },
  rust:       { classRe: /\b(?:struct|enum|impl|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/, memberRe: /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
}

function extractBraced(code: string, cfg: LangConfig): Symbol[] {
  const symbols: Symbol[] = []
  const lines = code.split("\n")
  let depth = 0
  // Each entry: class name + the brace depth that represents its body interior
  const classStack: { name: string; bodyDepth: number }[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Class / type declaration
    cfg.classRe.lastIndex = 0
    const classM = cfg.classRe.exec(line)
    if (classM) {
      // Body of this class starts at depth+1 (after its opening brace).
      // If { is on same line, depth will reach bodyDepth after counting it below.
      // If { is on next line, depth will reach bodyDepth when that line is counted.
      classStack.push({ name: classM[1], bodyDepth: depth + 1 })
      symbols.push({ name: classM[1], line: lineNum })
    }

    // Member / function declaration
    cfg.memberRe.lastIndex = 0
    const memberM = cfg.memberRe.exec(line)
    if (memberM) {
      const name = memberM[1]
      const cls = classStack.at(-1)
      // Only emit members that are directly inside a class body (depth === bodyDepth)
      // or top-level functions (depth === 0, no class).
      // This prevents method *calls* inside method bodies from appearing.
      const atClassBody = cls !== undefined && depth === cls.bodyDepth
      const atTopLevel = cls === undefined && depth === 0
      if (!KEYWORDS.has(name) && name !== classM?.[1] && (atClassBody || atTopLevel)) {
        symbols.push({ name: cls ? `${cls.name}::${name}` : name, line: lineNum })
      }
    }

    // Update brace depth and pop classes whose scope has closed
    for (const ch of line) {
      if (ch === "{") {
        depth++
      } else if (ch === "}") {
        depth--
        while (classStack.length > 0 && classStack.at(-1)!.bodyDepth > depth) {
          classStack.pop()
        }
      }
    }
  }

  return symbols
}
