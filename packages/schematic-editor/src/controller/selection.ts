import type { SchematicDocument } from '@mica/core/schematic';
import type { EditorSelection } from './types';

export function sameSelectionItem(left: EditorSelection, right: EditorSelection): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'vertex' && right.kind === 'vertex') {
    return left.wireId === right.wireId && left.index === right.index;
  }
  if (left.kind === 'reference' && right.kind === 'reference') {
    return left.symbolId === right.symbolId;
  }
  return 'id' in left && 'id' in right ? left.id === right.id : false;
}

export function sameSelection(
  left: readonly EditorSelection[],
  right: readonly EditorSelection[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return other !== undefined && sameSelectionItem(item, other);
    })
  );
}

/** Drops entries whose target disappeared from the document. */
export function pruneSelection(
  selection: readonly EditorSelection[],
  document: SchematicDocument,
): readonly EditorSelection[] {
  if (selection.length === 0) {
    return selection;
  }
  const symbols = new Set(document.sheet.symbols.map((symbol) => symbol.id));
  const wires = new Map(document.sheet.wires.map((wire) => [wire.id, wire]));
  const junctions = new Set(document.sheet.junctions.map((junction) => junction.id));
  const kept = selection.filter((item) => {
    switch (item.kind) {
      case 'symbol':
        return symbols.has(item.id);
      case 'reference':
        return symbols.has(item.symbolId);
      case 'wire':
        return wires.has(item.id);
      case 'junction':
        return junctions.has(item.id);
      case 'vertex': {
        const wire = wires.get(item.wireId);
        return wire !== undefined && item.index < wire.points.length;
      }
      default:
        return false;
    }
  });
  return kept.length === selection.length ? selection : kept;
}
