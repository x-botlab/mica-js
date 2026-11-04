import { BuildError, type DeviceIR, type SourceInfo } from '@mica-js/device-model';
import { DDLCompiler } from './compiler.js';
import type { Device } from './generated/ast.js';
import { createDDLServices } from './services.js';

export { createDDLServices } from './services.js';
export { generateDeviceTypes, generateDeviceTypeScript } from './projection.js';
export type { DeviceTypeScriptOptions } from './projection.js';
export type { DeviceIR } from '@mica-js/device-model';

export interface CompileDDLOptions {
  /** URI retained by every generated declaration, region and operation. */
  readonly uri?: string;
}

let services: ReturnType<typeof createDDLServices> | undefined;
const compiled = new Map<string, DeviceIR>();
const maxCachedModels = 32;
const maxCachedCharacters = 256 * 1024;
const maxCachedModelCharacters = 64 * 1024;
let cachedCharacters = 0;

function remember(key: string, model: DeviceIR): void {
  compiled.set(key, model);
  cachedCharacters += key.length;
  while (compiled.size > maxCachedModels || cachedCharacters > maxCachedCharacters) {
    const oldest = compiled.keys().next().value!;
    cachedCharacters -= oldest.length;
    compiled.delete(oldest);
  }
}

/** Parses real DDL grammar, lowers its AST, and validates the canonical IR. */
export async function compileDDL(
  source: string,
  options: CompileDDLOptions = {},
): Promise<DeviceIR> {
  const uri = options.uri ?? 'memory:///device.ddl';
  const key =
    source.length + uri.length + 16 <= maxCachedModelCharacters
      ? `${uri.length}:${uri}${source}`
      : undefined;
  const cached = key === undefined ? undefined : compiled.get(key);
  if (cached) {
    compiled.delete(key!);
    compiled.set(key!, cached);
    return cached;
  }
  const parser = (services ??= createDDLServices()).DDL.parser.LangiumParser;
  const parsed = parser.parse<Device>(source);
  const lexical = parsed.lexerErrors[0];
  const syntax = parsed.parserErrors[0];
  if (lexical || syntax) {
    const token = syntax?.token;
    const offset =
      lexical?.offset ??
      (token && Number.isFinite(token.startOffset) ? token.startOffset : source.length);
    const length =
      lexical?.length ??
      (token && Number.isFinite(token.endOffset) ? token.endOffset! - offset + 1 : 0);
    const position = (index: number) => {
      const prefix = source.slice(0, index);
      const lines = prefix.split('\n');
      return { line: lines.length, column: lines.at(-1)!.length + 1 };
    };
    const info: SourceInfo = {
      uri,
      range: { start: position(offset), end: position(offset + length) },
    };
    throw new BuildError([
      {
        code: 'IR_SCHEMA',
        phase: 'construct',
        path: [],
        source: info,
        message: lexical?.message ?? syntax!.message,
        related: [],
      },
    ]);
  }
  const model = new DDLCompiler(parsed.value, uri).compile();
  // The shared validator returns a deeply immutable snapshot; cache no parser state or errors.
  if (key !== undefined) remember(key, model);
  return model;
}
