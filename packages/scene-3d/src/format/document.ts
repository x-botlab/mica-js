import type { SceneEntity } from '../entities';
import type { EnvironmentConfig } from './environment';
import type { MaterialLibrary } from './materials';
import type { Scene3DVersion } from './version';
import type { WorldConfig } from './world';

export type { SceneEntity };

/**
 * Root structure of a `.scene3d` document.
 *
 * The document root stores the base fields shared by every entity. Concrete payloads (`ModelEntity`
 * and the entity kinds defined by later issues) refine `type`; a parser validates unknown kinds
 * after reading the raw document instead of failing the whole file.
 */
export interface Scene3DDocument {
  /** Schema version; readers must reject versions they do not understand. */
  readonly version: Scene3DVersion;

  /** Bound schematic file, shared with the 2D canvas. */
  readonly schematic?: string;

  /** Physical world configuration. */
  readonly world: WorldConfig;

  /** All entities in the scene, in document order. */
  readonly entities: readonly SceneEntity[];

  /** Environment configuration: lighting and background. */
  readonly environment: EnvironmentConfig;

  /** Scene-level material presets referenced by entity material names. */
  readonly materials?: MaterialLibrary;
}
