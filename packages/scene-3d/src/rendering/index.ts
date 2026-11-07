/**
 * Environment-neutral rendering contracts.
 *
 * Implementations live in `renderer.browser.ts`, `renderer.headless.ts` and `renderer.mock.ts` and
 * are picked by the environment entry (the guest runtime and injected renderer implementations). The
 * package root only re-exports these types so importing `@mica-js/scene-3d` never pulls a
 * browser-only module into a Node build.
 */

export {
  assertSurfaceSize,
  createPixelBuffer,
  OffscreenRendererDisposedError,
  OffscreenRenderingUnavailableError,
  PIXEL_CHANNELS,
} from './renderer';
export type { OffscreenRenderer, OffscreenSurface, WebGL2LikeContext } from './renderer';
export { createHeadlessRenderer } from './renderer.headless';
export type { HeadlessCanvas, HeadlessRendererOptions } from './renderer.headless';
