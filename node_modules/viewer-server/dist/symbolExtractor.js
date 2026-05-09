export function extractSymbols(code, lang) {
    const symbols = [];
    // 언어별 함수/클래스 패턴 정의
    const patterns = {
        cpp: /\b([A-Za-z_][A-Za-z0-9_]*)\s*\((?:[^)(]|\([^)(]*\))*\)\s*\{/g,
        typescript: /(?:function|class|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        javascript: /(?:function|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        python: /(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        rust: /(?:fn|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        go: /(?:func|type|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        java: /(?:class|interface|void|int|String|boolean)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
        csharp: /(?:class|void|int|string|bool)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
        markdown: /^(#{1,6})\s+(.*)/gm,
    };
    const regex = patterns[lang];
    if (!regex)
        return [];
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
