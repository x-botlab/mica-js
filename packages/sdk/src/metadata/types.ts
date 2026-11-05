/**
 * TypeScript shapes for individual device and widget metadata.
 *
 * The types describe the same contract as the JSON schemas in `schema.ts`; runtime validation
 * remains authoritative because a metadata file is untrusted JSON.
 */

export type MetadataKind = 'device' | 'widget';

/** A two-dimensional point, serialized as `[x, y]`. */
export type Point = readonly [x: number, y: number];

export type PropertyType = 'number' | 'boolean' | 'string' | 'enum' | 'bytes';

export type PortDirection = 'input' | 'output';

export type PortPayloadType =
  | 'boolean'
  | 'number'
  | 'string'
  | 'vec2d'
  | 'vec3d'
  | 'bytes'
  | 'bytes<rgb565>'
  | 'bytes<segments>';

export type PortDelivery = 'level' | 'message';

export type GraphicFill = 'none' | 'foreground' | 'background';

export type TextAlign = 'left' | 'center' | 'right';

export type PinDirection = 'left' | 'right' | 'up' | 'down';

export interface NumberEditor {
  readonly kind: 'number';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface TextEditor {
  readonly kind: 'text';
}

export interface TextareaEditor {
  readonly kind: 'textarea';
}

export interface CheckboxEditor {
  readonly kind: 'checkbox';
}

export interface FileEditor {
  readonly kind: 'file';
}

export interface SelectEditor {
  readonly kind: 'select';
  readonly labels: Readonly<Record<string, string>>;
}

export type PropertyEditor =
  NumberEditor | TextEditor | TextareaEditor | CheckboxEditor | FileEditor | SelectEditor;

interface PropertyCommon {
  /** `true` values have no default; `false` values must declare one. */
  readonly required: boolean;
  readonly nullable?: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly unit?: string;
  readonly group?: string;
  readonly order?: number;
}

export interface NumberProperty extends PropertyCommon {
  readonly type: 'number';
  readonly default?: number | null;
  readonly editor?: NumberEditor;
}

export interface BooleanProperty extends PropertyCommon {
  readonly type: 'boolean';
  readonly default?: boolean | null;
  readonly editor?: CheckboxEditor;
}

export interface StringProperty extends PropertyCommon {
  readonly type: 'string';
  readonly default?: string | null;
  readonly editor?: TextEditor | TextareaEditor;
}

export interface EnumProperty extends PropertyCommon {
  readonly type: 'enum';
  readonly enumName: string;
  readonly values: readonly string[];
  readonly default?: string | null;
  readonly editor?: SelectEditor;
}

/**
 * Bytes values may omit the default, but bytes defaults are rejected: the byte encoding is not
 * decided yet, so a default cannot be expressed as plain JSON.
 */
export interface BytesProperty extends PropertyCommon {
  readonly type: 'bytes';
}

export type PropertyMetadata =
  NumberProperty | BooleanProperty | StringProperty | EnumProperty | BytesProperty;

export interface PortMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly direction: PortDirection;
  readonly type: PortPayloadType;
  readonly delivery?: PortDelivery;
}

export interface PinMetadata {
  readonly label?: string;
  readonly description?: string;
  readonly group?: string;
}

interface GraphicCommon {
  readonly fill?: GraphicFill;
  readonly strokeWidth?: number;
}

export interface LineGraphic extends GraphicCommon {
  readonly type: 'line';
  readonly from: Point;
  readonly to: Point;
}

export interface PolylineGraphic extends GraphicCommon {
  readonly type: 'polyline';
  readonly points: readonly Point[];
  readonly closed?: boolean;
}

export interface RectGraphic extends GraphicCommon {
  readonly type: 'rect';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CircleGraphic extends GraphicCommon {
  readonly type: 'circle';
  readonly center: Point;
  readonly radius: number;
}

export interface ArcGraphic extends GraphicCommon {
  readonly type: 'arc';
  readonly center: Point;
  readonly radius: number;
  readonly startAngle: number;
  /** Degrees in `[-360, 360]`, excluding `0`. */
  readonly sweepAngle: number;
}

export interface TextGraphic extends GraphicCommon {
  readonly type: 'text';
  readonly position: Point;
  readonly text: string;
  readonly align?: TextAlign;
  readonly fontSize: number;
}

export type Graphic =
  LineGraphic | PolylineGraphic | RectGraphic | CircleGraphic | ArcGraphic | TextGraphic;

export interface SymbolBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PinLabelMetadata {
  readonly visible: boolean;
  readonly position?: Point;
  readonly align?: TextAlign;
}

export interface SymbolPinMetadata {
  readonly position: Point;
  readonly direction: PinDirection;
  readonly label?: PinLabelMetadata;
}

export interface DesignatorAnnotationMetadata {
  readonly position: Point;
  readonly align?: TextAlign;
}

export interface SymbolAnnotationsMetadata {
  readonly designator?: DesignatorAnnotationMetadata;
}

export interface SymbolMetadata {
  readonly bounds: SymbolBounds;
  readonly graphics: readonly Graphic[];
  readonly pins: Readonly<Record<string, SymbolPinMetadata>>;
  readonly annotations?: SymbolAnnotationsMetadata;
}

interface MetadataHeader {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly license?: string;
  readonly tags?: readonly string[];
}

export interface DeviceMetadata extends MetadataHeader {
  readonly kind: 'device';
  readonly designatorPrefix?: string;
  readonly properties?: Readonly<Record<string, PropertyMetadata>>;
  readonly pins?: Readonly<Record<string, PinMetadata>>;
  readonly ports?: Readonly<Record<string, PortMetadata>>;
  readonly symbol?: SymbolMetadata;
}

export interface WidgetMetadata extends MetadataHeader {
  readonly kind: 'widget';
  readonly properties?: Readonly<Record<string, PropertyMetadata>>;
  readonly ports?: Readonly<Record<string, PortMetadata>>;
}

export type Metadata = DeviceMetadata | WidgetMetadata;
