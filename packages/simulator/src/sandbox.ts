import { SandboxWorker } from '@mica-js/sandbox';
import type { SandboxWorkerOptions } from '@mica-js/sandbox';
import simulationRuntimeGuestScript from './guest/simulation-runtime.ts?sandbox-worker-code';

export { simulationRuntimeGuestScript };
export { createSimulationRuntimeFromWorker } from './simulation-runtime/adapter';
export type { ISimulationRuntimeWorkerOptions } from './simulation-runtime/adapter';

/** Creates the optional browser worker; the runtime adapter takes ownership of it. */
export function createSimulationRuntimeGuestSandbox(
  options: SandboxWorkerOptions = {},
): SandboxWorker {
  return new SandboxWorker(simulationRuntimeGuestScript, options);
}
