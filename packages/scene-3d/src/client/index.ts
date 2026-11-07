/**
 * Main-thread entry of the split scene runtime.
 *
 * Deliberately free of Three.js: the renderer is a port, so this module works in any main-thread
 * environment. The Three.js adapter lives in `@mica-js/scene-3d/client/three`.
 */

export { createScene3DHostProxy, Scene3DClient } from './client';
export { createScene3DHostSandbox, scene3dHostGuestScript } from './host-sandbox';
export type {
  Scene3DHostLike,
  Scene3DHostWorkerOptions,
  Scene3DClientOptions,
  Scene3DHostBootstrap,
  Scene3DView,
} from './client';
