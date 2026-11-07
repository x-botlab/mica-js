/**
 * Assembly definition format (`.assembly.json`), from the design document §2.2.2.
 *
 * An assembly definition is a reusable robot template: it binds one schematic and lists the
 * entities that make up the robot. A scene references the definition through an `AssemblyInstance`
 * entity, and every instance gets its own circuit simulator, so two instances of the same template
 * never share sensor or motor state.
 *
 * Like the rest of `@mica-js/scene-3d`, every descriptor is a plain readonly object, so a parsed
 * definition can be shared by the editor, the runtime and any number of scene instances without
 * defensive copies.
 */

import type { SceneEntity } from '../entities';
import type { Vec3d } from '../math';

/** Schema version of the `.assembly.json` contract. */
export const ASSEMBLY_VERSION = 1;

/** Version literal carried by every {@link AssemblyDefinition}. */
export type AssemblyVersion = typeof ASSEMBLY_VERSION;

/**
 * A reusable robot/assembly template stored in a `.assembly.json` file.
 *
 * `name` identifies the definition when a scene instantiates it; `schematic` is loaded once per
 * instance, not once per definition.
 */
export interface AssemblyDefinition {
  /** Schema version; readers must reject versions they do not understand. */
  readonly version: 1;

  /** Stable name other documents use to reference this definition. */
  readonly name: string;

  /** Human-readable name shown by the editor. */
  readonly displayName?: string;

  /** Schematic bound to the assembly; each instance loads its own copy. */
  readonly schematic: string;

  /** Entities that make up the assembly (models, joints and sensors), in document order. */
  readonly entities: readonly SceneEntity[];

  /** Centre of mass in assembly-local space, used to manipulate the assembly as a whole. */
  readonly centerOfMass?: Vec3d;

  /** Free-form provenance of the template. */
  readonly metadata?: {
    readonly author?: string;
    readonly description?: string;
    readonly thumbnail?: string;
    readonly tags?: readonly string[];
  };
}
