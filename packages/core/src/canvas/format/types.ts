/**
 * Schema version of the `.cnv` canvas contract (see x-botlab/mica-js#67).
 *
 * A canvas is a 2D layout: one `.cnv` binds exactly one `.sch` (see x-botlab/mica-js#6) and keeps
 * a placement per symbol id. Schematic connections stay in the `.sch`; the canvas only adds 2D
 * coordinates and rotation.
 */
export const CANVAS_VERSION = 1;

export type CanvasVersion = typeof CANVAS_VERSION;

/** 2D placement of one symbol in a canvas. */
export interface CanvasPlacement {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

export interface CanvasDocument {
  readonly version: CanvasVersion;
  /** Canvas identity, unique within one project's `.cnv` files. */
  readonly id: string;
  /** Project-root relative POSIX path of the bound `.sch`. */
  readonly schematic: string;
  /** Symbol id → placement; ids are stable, so renaming a designator keeps the entry. */
  readonly layout: Readonly<Record<string, CanvasPlacement>>;
}
