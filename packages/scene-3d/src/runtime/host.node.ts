/**
 * Node guest entry of `Scene3DHost` (headless).
 *
 * Uses the in-memory `MujocoRuntime` and the headless renderer: the simulation advances without a
 * GPU, so a Node sandbox can run physics and circuit lockstep for CI, replay and batch jobs. Camera
 * frames stay unavailable unless the embedder installs a `headless-gl` backend; see
 * `renderer.headless.ts`.
 */

import { createMujocoRuntime } from '../physics/mujoco-runtime';
import { createOffscreenRenderer } from '../rendering/renderer.headless';
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
