export interface Symbol {
  name: string;
  line: number;
}

export function extractCppSymbols(code: string): Symbol[] {
  const symbols: Symbol[] = [];
  // Very simple regex for C++ function definitions:
  // Matches "functionName(" at start of a line or after a return type
  // This is a naive implementation and might need refinement.
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\((?:[^)(]|\([^)(]*\))*\)\s*\{/g;
  
  let match;
  const lines = code.split('\n');
  
  while ((match = regex.exec(code)) !== null) {
    const functionName = match[1];
    // Calculate line number
    const line = code.substring(0, match.index).split('\n').length;
    
    // Simple filter to skip common keywords
    const keywords = ['if', 'for', 'while', 'switch', 'return', 'catch'];
    if (!keywords.includes(functionName)) {
      symbols.push({ name: functionName, line });
    }
  }
  
  return symbols;
}
