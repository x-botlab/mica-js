import type { Diagnostic } from '../format/diagnostics';
import { SchematicError } from '../format/errors';
import { parseSchematic } from '../format/parse-schematic';
import { parseView } from '../format/parse-view';
import type { Placement, SchematicDocument, SchematicViewDocument } from '../format/types';
import { toPointer } from '../format/validate';
import {
  deriveSchematicTopology,
  type SchematicTopology,
  type TopologyOptions,
} from '../topology/derive';

export type LoadSchematicOptions = TopologyOptions;

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

export interface LoadViewOptions {
  /** Bound schematic; layout keys are validated against its symbols when provided. */
  readonly schematic?: SchematicDocument;
}

export interface ViewPlacement {
  readonly symbolId: string;
  readonly placement: Placement;
}

export interface LoadedSchematicView {
  readonly document: SchematicViewDocument;
  /** Layout entries sorted by symbol id. */
  readonly placements: readonly ViewPlacement[];
}

/** Parses a view and validates its layout against the bound schematic. @throws {SchematicError} */
export function loadView(
  source: string | SchematicViewDocument,
  options: LoadViewOptions = {},
): LoadedSchematicView {
  const document = parseView(source);
  const diagnostics: Diagnostic[] = [];

  const symbolIds =
    options.schematic === undefined
      ? undefined
      : new Set(options.schematic.sheet.symbols.map((symbol) => symbol.id));

  const placements: ViewPlacement[] = [];
  for (const symbolId of Object.keys(document.layout).sort()) {
    const placement = document.layout[symbolId];
    if (placement === undefined) {
      continue;
    }
    if (symbolIds !== undefined && !symbolIds.has(symbolId)) {
      diagnostics.push({
        severity: 'error',
        code: 'view/unknown-symbol',
        message: `View layout references symbol ${JSON.stringify(symbolId)} which is absent from the bound schematic.`,
        pointer: toPointer(['layout', symbolId]),
      });
      continue;
    }
    placements.push({ symbolId, placement });
  }

  if (diagnostics.length > 0) {
    throw new SchematicError(diagnostics);
  }
  return { document, placements };
}
