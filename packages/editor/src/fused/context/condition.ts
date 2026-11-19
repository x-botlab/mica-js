import type { ContextValue } from './keys';

/**
 * Reads a key by name. Unknown names return `undefined`, so independently contributed views may
 * reference keys that are registered later without an error.
 */
export type ContextLookup = (id: string) => ContextValue | undefined;

/**
 * A parsed condition. Parsing validates once; `evaluate` is pure and reads keys through the
 * supplied lookup, so callers can evaluate the same condition against several scopes.
 */
export interface ICondition {
  readonly expression: string;
  /**
   * Key names the expression reads, in first-seen order. Subscribe selectively by filtering
   * `IContextChangeEvent.names` with this list.
   */
  readonly keys: readonly string[];
  evaluate(lookup: ContextLookup): boolean;
}

/** Raised for malformed expressions; `position` is the character offset of the problem. */
export class ConditionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
    readonly position: number,
  ) {
    super(`${message} (position ${position}) in "${expression}"`);
    this.name = 'ConditionError';
  }
}

type TokenKind =
  'and' | 'or' | 'not' | 'equals' | 'not-equals' | 'open' | 'close' | 'literal' | 'key';

interface IToken {
  readonly kind: TokenKind;
  readonly text: string;
  readonly position: number;
  readonly value?: ContextValue | undefined;
}

type ConditionNode =
  | { readonly kind: 'literal'; readonly value: ContextValue | undefined }
  | { readonly kind: 'key'; readonly id: string }
  | { readonly kind: 'not'; readonly operand: ConditionNode }
  | { readonly kind: 'and'; readonly left: ConditionNode; readonly right: ConditionNode }
  | { readonly kind: 'or'; readonly left: ConditionNode; readonly right: ConditionNode }
  | {
      readonly kind: 'compare';
      readonly operator: '==' | '!=';
      readonly left: ConditionNode;
      readonly right: ConditionNode;
    };

const INTEGER_OR_DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

/**
 * Parses a condition expression.
 *
 * Supported syntax: `&&`, `||`, `!`, parentheses, `==`, `!=`, key references and the scalar
 * literals `true`, `false`, `undefined`, `null`, numbers and single- or double-quoted strings.
 * `!` binds tighter than comparisons, which bind tighter than `&&`, which binds tighter than
 * `||`; chained comparisons need explicit parentheses. There is no `eval`/`Function` usage.
 *
 * @throws {ConditionError} when the expression is empty, has unbalanced parentheses, misses an
 * operand or operator, uses an unsupported operator/character or leaves a trailing token.
 */
export function parseCondition(expression: string): ICondition {
  return new ConditionParser(expression).parse();
}

class ConditionParser {
  readonly #expression: string;
  readonly #tokens: readonly IToken[];
  readonly #keys = new Set<string>();
  #index = 0;

  constructor(expression: string) {
    this.#expression = expression;
    this.#tokens = tokenize(expression);
  }

  parse(): ICondition {
    if (this.#tokens.length === 0) {
      throw new ConditionError('Expression is empty', this.#expression, 0);
    }
    const root = this.#parseOr();
    const trailing = this.#peek();
    if (trailing !== undefined) {
      throw new ConditionError(
        `Unexpected "${trailing.text}"`,
        this.#expression,
        trailing.position,
      );
    }
    return {
      expression: this.#expression,
      keys: Object.freeze([...this.#keys]),
      evaluate: (lookup) => evaluateNode(root, lookup),
    };
  }

  #parseOr(): ConditionNode {
    let node = this.#parseAnd();
    while (this.#accept('or') !== undefined) {
      node = { kind: 'or', left: node, right: this.#parseAnd() };
    }
    return node;
  }

  #parseAnd(): ConditionNode {
    let node = this.#parseComparison();
    while (this.#accept('and') !== undefined) {
      node = { kind: 'and', left: node, right: this.#parseComparison() };
    }
    return node;
  }

  #parseComparison(): ConditionNode {
    const left = this.#parseUnary();
    const operator = this.#accept('equals') ?? this.#accept('not-equals');
    if (operator === undefined) return left;
    const right = this.#parseUnary();
    const chained = this.#peek();
    if (chained !== undefined && (chained.kind === 'equals' || chained.kind === 'not-equals')) {
      throw new ConditionError(
        'Chained comparisons need parentheses',
        this.#expression,
        chained.position,
      );
    }
    return {
      kind: 'compare',
      operator: operator.kind === 'equals' ? '==' : '!=',
      left,
      right,
    };
  }

  #parseUnary(): ConditionNode {
    if (this.#accept('not') !== undefined) {
      return { kind: 'not', operand: this.#parseUnary() };
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): ConditionNode {
    const token = this.#peek();
    if (token === undefined) {
      throw new ConditionError(
        'Unexpected end of expression',
        this.#expression,
        this.#expression.length,
      );
    }
    if (token.kind === 'open') {
      this.#index += 1;
      const inner = this.#parseOr();
      const close = this.#peek();
      if (close?.kind !== 'close') {
        throw new ConditionError(
          'Missing ")"',
          this.#expression,
          close?.position ?? this.#expression.length,
        );
      }
      this.#index += 1;
      return inner;
    }
    if (token.kind === 'literal') {
      this.#index += 1;
      return { kind: 'literal', value: token.value };
    }
    if (token.kind === 'key') {
      this.#index += 1;
      this.#keys.add(token.text);
      return { kind: 'key', id: token.text };
    }
    throw new ConditionError(`Unexpected "${token.text}"`, this.#expression, token.position);
  }

  #peek(): IToken | undefined {
    return this.#tokens[this.#index];
  }

  #accept(kind: TokenKind): IToken | undefined {
    const token = this.#tokens[this.#index];
    if (token?.kind !== kind) return undefined;
    this.#index += 1;
    return token;
  }
}

function tokenize(expression: string): IToken[] {
  const tokens: IToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const position = index;
    if (char === '&' || char === '|') {
      if (expression[index + 1] !== char) {
        throw new ConditionError(
          `Unexpected "${char}"; use "${char}${char}"`,
          expression,
          position,
        );
      }
      tokens.push({ kind: char === '&' ? 'and' : 'or', text: `${char}${char}`, position });
      index += 2;
      continue;
    }
    if (char === '=') {
      if (expression[index + 1] !== '=') {
        throw new ConditionError('Unexpected "="; use "=="', expression, position);
      }
      tokens.push({ kind: 'equals', text: '==', position });
      index += 2;
      continue;
    }
    if (char === '!') {
      if (expression[index + 1] === '=') {
        tokens.push({ kind: 'not-equals', text: '!=', position });
        index += 2;
      } else {
        tokens.push({ kind: 'not', text: '!', position });
        index += 1;
      }
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: char === '(' ? 'open' : 'close', text: char, position });
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const text = readString(expression, index);
      tokens.push({ kind: 'literal', text, position, value: parseString(text) });
      index += text.length;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(expression[index + 1] ?? ''))) {
      const match = INTEGER_OR_DECIMAL.exec(expression.slice(index));
      if (match === null) {
        throw new ConditionError('Invalid number', expression, position);
      }
      const text = match[0];
      tokens.push({ kind: 'literal', text, position, value: Number(text) });
      index += text.length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = IDENTIFIER.exec(expression.slice(index));
      if (match === null) {
        throw new ConditionError(`Unexpected "${char}"`, expression, position);
      }
      const text = match[0];
      const value = KEYWORD_VALUES.get(text);
      if (KEYWORD_VALUES.has(text)) {
        tokens.push({ kind: 'literal', text, position, value });
      } else {
        tokens.push({ kind: 'key', text, position });
      }
      index += text.length;
      continue;
    }
    throw new ConditionError(`Unexpected character "${char}"`, expression, position);
  }
  return tokens;
}

const KEYWORD_VALUES = new Map<string, ContextValue | undefined>([
  ['true', true],
  ['false', false],
  ['undefined', undefined],
  ['null', undefined],
]);

/** @returns the whole quoted literal, quotes included. */
function readString(expression: string, start: number): string {
  const quote = expression[start]!;
  let index = start + 1;
  while (index < expression.length) {
    const char = expression[index]!;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return expression.slice(start, index + 1);
    index += 1;
  }
  throw new ConditionError('Unterminated string literal', expression, start);
}

function parseString(text: string): string {
  let value = '';
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index]!;
    if (char !== '\\') {
      value += char;
      continue;
    }
    const escaped = text[index + 1] ?? '';
    value += ESCAPES.get(escaped) ?? escaped;
    index += 1;
  }
  return value;
}

const ESCAPES = new Map<string, string>([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

function evaluateNode(node: ConditionNode, lookup: ContextLookup): boolean {
  switch (node.kind) {
    case 'literal':
      return truthy(node.value);
    case 'key':
      return truthy(lookup(node.id));
    case 'not':
      return !evaluateNode(node.operand, lookup);
    case 'and':
      return evaluateNode(node.left, lookup) && evaluateNode(node.right, lookup);
    case 'or':
      return evaluateNode(node.left, lookup) || evaluateNode(node.right, lookup);
    case 'compare': {
      const left = resolveOperand(node.left, lookup);
      const right = resolveOperand(node.right, lookup);
      return node.operator === '==' ? left === right : left !== right;
    }
  }
}

function resolveOperand(node: ConditionNode, lookup: ContextLookup): ContextValue | undefined {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'key':
      return lookup(node.id);
    default:
      return truthy(evaluateNode(node, lookup));
  }
}

function truthy(value: ContextValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'boolean') return value;
  return value.length > 0;
}
