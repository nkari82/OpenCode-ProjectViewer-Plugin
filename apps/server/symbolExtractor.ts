export interface Symbol {
  name: string;
  line: number;
}

export function extractSymbols(code: string, lang: string): Symbol[] {
  const symbols: Symbol[] = [];
  
  // 언어별 함수/클래스 패턴 정의
  const patterns: Record<string, RegExp> = {
    c: /\b([A-Za-z_][A-Za-z0-9_]*)\s*\((?:[^)(]|\([^)(]*\))*\)\s*\{/g,
    cpp: /\b([A-Za-z_][A-Za-z0-9_]*)\s*\((?:[^)(]|\([^)(]*\))*\)\s*\{/g,
    "objective-c": /[-+]\s*\([^)]+\)\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    typescript: /(?:function|class|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    tsx: /(?:function|class|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    javascript: /(?:function|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    jsx: /(?:function|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    python: /(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    rust: /(?:fn|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    go: /(?:func|type|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    java: /(?:class|interface|void|int|String|boolean)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    kotlin: /(?:fun|class|object|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    scala: /(?:def|class|object|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    csharp: /(?:class|void|int|string|bool)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    swift: /(?:func|class|struct|enum|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    markdown: /^(#{1,6})\s+(.*)/gm,
  };

  const regex = patterns[lang];
  if (!regex) return [];
  
  let match;
  while ((match = regex.exec(code)) !== null) {
    const name = match[1];
    const line = code.substring(0, match.index).split('\n').length;
    
    // 키워드 필터링
    const keywords = ['if', 'for', 'while', 'switch', 'return', 'catch', 'function', 'class', 'interface', 'type', 'def', 'fn', 'struct', 'enum', 'func', 'void', 'int', 'String', 'bool', 'string'];
    
    // Markdown은 정규식 그룹이 다름 (#과 제목)
    if (lang === 'markdown') {
        symbols.push({ name: match[2].trim(), line });
        continue;
    }

    if (!keywords.includes(name)) {
      symbols.push({ name, line });
    }
  }
  
  return symbols;
}
