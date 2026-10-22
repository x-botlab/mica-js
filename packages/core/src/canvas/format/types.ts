/**
 * Schema version of the `.cnv` canvas contract (see x-botlab/mica-js#67).
 *
 * A canvas is an independent 2D plane: it records widget instances with their placement, property
 * overrides and port-to-symbol bindings. Electrical topology stays in the `.sch` the canvas binds
 * (see x-botlab/mica-js#6); the two coordinate spaces are unrelated.
 */
export const CANVAS_VERSION = 1;

/** Placement and size of one widget instance, in logical units. */
export interface WidgetPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Clockwise rotation in degrees around the instance center. */
  readonly rotation: number;
}

/** Endpoint of a widget port: a port of one symbol instance in the bound schematic. */
export interface CanvasBindingTarget {
  readonly symbol: string;
  readonly port: string;
}

/** One widget placed on a canvas; the order in `widgets` is the drawing order (#67). */
export interface CanvasWidgetInstance extends WidgetPlacement {
  /** Stable identity: UUID v4, unique within the document. */
  readonly id: string;
  /** Widget reference `"<package>:<widget>"`; built-ins use the reserved `builtin:` namespace. */
  readonly widget: string;
  /** Property overrides keyed by the widget definition; values follow that definition (#7). */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Port key → endpoint; only bound ports take part in messaging (#10). */
  readonly bindings?: Readonly<Record<string, CanvasBindingTarget>>;
}

/** Root of a `.cnv` file; the project-root relative path is the canvas identity. */
export interface CanvasDocument {
  readonly version: typeof CANVAS_VERSION;
  /** Project-root relative POSIX path of the `.sch` the canvas draws and simulates against. */
  readonly schematic?: string;
  /** Widget instances in drawing order; later instances paint above earlier ones. */
  readonly widgets: readonly CanvasWidgetInstance[];
}
