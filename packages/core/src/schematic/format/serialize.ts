import type { PropertyValue, SchematicDocument } from './types';

/** Serializes with a fixed field order and 2-space indentation, matching the examples in #6. */
export function serializeSchematic(document: SchematicDocument): string {
  const serializable = {
    version: document.version,
    sheet: {
      symbols: document.sheet.symbols.map((symbol) => {
        const serialized: Record<string, unknown> = {
          id: symbol.id,
          device: symbol.device,
          x: symbol.x,
          y: symbol.y,
          rotation: symbol.rotation,
        };
        if (symbol.properties !== undefined && Object.keys(symbol.properties).length > 0) {
          serialized['properties'] = sortProperties(symbol.properties);
        }
        // Role-scoped fields are written explicitly so the file states what the symbol is for.
        if (symbol.designator !== undefined) {
          serialized['designator'] = symbol.designator;
        }
        if (symbol.net !== undefined) {
          serialized['net'] = symbol.net;
        }
        if (symbol.reference !== undefined) {
          serialized['reference'] = { x: symbol.reference.x, y: symbol.reference.y };
        }
        return serialized;
      }),
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

function sortProperties(
  properties: Readonly<Record<string, PropertyValue>>,
): Record<string, PropertyValue> {
  const sorted: Record<string, PropertyValue> = Object.create(null);
  for (const key of Object.keys(properties).sort()) {
    const value = properties[key];
    if (value !== undefined) {
      sorted[key] = value;
    }
  }
  return sorted;
}
