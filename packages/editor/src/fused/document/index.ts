/**
 * Fused workbench document service: the immutable document, its unified undo history, the saved
 * marker, central permission and run locking, and the verified device package cache.
 */
export { FusedDocumentSession, serializeFusedDocument } from './session';
export type {
  IFusedDocumentSessionOptions,
  IFusedDocumentState,
  IFusedTransactionOptions,
} from './session';
export { accessDenied, FusedSessionError, toSessionError } from './errors';
export type { IFusedSessionErrorOptions, IFusedSessionProblem } from './errors';
export { verifyFusedDocument } from './verify';
export type { IVerifiedFusedDocument, IVerifyFusedDocumentOptions } from './verify';
export { copyTargets, pasteClipboard } from './copy';
export type { IFusedClipboard } from './copy';
export type {
  IAddInstanceResult,
  IdFactory,
  IFusedDocumentTarget,
  IFusedLabelOptions,
  IFusedReferenceOptions,
} from './edits';
export { DeviceCache } from '../devices';
export type { IDeviceCache, IPreparedDevice } from '../devices';
export {
  addInstance,
  addLabel,
  addNode,
  addReference,
  addWire,
  findInstance,
  moveInstances,
  removeInstanceProperty,
  removeTargets,
  renameDesignator,
  rotateInstances,
  setInstancePosition,
  setInstanceProperty,
  setViewLayout,
} from './edits';
export {
  endpointPoint,
  isOrthogonalPolyline,
  materializeAnchor,
  orthogonalPath,
  routeDocumentWires,
  routeWireBends,
  wirePolyline,
} from '../wiring';
export type { WiringDevices } from '../wiring';
