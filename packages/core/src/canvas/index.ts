export { CANVAS_VERSION } from './format/types';
export type { CanvasDocument, CanvasPlacement, CanvasVersion } from './format/types';

export { parseCanvas } from './format/parse';
export { serializeCanvas } from './format/serialize';

export { loadCanvas } from './load';
export type { CanvasLayoutEntry, LoadCanvasOptions, LoadedCanvas } from './load';

export { applyCanvasCommand } from './edit';
export type { ApplyCanvasCommandOptions, CanvasCommand } from './edit';

// The `.cnv` contract shares the format error and diagnostic types with the `.sch` contract, so a
// host can handle both files with one error type.
export { SchematicError } from '../schematic/format/errors';
export type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticEntity,
  DiagnosticRelated,
  DiagnosticSeverity,
} from '../schematic/format/diagnostics';
