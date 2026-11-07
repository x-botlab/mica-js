import type { Vec3d } from '../math';

/** Ambient light, which illuminates every surface equally and avoids pitch-black shadows. */
export interface AmbientLightConfig {
  /** CSS color string, for example `#ffffff`. */
  readonly color: string;

  /** Intensity multiplier; 0 disables the light. */
  readonly intensity: number;
}

/** A sun-like directional light with a single direction for the whole scene. */
export interface DirectionalLightConfig {
  /** CSS color string, for example `#ffffff`. */
  readonly color: string;

  /** Intensity multiplier; 0 disables the light. */
  readonly intensity: number;

  /** Position the light shines from, in world space and metres. */
  readonly position: Vec3d;
}

/** Environment settings: lighting and background. */
export interface EnvironmentConfig {
  /** Ambient light; always present so a scene is never completely unlit. */
  readonly ambientLight: AmbientLightConfig;

  /** Optional key light for shading and soft shadows. */
  readonly directionalLight?: DirectionalLightConfig;

  /** Skybox asset path, for example an equirectangular panorama or a `glb` environment scene. */
  readonly skybox?: string;
}
