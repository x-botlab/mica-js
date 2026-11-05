import { parseSchematic } from '../format/parse-schematic';
import type { SchematicDocument } from '../../format/types';
import {
  deriveSchematicTopology,
  type SchematicTopology,
  type SchematicTopologyOptions,
} from '../netlist/derive';

export type LoadSchematicOptions = SchematicTopologyOptions;

export interface LoadedSchematic {
  readonly document: SchematicDocument;
  readonly topology: SchematicTopology;
}

/** Parses a schematic and derives its topology. @throws {SchematicError} on any contract violation. */
export function loadSchematic(
  source: string | SchematicDocument,
  options: LoadSchematicOptions = {},
): LoadedSchematic {
  const document = parseSchematic(source);
  return { document, topology: deriveSchematicTopology(document, options) };
}
