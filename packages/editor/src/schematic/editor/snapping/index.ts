/** Snapping helpers shared by the interaction modules; none of them touch the DOM. */
export {
  MIN_HIT_PIXELS,
  anchorSymbolAt,
  connectionNodeAt,
  pinPosition,
  wireEndpointAt,
} from './nodes';
export type { ISnapContext } from './nodes';
export { snapDragOffset, snapToGrid } from './drag';
export { snapForWire, wireBodyPointAt, orthogonalWaypoints, wireWaypoints } from './wire';
export type { WireAxis } from './wire';
export {
  LABEL_STUB_LENGTH,
  isPlacementTool,
  labelStubAt,
  nextNetName,
  placementProperties,
  toolDevice,
} from './label';
export type { ILabelStub } from './label';
