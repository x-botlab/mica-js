/**
 * Schema version of the `.sch` and `.view` file contracts (see x-botlab/mica-js#6).
 */
export const SCHEMATIC_VERSION = 1;

export type SchematicVersion = typeof SCHEMATIC_VERSION;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

/** Instance property value stored in `symbol.properties` (see #6 / #7). */
export type PropertyValue = string | number | boolean;

export interface SchematicSymbol extends Placement {
  readonly id: string;
  readonly device: string;
  /** Instance property overrides; absent means "use device defaults". */
  readonly properties?: Readonly<Record<string, PropertyValue>>;
  /**
   * Reference designator anchor in symbol-local coordinates (unrotated, unplaced).
   * Absent means the default position at the body's top-left corner.
   */
  readonly reference?: Point;
}

export interface SchematicWire {
  readonly id: string;
  readonly points: readonly Point[];
}

export interface SchematicJunction {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly wires: readonly string[];
}

export interface SchematicSheet {
  readonly symbols: readonly SchematicSymbol[];
  readonly wires: readonly SchematicWire[];
  readonly junctions: readonly SchematicJunction[];
}

export interface SchematicDocument {
  readonly version: SchematicVersion;
  readonly id: string;
  readonly sheet: SchematicSheet;
}

export interface SchematicViewDocument {
  readonly version: SchematicVersion;
  readonly id: string;
  readonly schematic: string;
  readonly layout: Readonly<Record<string, Placement>>;
}
