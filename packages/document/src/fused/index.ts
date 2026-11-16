/**
 * `@mica-js/document/fused`: the unified device package manifest (RFC 0020), the model interface
 * (RFC 0021), device 2D geometry (RFC 0022), the fused `.sch` version 2 document (RFC 0024) and
 * firmware property values (RFC 0026).
 *
 * The entry is pure data plus document operations: it parses and validates, and derives the
 * electrical nets of a document. Editors, runtimes and hosts own their own state.
 */
export { FusedDocumentError } from './diagnostics';
export type { FusedDiagnostic, FusedDiagnosticCode, FusedDiagnosticSeverity } from './diagnostics';

export {
  isDeviceId,
  isSemVer,
  isIntegrity,
  isMemberKey,
  isEventKey,
  isPinId,
  isCodiconName,
  isNameSegment,
  packagePathProblem,
  projectPathProblem,
} from './rules';

export { STRICT_JSON_MAX_DEPTH, decodeStrictJson, parseStrictJson } from './json';
export type { JsonDecodeFailure, JsonDecodeResult, JsonDecodeSuccess } from './json';

export { parseUnifiedManifest } from './manifest';
export { parseGeometry2D } from './geometry';
export { parseFusedDocument } from './document';
export { validateModelValue } from './value-type';
export { deriveFusedTopology } from './topology';
export type { FusedNet, FusedNetPin, FusedTopology } from './topology';

export type {
  Value,
  ValueType,
  MethodDefinition,
  ModelDefinition,
  Point2D,
  Rect2D,
  PinLabelGeometry2D,
  PinGeometry2D,
  Geometry2D,
  DevicePropertyType,
  PropertyOption,
  FirmwareAddressSpace,
  DevicePropertyDescriptor,
  PinDeclaration,
  UnifiedDeviceEntries,
  View2DDefinition,
  HtmlViewDefinition,
  UnifiedDeviceManifest,
  ResourceMode,
  ResourceReference,
  FirmwareFileReference,
  FirmwareProjectReference,
  FirmwareReference,
  PropertyValue,
  FusedDocumentVersion,
  DeviceDependency,
  Placement2D,
  SidebarViewLayout,
  FloatingBounds,
  HtmlViewLayout,
  InstanceViewLayout,
  FusedInstance,
  Endpoint,
  ConnectionNode,
  ConnectionWire,
  NetLabel,
  VoltageReference,
  FusedDisplaySettings,
  FusedDocument,
  DeviceLock,
  PackageFile,
  PackageFiles,
  DeviceRegistry,
  ReadonlyBytes,
  FirmwareSegment,
  FirmwareImage,
} from './types';
export { FUSED_DOCUMENT_VERSION } from './types';
