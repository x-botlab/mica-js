/**
 * Strict JSON reader for the fused contracts.
 *
 * `JSON.parse` silently keeps the last of two equal keys, which would let a manifest or a `.sch`
 * file carry two different values for one field. RFC 0020 and RFC 0024 require rejecting
 * duplicate keys, so the parsers decode JSON text with this reader instead. Keys are compared
 * after unescaping, so `"a"` and `"\u0061"` are the same key.
 */
import { FusedDocumentError, report } from './diagnostics';
import type { FusedDiagnostic } from './diagnostics';

/** Deepest object/array nesting the reader accepts. */
export const STRICT_JSON_MAX_DEPTH = 256;

export interface JsonDecodeSuccess {
  readonly ok: true;
  readonly value: unknown;
}

export interface JsonDecodeFailure {
  readonly ok: false;
  readonly diagnostics: readonly FusedDiagnostic[];
}

export type JsonDecodeResult = JsonDecodeSuccess | JsonDecodeFailure;

/**
 * Decodes JSON text, rejecting duplicate keys and reporting every problem with a JSON Pointer.
 *
 * @throws {FusedDocumentError} when the text is not valid JSON or repeats an object key.
 */
export function parseStrictJson(text: string): unknown {
  const result = decodeStrictJson(text);
  if (!result.ok) {
    throw new FusedDocumentError(result.diagnostics);
  }
  return result.value;
}

/** Non-throwing form of {@link parseStrictJson}; the caller decides how to surface the problems. */
export function decodeStrictJson(text: string): JsonDecodeResult {
  return new Reader(text).decode();
}

class Reader {
  readonly #text: string;
  readonly #diagnostics: FusedDiagnostic[] = [];
  #index = 0;
  #failed = false;

  constructor(text: string) {
    this.#text = text;
  }

  decode(): JsonDecodeResult {
    this.#skipWhitespace();
    const value = this.#readValue([], 0);
    if (this.#failed) {
      return this.#failure();
    }
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) {
      this.#fail('Unexpected content after the JSON value.');
      return this.#failure();
    }
    if (this.#diagnostics.length > 0) {
      return this.#failure();
    }
    return { ok: true, value };
  }

  #failure(): JsonDecodeFailure {
    return { ok: false, diagnostics: this.#diagnostics };
  }

  #fail(message: string): undefined {
    if (!this.#failed) {
      report(
        this.#diagnostics,
        'json/invalid',
        `Invalid JSON at offset ${String(this.#index)}: ${message}`,
        [],
      );
    }
    this.#failed = true;
    return undefined;
  }

  #skipWhitespace(): void {
    while (this.#index < this.#text.length) {
      const code = this.#text.charCodeAt(this.#index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        return;
      }
      this.#index += 1;
    }
  }

  #readValue(path: readonly string[], depth: number): unknown {
    this.#skipWhitespace();
    if (this.#index >= this.#text.length) {
      return this.#fail('Unexpected end of input; expected a value.');
    }
    if (depth > STRICT_JSON_MAX_DEPTH) {
      return this.#fail(`Nesting deeper than ${String(STRICT_JSON_MAX_DEPTH)} is not supported.`);
    }
    const character = this.#text[this.#index];
    switch (character) {
      case '{':
        return this.#readObject(path, depth + 1);
      case '[':
        return this.#readArray(path, depth + 1);
      case '"':
        return this.#readString();
      case 't':
        return this.#readKeyword('true', true);
      case 'f':
        return this.#readKeyword('false', false);
      case 'n':
        return this.#readKeyword('null', null);
      default:
        return this.#readNumber();
    }
  }

  #readKeyword(keyword: string, value: unknown): unknown {
    if (this.#text.startsWith(keyword, this.#index)) {
      this.#index += keyword.length;
      return value;
    }
    return this.#fail(`Expected ${keyword}.`);
  }

  #readNumber(): number | undefined {
    NUMBER.lastIndex = this.#index;
    const match = NUMBER.exec(this.#text);
    if (match === null) {
      return this.#fail('Expected a value.');
    }
    this.#index = NUMBER.lastIndex;
    return Number(match[0]);
  }

  #readString(): string | undefined {
    this.#index += 1;
    let value = '';
    let chunkStart = this.#index;
    for (;;) {
      if (this.#index >= this.#text.length) {
        return this.#fail('Unterminated string.');
      }
      const code = this.#text.charCodeAt(this.#index);
      if (code === 0x22) {
        value += this.#text.slice(chunkStart, this.#index);
        this.#index += 1;
        return value;
      }
      if (code === 0x5c) {
        value += this.#text.slice(chunkStart, this.#index);
        this.#index += 1;
        const escape = this.#readEscape();
        if (escape === undefined) {
          return undefined;
        }
        value += escape;
        chunkStart = this.#index;
        continue;
      }
      if (code < 0x20) {
        return this.#fail('Control characters must be escaped inside strings.');
      }
      this.#index += 1;
    }
  }

  #readEscape(): string | undefined {
    if (this.#index >= this.#text.length) {
      return this.#fail('Unterminated escape sequence.');
    }
    const character = this.#text[this.#index];
    this.#index += 1;
    switch (character) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return this.#readUnicodeEscape();
      default:
        return this.#fail(`Unknown escape sequence "\\${String(character)}".`);
    }
  }

  #readUnicodeEscape(): string | undefined {
    const digits = this.#text.slice(this.#index, this.#index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
      return this.#fail('Unicode escapes need exactly four hexadecimal digits.');
    }
    this.#index += 4;
    return String.fromCharCode(Number.parseInt(digits, 16));
  }

  #readObject(path: readonly string[], depth: number): Record<string, unknown> | undefined {
    this.#index += 1;
    const object: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#text[this.#index] === '}') {
      this.#index += 1;
      return object;
    }
    for (;;) {
      this.#skipWhitespace();
      if (this.#text[this.#index] !== '"') {
        return this.#fail('Expected a property name.');
      }
      const key = this.#readString();
      if (key === undefined) {
        return undefined;
      }
      this.#skipWhitespace();
      if (this.#text[this.#index] !== ':') {
        return this.#fail('Expected ":" after the property name.');
      }
      this.#index += 1;

      const memberPath = [...path, key];
      const duplicate = keys.has(key);
      if (duplicate) {
        report(
          this.#diagnostics,
          'json/duplicate-key',
          `Duplicate JSON key ${JSON.stringify(key)}; the contract does not allow one key twice.`,
          memberPath,
        );
      } else {
        keys.add(key);
      }

      const value = this.#readValue(memberPath, depth);
      if (this.#failed) {
        return undefined;
      }
      if (!duplicate) {
        Object.defineProperty(object, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      this.#skipWhitespace();
      const next = this.#text[this.#index];
      if (next === ',') {
        this.#index += 1;
        continue;
      }
      if (next === '}') {
        this.#index += 1;
        return object;
      }
      return this.#fail('Expected "," or "}" in the object.');
    }
  }

  #readArray(path: readonly string[], depth: number): unknown[] | undefined {
    this.#index += 1;
    const array: unknown[] = [];
    this.#skipWhitespace();
    if (this.#text[this.#index] === ']') {
      this.#index += 1;
      return array;
    }
    for (;;) {
      const item = this.#readValue([...path, String(array.length)], depth);
      if (this.#failed) {
        return undefined;
      }
      array.push(item);
      this.#skipWhitespace();
      const next = this.#text[this.#index];
      if (next === ',') {
        this.#index += 1;
        continue;
      }
      if (next === ']') {
        this.#index += 1;
        return array;
      }
      return this.#fail('Expected "," or "]" in the array.');
    }
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
