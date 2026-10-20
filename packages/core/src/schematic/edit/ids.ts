import type { SchematicDocument } from '../format/types';

export type ElementKind = 'symbol' | 'wire' | 'junction';

export type ElementIdFactory = (kind: ElementKind, document: SchematicDocument) => string;

const PREFIXES: Readonly<Record<ElementKind, string>> = {
  symbol: 's',
  wire: 'w',
  junction: 'j',
};

function usedIds(document: SchematicDocument, kind: ElementKind): ReadonlySet<string> {
  const ids =
    kind === 'symbol'
      ? document.sheet.symbols.map((symbol) => symbol.id)
      : kind === 'wire'
        ? document.sheet.wires.map((wire) => wire.id)
        : document.sheet.junctions.map((junction) => junction.id);
  return new Set(ids);
}

/** Deterministic ids: the first free `s1`, `w1` or `j1` sequence member. */
export const defaultElementIdFactory: ElementIdFactory = (kind, document) => {
  const prefix = PREFIXES[kind];
  const used = usedIds(document, kind);
  let index = 1;
  while (used.has(`${prefix}${index}`)) {
    index += 1;
  }
  return `${prefix}${index}`;
};
