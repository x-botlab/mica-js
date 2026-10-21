export const MICA_CORE_VERSION = '0.0.0';

export type {
  ElectricalPinInput,
  ElectricalNetworkInput,
  ElectricalContribution,
  ElectricalNetworkResult,
  FloatingInputSample,
  FloatingInput,
} from './electrical/electrical-types';
export { ElectricalConflictError, resolveElectricalNetwork } from './electrical/electrical';
export { createFloatingInput } from './electrical/floating-input';
