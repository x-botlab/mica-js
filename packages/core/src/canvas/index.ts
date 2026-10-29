export { CANVAS_VERSION } from './format/types';
export type {
  CanvasBindingTarget,
  CanvasDocument,
  CanvasWidgetInstance,
  WidgetPlacement,
} from './format/types';

// Widget definitions and canvas placements share the #10 payload type names, so consumers can
// resolve and check them through the same public entry.
export { PAYLOAD_TYPES, isAssignable, parsePayloadType } from '../format/type-name';
export type { PayloadType } from '../format/type-name';

export { parseCanvas } from './format/parse';
export { serializeCanvas } from './format/serialize';

export { applyCanvasCommand } from './edit/commands';
export type { CanvasCommand } from './edit/commands';

// RFC 0017: a port descriptor may declare how publishes become deliveries; the payload type
// supplies the default when the field is omitted. They are re-exported here because the canvas
// contract owns the port descriptor shape that widget and device ports share.
export {
  DELIVERY_KINDS,
  defaultDelivery,
  parseDeliveryKind,
  resolveDelivery,
} from '../topic/delivery';
export type { DeliveryKind } from '../topic/delivery';

export { assertCanvasBindings, validateCanvasBindings } from './bindings/validate';
export type { CanvasBindingCatalog, CanvasPortDescriptor } from './bindings/catalog';
export type { ValidateCanvasBindingsOptions } from './bindings/validate';

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
