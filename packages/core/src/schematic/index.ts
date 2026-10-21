export { SCHEMATIC_VERSION } from './format/types';
export type {
  AssetMode,
  AssetReference,
  Placement,
  Point,
  PropertyValue,
  Rect,
  SchematicDocument,
  SchematicJunction,
  SchematicSheet,
  SchematicSymbol,
  SchematicVersion,
  SchematicWire,
} from './format/types';

export {
  ASSET_MODES,
  assetPathError,
  base64Error,
  isAssetMode,
  isAssetReference,
} from './format/asset';

export type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticEntity,
  DiagnosticRelated,
  DiagnosticSeverity,
} from './format/diagnostics';
export { SchematicError } from './format/errors';

export { parseSchematic } from './format/parse-schematic';
export { serializeSchematic } from './format/serialize';

export { deriveSchematicTopology } from './topology/derive';
export type {
  DanglingWireEnd,
  SchematicNet,
  SchematicNetMember,
  SchematicPinInstance,
  SchematicTopology,
  TopologyOptions,
} from './topology/derive';

export { loadSchematic } from './load/load';
export type { LoadSchematicOptions, LoadedSchematic } from './load/load';

export { applySchematicCommand } from './edit/commands';
export type { EditEffect, SchematicCommand, SchematicEditOptions } from './edit/commands';
export { defaultElementIdFactory } from './edit/ids';
export type { ElementIdFactory, ElementKind } from './edit/ids';
export { SchematicEditor } from './edit/editor';
export type { SchematicEditorOptions } from './edit/editor';

export { findJunctionCandidates, hitTestSchematic } from './edit/query';
export { isConnectedVertex, planSegmentDrag } from './edit/segment-drag';
export type { SegmentDragOptions } from './edit/segment-drag';
export { joinJunctionAt, planJunctionRelease } from './edit/junctions';
export type { JunctionJoin, JunctionRelease, JunctionReleaseOptions } from './edit/junctions';
export type {
  HitTestOptions,
  JunctionCandidate,
  JunctionCandidateOptions,
  SchematicHit,
} from './edit/query';

export { mergeWiresAtJunction, splitWireAt } from './edit/wires';
export type { MergeWiresResult, SplitWireResult, WireEditOptions } from './edit/wires';

export {
  rotatePoint,
  referenceAnchor,
  referencePosition,
  symbolBounds,
  symbolPinPosition,
} from './geometry/transform';
export { rerouteWireEndpoint, stretchWireEndpoint } from './geometry/reroute';
export type { PointMove, ReroutedWire } from './geometry/reroute';
export {
  DEFAULT_TOLERANCE,
  distanceToSegment,
  nearestPointOnPolyline,
  pointOnPolyline,
  pointOnPolylineAt,
  pointsEqual,
  projectOnSegment,
  samePoint,
} from './geometry/point';
export type { SegmentProjection } from './geometry/point';
export { previewSymbolDrag } from './edit/preview';
export type { SymbolDragPreview } from './edit/preview';

export {
  DEFAULT_GROUND_LABEL,
  DEFAULT_POWER_LABEL,
  DEFAULT_TEXT_CONTENT,
  GROUND_DEVICE,
  LABEL_DEVICE,
  POWER_DEVICE,
  RESERVED_PACKAGE_NAMESPACE,
  TEXT_DEVICE,
  builtinSymbolKind,
  defaultNetName,
  designatorOf,
  formatDeviceReference,
  hasDesignator,
  isBuiltinDevice,
  isLabelDevice,
  isReservedPackageId,
  isTextDevice,
  isValidPackageId,
  namesNet,
  netNameOf,
  parseDeviceReference,
  symbolRole,
  textDeviceContent,
} from './device/reference';
export type { BuiltinSymbolKind, DeviceReference, SymbolRole } from './device/reference';
export type {
  DeviceSymbolDefinition,
  DeviceSymbolGeometry,
  DeviceSymbolProvider,
  PinAnchor,
  PinSide,
} from './device/symbol';
export { synthesizeDeviceSymbol } from './device/synthesis';
export { pinSide, pinStubEnd, pinsBounds } from './device/symbol';
export type {
  DevicePinDeclaration,
  SymbolSynthesisInput,
  SymbolSynthesisOptions,
} from './device/synthesis';
export { createDeviceRegistry } from './device/registry';
export {
  PROPERTY_TYPES,
  isPropertyType,
  normalizeColor,
  normalizePropertyValue,
  parsePropertyDescriptor,
  propertyValueProblem,
  readPropertyDescriptors,
} from './device/properties';
export type {
  PropertyDescriptor,
  PropertyOption,
  PropertyType,
  PropertyValueProblem,
} from './device/properties';
export {
  DEFAULT_DESIGNATOR_PREFIX,
  createDesignatorFactory,
  defaultDesignatorFactory,
  designatorPrefixOf,
  nextDesignator,
} from './device/designator';
export type { DesignatorFactory } from './device/designator';
export type {
  DevicePackageRegistration,
  DeviceRegisterOptions,
  DeviceRegistrationEntry,
  DeviceRegistry,
  ResolvedDevice,
} from './device/registry';
