import type { Diagnostic } from '../schematic/format/diagnostics';
import { SchematicError } from '../schematic/format/errors';
import type { SchematicDocument } from '../schematic/format/types';
import { toPointer } from '../schematic/format/validate';
import { parseCanvas } from './format/parse';
import type { CanvasDocument, CanvasPlacement } from './format/types';

export interface LoadCanvasOptions {
  /** Bound schematic; layout keys are validated against its symbols when provided. */
  readonly schematic?: SchematicDocument;
}

export interface CanvasLayoutEntry {
  readonly symbolId: string;
  readonly placement: CanvasPlacement;
}

export interface LoadedCanvas {
  readonly document: CanvasDocument;
  /** Layout entries sorted by symbol id, so loading is deterministic. */
  readonly placements: readonly CanvasLayoutEntry[];
}

/** Parses a canvas and validates its layout against the bound schematic. @throws {SchematicError} */
export function loadCanvas(
  source: string | CanvasDocument,
  options: LoadCanvasOptions = {},
): LoadedCanvas {
  const document = parseCanvas(source);
  const diagnostics: Diagnostic[] = [];

  const symbolIds =
    options.schematic === undefined
      ? undefined
      : new Set(options.schematic.sheet.symbols.map((symbol) => symbol.id));

  const placements: CanvasLayoutEntry[] = [];
  for (const symbolId of Object.keys(document.layout).sort()) {
    const placement = document.layout[symbolId];
    if (placement === undefined) {
      continue;
    }
    if (symbolIds !== undefined && !symbolIds.has(symbolId)) {
      diagnostics.push({
        severity: 'error',
        code: 'canvas/unknown-symbol',
        message: `Canvas layout references symbol ${JSON.stringify(symbolId)} which is absent from the bound schematic.`,
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
