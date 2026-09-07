interface Token {
  text: string;
  start: number;
  end: number;
  value?: string;
}

export interface PathChange {
  before: string;
  after: string;
}

export function movePath(path: string, oldPath: string, newPath: string): string {
  return path === oldPath || path.startsWith(`${oldPath}/`)
    ? newPath + path.slice(oldPath.length)
    : path;
}

// Tokenize strings as indivisible values, so example text cannot become code.
function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  const pattern = /\s+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\p{L}\p{N}_$]+|==|!=|&&|\|\||[^\s]/gu;
  for (const match of expression.matchAll(pattern)) {
    const text = match[0];
    if (/^\s+$/.test(text)) continue;
    // Regular expressions and comments require a full grammar. Skip conservatively.
    if (text === '/' || text === '"' || text === "'") return null;
    const token: Token = { text, start: match.index, end: match.index + text.length };
    if (text.startsWith('"') || text.startsWith("'")) {
      try {
        // Bases strings follow JavaScript escape conventions. Reject unknown escapes.
        token.value = decodeString(text);
      } catch {
        return null;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

function decodeString(text: string): string {
  const escapes: Record<string, string> = {
    n: '\n',
    r: '\r',
    t: '\t',
    b: '\b',
    f: '\f',
    v: '\v',
    '\\': '\\',
    '"': '"',
    "'": "'",
    '/': '/',
  };
  return text.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/g, (_, escape: string) => {
    if (/^[ux]/.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (!(escape in escapes)) throw new Error('Unsupported string escape');
    return escapes[escape]!;
  });
}

function encodeString(value: string, quote: string): string {
  if (quote === '"') return JSON.stringify(value);
  return "'" + JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
}

export function updateExpression(expression: string, oldPath: string, newPath: string) {
  const tokens = tokenize(expression);
  const edits: { token: Token; replacement: string }[] = [];
  const changes: PathChange[] = [];
  if (!tokens || !oldPath || oldPath === newPath) return { text: expression, changes };
  const at = (index: number) => tokens[index]?.text;
  const matches = (index: number, sequence: string[]) =>
    sequence.every((text, offset) => at(index + offset) === text);
  const leftBoundary = (index: number) =>
    index === 0 || ['(', '!', '&&', '||', ',', '?', ':'].includes(at(index - 1) ?? '');
  const rightBoundary = (index: number) =>
    index === tokens.length || [')', '&&', '||', ',', '?', ':'].includes(at(index) ?? '');

  const replace = (index: number) => {
    const token = tokens[index];
    if (token?.value === undefined) return;
    const moved = movePath(token.value, oldPath, newPath);
    if (moved === token.value) return;
    edits.push({ token, replacement: encodeString(moved, token.text[0]!) });
    changes.push({ before: token.value, after: moved });
  };

  for (let i = 0; i < tokens.length; i++) {
    if (!leftBoundary(i)) continue;
    if (matches(i, ['file', '.', 'inFolder', '(']) && at(i + 5) === ')') {
      replace(i + 4);
    } else if (matches(i, ['file', '.', 'path', '.', 'startsWith', '(']) && at(i + 7) === ')') {
      replace(i + 6);
    } else if (matches(i, ['file', '.', 'path', '==']) && rightBoundary(i + 5)) {
      replace(i + 4);
    } else if (
      tokens[i]?.value !== undefined &&
      matches(i + 1, ['==', 'file', '.', 'path']) &&
      rightBoundary(i + 5)
    ) {
      replace(i);
    }
  }
  let text = expression;
  for (const { token, replacement } of edits.sort((a, b) => b.token.start - a.token.start)) {
    text = text.slice(0, token.start) + replacement + text.slice(token.end);
  }
  return { text, changes };
}
