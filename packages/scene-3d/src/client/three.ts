/**
 * Three.js adapter for the main-thread scene view.
 *
 * Separated from `@mica-js/scene-3d/client` so Three.js stays an optional peer dependency: only
 * applications that import this subpath need it installed.
 */

export { createThreeScene3DView } from './three-view';
export type { ThreeScene3DView, ThreeScene3DViewOptions } from './three-view';
