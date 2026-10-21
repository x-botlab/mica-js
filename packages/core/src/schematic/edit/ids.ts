import type { SchematicDocument } from '../format/types';

export type ElementKind = 'symbol' | 'wire' | 'junction';

export type ElementIdFactory = (kind: ElementKind, document: SchematicDocument) => string;

function usedIds(document: SchematicDocument, kind: ElementKind): ReadonlySet<string> {
  const ids =
    kind === 'symbol'
      ? document.sheet.symbols.map((symbol) => symbol.id)
      : kind === 'wire'
        ? document.sheet.wires.map((wire) => wire.id)
        : document.sheet.junctions.map((junction) => junction.id);
  return new Set(ids);
}

/**
 * Random UUID v4, falling back to `getRandomValues` (or `Math.random` in ancient runtimes).
 * Ids are opaque identity: they never collide with the designators and net names users edit.
 */
export function createUuid(): string {
  const source = randomSource();
  if (typeof source?.randomUUID === 'function') {
    return source.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Web Crypto as available in browsers and Node; core does not depend on either's typings. */
interface RandomSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

function randomSource(): RandomSource | undefined {
  return (globalThis as { crypto?: RandomSource }).crypto;
}

/** Fresh UUID v4 that no element of `kind` uses yet. */
export const defaultElementIdFactory: ElementIdFactory = (kind, document) => {
  const used = usedIds(document, kind);
  let id = createUuid();
  while (used.has(id)) {
    id = createUuid();
  }
  return id;
};
