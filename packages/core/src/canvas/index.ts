export { CANVAS_VERSION } from './format/types';
export type {
  CanvasBindingTarget,
  CanvasDocument,
  CanvasWidgetInstance,
  WidgetPlacement,
} from './format/types';

export { parseCanvas } from './format/parse';
export { serializeCanvas } from './format/serialize';

export { applyCanvasCommand } from './edit/commands';
export type { CanvasCommand } from './edit/commands';

// The `.cnv` contract shares the format error and diagnostic types with the `.sch` contract, so a
// host can handle both files with one error type.
export { SchematicError } from '../format/errors';
export type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticEntity,
  DiagnosticRelated,
  DiagnosticSeverity,
} from '../format/diagnostics';
