/**
 * Schema version of the `.sch` contract (see x-botlab/mica-js#6).
 *
 * 2D placement lives in the separate `.cnv` canvas contract (see x-botlab/mica-js#67 and
 * `@mica-js/core/canvas`).
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

/** Where an image / binary property value lives (#7). */
export type AssetMode = 'file' | 'inline' | 'store';

/**
 * Reference to a project asset instead of inline bytes (#7): `file` is a project-root relative
 * POSIX path, `inline` is base64 text and `store` is a host resource identifier.
 */
export interface AssetReference {
  readonly src: string;
  readonly mode: AssetMode;
}

/**
 * Instance property value stored in `symbol.properties` (see #6 / #7): a scalar, a resource
 * reference for `image` / `binary` properties, or `null` for an explicitly cleared nullable one.
 */
export type PropertyValue = string | number | boolean | AssetReference | null;

export interface SchematicSymbol extends Placement {
  /** Stable identity used by selections, undo and `.view` layout keys. */
  readonly id: string;
  readonly device: string;
  /** Instance property overrides; absent means "use device defaults". */
  readonly properties?: Readonly<Record<string, PropertyValue>>;
  /**
   * Reference designator of a component (`U1`, `R2`); defaults to {@link id}.
   * Only components carry one — the format rejects it elsewhere.
   */
  readonly designator?: string;
  /**
   * Net name of a net label, power or ground symbol (`VCC`, `N1`). It is the text drawn next to
   * the anchor and the key same-named ports merge on. Only net-naming symbols carry one.
   */
  readonly net?: string;
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

/** Root of a `.sch` file; the file name is the schematic's identity. */
export interface SchematicDocument {
  readonly version: SchematicVersion;
  readonly sheet: SchematicSheet;
}
