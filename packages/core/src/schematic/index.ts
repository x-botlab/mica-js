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
export { SchematicError } from './format/errors';

export { parseSchematic } from './format/parse-schematic';
export { parseView } from './format/parse-view';
export { serializeSchematic, serializeView } from './format/serialize';

export { deriveSchematicTopology } from './topology/derive';
export type {
  DanglingWireEnd,
  SchematicNet,
  SchematicNetMember,
  SchematicPinInstance,
  SchematicTopology,
  TopologyOptions,
} from './topology/derive';

export {
  LABEL_DEVICE,
  RESERVED_PACKAGE_NAMESPACE,
  formatDeviceReference,
  isLabelDevice,
  isReservedPackageId,
  isValidPackageId,
  parseDeviceReference,
} from './device/reference';
export type { DeviceReference } from './device/reference';
export type {
  DeviceSymbolDefinition,
  DeviceSymbolGeometry,
  DeviceSymbolProvider,
  PinAnchor,
} from './device/symbol';
export { createDeviceRegistry } from './device/registry';
export type {
  DevicePackageRegistration,
  DeviceRegisterOptions,
  DeviceRegistrationEntry,
  DeviceRegistry,
  ResolvedDevice,
} from './device/registry';
