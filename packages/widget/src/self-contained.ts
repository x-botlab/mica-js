/**
 * Lexical scan behind the self-contained check.
 *
 * A widget implementation ships as a single file, so any `import` or `export ... from` would need
 * a module resolver at run time. Matching those keywords with a regular expression over the raw
 * text cannot tell code from comments, strings, templates or regex literals — and it depends on
 * whitespace that minifiers drop. This scanner tokenizes the source once and decides on tokens.
 */

type TokenType = 'ident' | 'punct' | 'value';

interface Token {
  readonly type: TokenType;
  readonly value: string;
}

interface ScanState {
  readonly source: string;
  index: number;
  readonly tokens: Token[];
  previous: Token | undefined;
}

/** Punctuators after which `/` opens a regex literal instead of dividing. */
const REGEX_PRECEDING_PUNCTUATORS = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '=',
  '!',
  '?',
  '&',
  '|',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '^',
  '~',
  '/',
]);

/** Keywords after which `/` opens a regex literal instead of dividing. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const REGEX_FLAGS = 'gimsuydv';

/**
 * Returns a description of the first module reference in `code`, or `undefined` when the source
 * is self-contained. `import.meta` and `import` / `export` used as property or object keys are not
 * references.
 */
export function moduleReferenceProblem(code: string): string | undefined {
  return findModuleReference(tokenize(code));
}

function tokenize(code: string): readonly Token[] {
  const state: ScanState = { source: code, index: 0, tokens: [], previous: undefined };
  scanCode(state, false);
  return state.tokens;
}

/**
 * Scans code tokens. Inside a `${...}` substitution the scan stops after the matching `}`, so the
 * caller can resume the template body.
 */
function scanCode(state: ScanState, insideTemplateExpression: boolean): void {
  const { source } = state;
  let depth = 0;

  while (state.index < source.length) {
    const char = source[state.index] ?? '';
    const next = source[state.index + 1];

    if (isWhitespace(char)) {
      state.index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (state.index < source.length && source[state.index] !== '\n') {
        state.index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      state.index += 2;
      while (state.index < source.length && !isBlockCommentEnd(source, state.index)) {
        state.index += 1;
      }
      state.index += 2;
      continue;
    }
    if (insideTemplateExpression && char === '}' && depth === 0) {
      state.index += 1;
      return;
    }

    if (isIdentifierStart(char)) {
      const start = state.index;
      state.index += 1;
      while (state.index < source.length && isIdentifierPart(source[state.index] ?? '')) {
        state.index += 1;
      }
      push(state, 'ident', source.slice(start, state.index));
      continue;
    }

    if (isDigit(char) || (char === '.' && isDigit(next ?? ''))) {
      const start = state.index;
      state.index += 1;
      while (state.index < source.length) {
        const current = source[state.index] ?? '';
        if (!isIdentifierPart(current) && current !== '.') {
          break;
        }
        state.index += 1;
      }
      push(state, 'value', source.slice(start, state.index));
      continue;
    }

    if (char === '`') {
      state.index += 1;
      scanTemplate(state);
      push(state, 'value', '`');
      continue;
    }

    if (char === "'" || char === '"') {
      scanString(state, char);
      push(state, 'value', char);
      continue;
    }

    if (char === '/' && regexAllowed(state.previous)) {
      scanRegex(state);
      push(state, 'value', '/');
      continue;
    }

    // `i++ / 2` divides, so a doubled sign must not look like a regex position.
    if ((char === '+' || char === '-') && next === char) {
      state.index += 2;
      push(state, 'punct', char + char);
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    }
    state.index += 1;
    push(state, 'punct', char);
  }
}

/** Consumes a template body; `${` recurses into code and resumes here afterwards. */
function scanTemplate(state: ScanState): void {
  const { source } = state;

  while (state.index < source.length) {
    const char = source[state.index] ?? '';
    if (char === '\\') {
      state.index += 2;
      continue;
    }
    if (char === '`') {
      state.index += 1;
      return;
    }
    if (char === '$' && source[state.index + 1] === '{') {
      state.index += 2;
      scanCode(state, true);
      continue;
    }
    state.index += 1;
  }
}

function scanString(state: ScanState, quote: string): void {
  const { source } = state;
  state.index += 1;
  while (state.index < source.length) {
    const char = source[state.index] ?? '';
    if (char === '\\') {
      state.index += 2;
      continue;
    }
    state.index += 1;
    if (char === quote) {
      return;
    }
  }
}

/** Consumes a regex literal including its flags, tolerating an unterminated one. */
function scanRegex(state: ScanState): void {
  const { source } = state;
  let inCharacterClass = false;
  state.index += 1;

  while (state.index < source.length) {
    const char = source[state.index] ?? '';
    if (char === '\\') {
      state.index += 2;
      continue;
    }
    if (char === '\n') {
      return;
    }
    state.index += 1;
    if (char === '[') {
      inCharacterClass = true;
    } else if (char === ']') {
      inCharacterClass = false;
    } else if (char === '/' && !inCharacterClass) {
      break;
    }
  }

  while (state.index < source.length && REGEX_FLAGS.includes(source[state.index] ?? '')) {
    state.index += 1;
  }
}

function regexAllowed(previous: Token | undefined): boolean {
  if (previous === undefined) {
    return true;
  }
  if (previous.type === 'ident') {
    return REGEX_PRECEDING_KEYWORDS.has(previous.value);
  }
  return previous.type === 'punct' && REGEX_PRECEDING_PUNCTUATORS.has(previous.value);
}

function findModuleReference(tokens: readonly Token[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.type !== 'ident') {
      continue;
    }
    if (isPropertyName(tokens, index)) {
      continue;
    }

    if (token.value === 'import') {
      // `import.meta` is not a module reference; a `:` means this is an object key.
      const next = tokens[index + 1];
      const allowed =
        next !== undefined && next.type === 'punct' && (next.value === '.' || next.value === ':');
      if (!allowed) {
        return 'import statements and dynamic import() are not allowed';
      }
      continue;
    }

    if (token.value === 'export') {
      const next = tokens[index + 1];
      if (next === undefined) {
        continue;
      }
      if (next.type === 'punct' && next.value === '*') {
        return 'export ... from statements are not allowed';
      }
      if (next.type === 'punct' && next.value === '{') {
        const close = matchingBrace(tokens, index + 1);
        const after = close === undefined ? undefined : tokens[close + 1];
        if (after !== undefined && after.type === 'ident' && after.value === 'from') {
          return 'export ... from statements are not allowed';
        }
      }
    }
  }
  return undefined;
}

function isPropertyName(tokens: readonly Token[], index: number): boolean {
  const previous = tokens[index - 1];
  return previous !== undefined && previous.type === 'punct' && previous.value === '.';
}

function matchingBrace(tokens: readonly Token[], open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.type !== 'punct') {
      continue;
    }
    if (token.value === '{') {
      depth += 1;
    } else if (token.value === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function push(state: ScanState, type: TokenType, value: string): void {
  const token: Token = { type, value };
  state.tokens.push(token);
  state.previous = token;
}

function isBlockCommentEnd(source: string, index: number): boolean {
  return source[index] === '*' && source[index + 1] === '/';
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isIdentifierStart(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    char === '_' ||
    char === '$' ||
    char.charCodeAt(0) > 0x7f
  );
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || isDigit(char);
}
