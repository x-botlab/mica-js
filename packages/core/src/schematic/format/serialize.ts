import type { SchematicDocument, SchematicViewDocument } from './types';

/** Serializes with a fixed field order and 2-space indentation, matching the examples in #6. */
export function serializeSchematic(document: SchematicDocument): string {
  const serializable = {
    version: document.version,
    id: document.id,
    sheet: {
      symbols: document.sheet.symbols.map((symbol) => ({
        id: symbol.id,
        device: symbol.device,
        x: symbol.x,
        y: symbol.y,
        rotation: symbol.rotation,
      })),
      wires: document.sheet.wires.map((wire) => ({
        id: wire.id,
        points: wire.points.map((point) => ({ x: point.x, y: point.y })),
      })),
      junctions: document.sheet.junctions.map((junction) => ({
        id: junction.id,
        x: junction.x,
        y: junction.y,
        wires: [...junction.wires],
      })),
    },
  };
  return `${JSON.stringify(serializable, null, 2)}\n`;
}

export function serializeView(view: SchematicViewDocument): string {
  const layout: Record<string, { x: number; y: number; rotation: number }> = Object.create(null);
  for (const symbolId of Object.keys(view.layout).sort()) {
    const placement = view.layout[symbolId];
    if (placement === undefined) {
      continue;
    }
    layout[symbolId] = { x: placement.x, y: placement.y, rotation: placement.rotation };
  }
  const serializable = {
    version: view.version,
    id: view.id,
    schematic: view.schematic,
    layout,
  };
  return `${JSON.stringify(serializable, null, 2)}\n`;
}
