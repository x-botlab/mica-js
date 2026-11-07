/**
 * Test guest entry of `Scene3DHost`.
 *
 * Same composition as the browser entry, with the deterministic mock renderer and the in-memory
 * physics runtime, so an end-to-end sandbox test needs neither a GPU nor a WebGL context. Resolved
 * through the `test` export condition of `@mica-js/scene-3d/runtime/host`; the file deliberately
 * does not end in `.test.ts` so the unit-test runner does not treat it as a spec.
 */

import { createMujocoRuntime } from '../physics/mujoco-runtime';
import { createOffscreenRenderer } from '../rendering/renderer.mock';
import { bootstrapScene3DHost } from './bootstrap';
import {
  createChildCircuitOptions,
  getGuestSandbox,
  optionalInvoke,
  parseCircuitSource,
} from './guest';

const sandbox = getGuestSandbox();
const circuitSource = parseCircuitSource(await optionalInvoke(sandbox, 'getCircuitSource'));

await bootstrapScene3DHost({
  sandbox,
  createPhysics: () => createMujocoRuntime(),
  createRenderer: () => createOffscreenRenderer(),
  ...(circuitSource === null
    ? {}
    : { circuits: createChildCircuitOptions(sandbox, circuitSource) }),
});
