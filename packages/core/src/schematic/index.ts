export { SCHEMATIC_VERSION } from './format/types';
export type {
  Placement,
  Point,
  Rect,
  SchematicDocument,
  SchematicJunction,
  SchematicSheet,
  SchematicSymbol,
  SchematicVersion,
  SchematicViewDocument,
  SchematicWire,
} from './format/types';

export type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticEntity,
  DiagnosticRelated,
  DiagnosticSeverity,
} from './format/diagnostics';
export type { ParseResult } from './format/result';

export { parseSchematic } from './format/parse-schematic';
export { parseView } from './format/parse-view';
export { serializeSchematic, serializeView } from './format/serialize';
