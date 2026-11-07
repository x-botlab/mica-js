/**
 * Browser guest entry of `Scene3DHost`.
 *
 * Loaded inside a sandbox Worker next to the main thread. Composition is compile-time: the browser
 * build gets `OffscreenCanvas` + WebGL2 for camera sensors and `$sandbox.createChildSandbox()` for
 * circuit simulators.
 *
 * ```ts
 * const host = await createSandbox({
 *   name: 'scene3d-host',
 *   source: { type: 'module', url: new URL('@mica-js/scene-3d/runtime/host', import.meta.url).href },
 *   capabilities: {
 *     getDocument: () => document,
 *     getCircuitSource: () => ({ type: 'module', url: circuitGuestUrl }),
 *   },
 * });
 *
 * await host.call('step', 1000 / 60);
 * ```
 */

import { createMujocoRuntime } from '../physics/mujoco-runtime';
import { createOffscreenRenderer } from '../rendering/renderer.browser';
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
