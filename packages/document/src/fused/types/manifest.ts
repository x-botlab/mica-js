/**
 * Unified device manifest: the `package.json` of a single-device release (RFC 0020).
 *
 * Identity, entries, property descriptions, pins, model interface, 2D declaration and HTML views
 * live directly on the root object; every structural object rejects unknown fields.
 */
import type { Geometry2D } from './geometry';
import type { ModelDefinition } from './model';
import type { PropertyValue } from './property';

/** Predefined property value kinds of a device property description (RFC 0009 / RFC 0020). */
export type DevicePropertyType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'color'
  | 'enum'
  | 'image'
  | 'binary'
  | 'firmware'
  | 'program';

export type ProgramLoader = 'memory' | 'filesystem';
export type ProgramFormat = 'bin' | 'hex' | 'elf';
export type ProgramAddressSpace = FirmwareAddressSpace;

export interface ProgramDefaults {
  readonly addressSpace: string;
  readonly loadAddress?: number;
}

/** One selectable `enum` option (RFC 0009). */
export interface PropertyOption {
  readonly value: string;
  readonly label: string;
}

/** Declared firmware address space (RFC 0026). */
export interface FirmwareAddressSpace {
  readonly title?: string;
  /** First address the space allows, in bytes. */
  readonly start: number;
  /** Number of bytes the space allows. */
  readonly size: number;
}

/**
 * Description of one device property (RFC 0009, extended by RFC 0020 and RFC 0026).
 *
 * The constraints that apply depend on `type`; a descriptor that declares a constraint of another
 * type is rejected instead of being partially interpreted.
 */
export interface DevicePropertyDescriptor {
  readonly type: DevicePropertyType;
  readonly title?: string;
  readonly description?: string;
  /** Declared default; absent when the description omits it. */
  readonly default?: PropertyValue;
  /** When true an explicit `null` is a valid instance value. */
  readonly nullable?: boolean;
  readonly group?: string;
  /** Panel ordering hint; a non-negative integer. */
  readonly order?: number;
  /** `string`: maximum length in Unicode code points. */
  readonly maxLength?: number;
  /** `integer` / `number`: closed lower bound. */
  readonly min?: number;
  /** `integer` / `number`: closed upper bound. */
  readonly max?: number;
  /** `number`: open lower bound. */
  readonly exclusiveMin?: number;
  /** `integer` / `number`: editing step, always greater than zero. */
  readonly step?: number;
  /** `number` display unit of the stored value. */
  readonly unit?: string;
  /** `color`: whether `#RRGGBBAA` values are accepted. */
  readonly alpha?: boolean;
  /** `enum`: non-empty option list. */
  readonly options?: readonly PropertyOption[];
  /** `image` / `binary` / `firmware`: host-side payload limit in bytes. */
  readonly maxBytes?: number;
  /** `image`: host-side pixel limit. */
  readonly maxPixels?: number;
  /** `binary`: file extension filter, each entry matching `\.[A-Za-z0-9]+`. */
  readonly extensions?: readonly string[];
  /** `firmware`: non-empty address space map (RFC 0026). */
  readonly addressSpaces?: Readonly<Record<string, FirmwareAddressSpace>>;
  /** `firmware`: default address space id, present in `addressSpaces`. */
  readonly addressSpace?: string;
  /** `firmware`: default BIN load address inside the default address space. */
  readonly loadAddress?: number;
  readonly loader?: ProgramLoader;
  readonly formats?: readonly ProgramFormat[];
  readonly defaults?: ProgramDefaults;
  readonly templates?: readonly string[];
}

/** Display information of one declared pin (RFC 0020). */
export interface PinDeclaration {
  readonly label?: string;
  readonly description?: string;
}

/** Reserved non-2D entry points of a device package (RFC 0020). */
export interface UnifiedDeviceEntries {
  /** Package-root relative `.js` path of the 3D view entry. */
  readonly view3d?: string;
}

/** 2D presentation declaration of a device (RFC 0022). */
export interface View2DDefinition {
  /** Inline geometry or a package-root relative `.json` path. */
  readonly geometry: Geometry2D | string;
  /** Optional package-root relative `.js` dynamic overlay entry. */
  readonly entry?: string;
}

/** One HTML view declaration (RFC 0020 / RFC 0023). */
export interface HtmlViewDefinition {
  /** Non-empty title used for the view header, tooltip and accessible name. */
  readonly title: string;
  /** Package-root relative `.html` path. */
  readonly entry: string;
  /** Initial location; defaults to `sidebar`. */
  readonly defaultLocation?: 'sidebar' | 'floating';
  /** VS Code Codicons name supplied by the editor. */
  readonly icon?: string;
}

/** Root contract of a single-device package manifest (RFC 0020). */
export interface UnifiedDeviceManifest {
  readonly publisher: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  /** Host API compatibility range; `mica` is required. */
  readonly engines: { readonly mica: string };
  readonly displayName: string;
  /** Package-root relative PNG or self-contained static SVG icon. */
  readonly icon?: string;
  /** Reference designator prefix; defaults to `U`. */
  readonly designatorPrefix?: string;
  readonly entries?: UnifiedDeviceEntries;
  readonly properties?: Readonly<Record<string, DevicePropertyDescriptor>>;
  readonly pins?: Readonly<Record<string, PinDeclaration>>;
  readonly model?: ModelDefinition;
  readonly view2d?: View2DDefinition;
  readonly view?: Readonly<Record<string, HtmlViewDefinition>>;
}
