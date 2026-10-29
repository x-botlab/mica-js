import { SCHEMATIC_VERSION, parseSchematic, type SchematicDocument } from '@mica-js/core/schematic';

/** Content a model or editor accepts: a parsed `.sch` document, or the `.sch` JSON text itself. */
export type SchematicContent = SchematicDocument | string;

/** An empty sheet, the content of a model created without `value`. */
export function createEmptySchematicDocument(): SchematicDocument {
  return { version: SCHEMATIC_VERSION, sheet: { symbols: [], wires: [], junctions: [] } };
}

/**
 * Resolves accepted content into a document: text is parsed as `.sch` JSON, documents pass through
 * unchanged and `undefined` yields an empty sheet.
 *
 * @throws {SchematicError} when the text is not a valid `.sch` document.
 */
export function resolveSchematicContent(value: SchematicContent | undefined): SchematicDocument {
  if (value === undefined) {
    return createEmptySchematicDocument();
  }
  return typeof value === 'string' ? parseSchematic(value) : value;
}
