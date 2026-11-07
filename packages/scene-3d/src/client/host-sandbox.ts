import { SandboxWorker } from '@mica-js/sandbox';
import type { SandboxWorkerOptions } from '@mica-js/sandbox';
import circuitGuestScript from '../guest/circuit/entry.ts?sandbox-worker-code';
import scene3dHostGuestCode from '../guest/scene-host/entry.ts?sandbox-worker-code';

/** Self-contained scene-host guest code bundled by `@mica-js/sandbox/vite`. */
export const scene3dHostGuestScript: string = scene3dHostGuestCode;
/** Self-contained circuit guest code used for direct child workers. */
export const circuitGuestWorkerScript: string = circuitGuestScript;

/** Creates the isolated scene-host worker. */
export function createScene3DHostSandbox(options: SandboxWorkerOptions = {}): SandboxWorker {
  return new SandboxWorker(scene3dHostGuestScript, { name: 'scene-3d-host', ...options });
}
