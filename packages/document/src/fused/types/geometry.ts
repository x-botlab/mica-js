/** Static two-dimensional geometry of a device (RFC 0022). */

/** Local coordinate; `x` points right and `y` points down (RFC 0022). */
export interface Point2D {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned rectangle in local coordinates (RFC 0022). */
export interface Rect2D extends Point2D {
  readonly width: number;
  readonly height: number;
}

/** Optional pin label placement; `visible` defaults to `true` (RFC 0022). */
export interface PinLabelGeometry2D {
  readonly position: Point2D;
  readonly visible?: boolean;
}

/** Anchoring of one pin inside a device's local coordinate system (RFC 0022). */
export interface PinGeometry2D {
  readonly position: Point2D;
  /** Non-zero direction the host normalizes for the pin stub and the label orientation. */
  readonly outward: Point2D;
  readonly label?: PinLabelGeometry2D;
}

/** Resolved 2D presentation geometry of a device (RFC 0022). */
export interface Geometry2D {
  readonly sizing: 'physical' | 'flexible';
  /** Drawing extent; drawn content must stay inside it. */
  readonly bounds: Rect2D;
  /** Body extent used for layout diagnostics. */
  readonly bodyBounds: Rect2D;
  /** Package-root relative PNG or self-contained static SVG body image. */
  readonly bodyImage?: string;
  /** Pin id to geometry; the key set matches the manifest pin ids exactly. */
  readonly pins: Readonly<Record<string, PinGeometry2D>>;
  /** Reference designator anchor; defaults to the body's top-left corner. */
  readonly designator?: Point2D;
}
