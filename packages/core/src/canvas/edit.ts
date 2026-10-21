import type { Diagnostic } from '../schematic/format/diagnostics';
import { SchematicError } from '../schematic/format/errors';
import type { SchematicDocument } from '../schematic/format/types';
import { toPointer } from '../schematic/format/validate';
import type { CanvasDocument, CanvasPlacement } from './format/types';

export type CanvasCommand =
  | {
      readonly type: 'set-placement';
      readonly symbolId: string;
      readonly x: number;
      readonly y: number;
      readonly rotation?: number;
    }
  | { readonly type: 'remove-placement'; readonly symbolId: string }
  | { readonly type: 'bind-schematic'; readonly schematic: string };

export interface ApplyCanvasCommandOptions {
  /** Bound schematic; symbol references are validated against it when provided. */
  readonly schematic?: SchematicDocument;
}

/**
 * Applies a canvas command to a copy of `canvas`.
 *
 * @throws {SchematicError} when the command is invalid; the input canvas is never mutated.
 */
export function applyCanvasCommand(
  canvas: CanvasDocument,
  command: CanvasCommand,
  options: ApplyCanvasCommandOptions = {},
): CanvasDocument {
  const diagnostics: Diagnostic[] = [];
  const layout: Record<string, CanvasPlacement> = { ...canvas.layout };

  switch (command.type) {
    case 'set-placement': {
      if (command.symbolId.length === 0) {
        diagnostics.push({
          severity: 'error',
          code: 'schema/invalid-value',
          message: 'Placement symbol id must not be empty.',
          pointer: toPointer(['layout']),
        });
        break;
      }
      requireKnownSymbol(command.symbolId, options, diagnostics);
      const existing = layout[command.symbolId];
      layout[command.symbolId] = {
        x: command.x,
        y: command.y,
        rotation: command.rotation ?? existing?.rotation ?? 0,
      };
      break;
    }
    case 'remove-placement': {
      if (!Object.prototype.hasOwnProperty.call(layout, command.symbolId)) {
        diagnostics.push({
          severity: 'error',
          code: 'edit/unknown-entity',
          message: `Canvas has no placement for symbol "${command.symbolId}".`,
          pointer: toPointer(['layout', command.symbolId]),
        });
        break;
      }
      delete layout[command.symbolId];
      break;
    }
    case 'bind-schematic': {
      if (command.schematic.length === 0) {
        diagnostics.push({
          severity: 'error',
          code: 'schema/invalid-value',
          message: 'Bound schematic reference must not be empty.',
          pointer: toPointer(['schematic']),
        });
        break;
      }
      if (diagnostics.length === 0) {
        return { ...canvas, schematic: command.schematic };
      }
      break;
    }
    default: {
      diagnostics.push({
        severity: 'error',
        code: 'edit/invalid-command',
        message: `Unsupported canvas command ${JSON.stringify((command as { type?: unknown }).type)}.`,
      });
    }
  }

  if (diagnostics.length > 0) {
    throw new SchematicError(diagnostics);
  }
  return { ...canvas, layout };
}

function requireKnownSymbol(
  symbolId: string,
  options: ApplyCanvasCommandOptions,
  diagnostics: Diagnostic[],
): void {
  if (options.schematic === undefined) {
    return;
  }
  if (options.schematic.sheet.symbols.some((symbol) => symbol.id === symbolId)) {
    return;
  }
  diagnostics.push({
    severity: 'error',
    code: 'canvas/unknown-symbol',
    message: `Canvas layout references symbol ${JSON.stringify(symbolId)} which is absent from the bound schematic.`,
    pointer: toPointer(['layout', symbolId]),
  });
}
