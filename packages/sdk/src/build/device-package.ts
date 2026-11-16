import { isAbsolute, posix } from 'node:path';
import { parse, satisfies, validRange } from 'semver';
import type { DeviceIR, DeclarationIR, ValueTypeIR } from '@mica-js/device-model';
import type { Geometry2D, MethodDefinition, ModelDefinition, ValueType } from '../device.js';

/** Property declarations accepted by a unified device package. */
export type DevicePropertyType =
  'string' | 'integer' | 'number' | 'boolean' | 'color' | 'enum' | 'image' | 'binary' | 'firmware';

export interface ResourceReference {
  readonly src: string;
  readonly mode: 'package' | 'file' | 'inline' | 'store';
}

export interface DeviceProperty {
  readonly type: DevicePropertyType;
  readonly title?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly nullable?: boolean;
  readonly group?: string;
  readonly order?: number;
  readonly unit?: string;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMin?: number;
  readonly step?: number;
  readonly alpha?: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly maxBytes?: number;
  readonly maxPixels?: number;
  readonly extensions?: readonly string[];
  readonly addressSpaces?: Readonly<
    Record<string, { readonly title?: string; readonly start: number; readonly size: number }>
  >;
  readonly addressSpace?: string;
  readonly loadAddress?: number;
}

export interface DevicePin {
  readonly label?: string;
  readonly description?: string;
}

export interface DeviceViewEntry {
  readonly title: string;
  readonly entry: string;
  readonly defaultLocation?: 'sidebar' | 'floating';
  readonly icon?: string;
}

export interface DeviceView2DDefinition {
  readonly geometry: Geometry2D | string;
  readonly entry?: string;
}

export interface DevicePackageManifest {
  readonly publisher: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly engines: { readonly mica: string };
  readonly displayName: string;
  readonly icon?: string;
  readonly designatorPrefix?: string;
  readonly entries?: Readonly<Record<string, string>>;
  readonly properties?: Readonly<Record<string, DeviceProperty>>;
  readonly pins?: Readonly<Record<string, DevicePin>>;
  readonly model?: ModelDefinition;
  readonly view2d?: DeviceView2DDefinition;
  readonly view?: Readonly<Record<string, DeviceViewEntry>>;
}

export interface ValidateDevicePackageOptions {
  /** Host SDK version used to check `engines.mica`; skip the check when omitted. */
  readonly sdkVersion?: string;
}

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEMBER = /^[A-Za-z][A-Za-z0-9]*$/;
const EVENT = /^onDid[A-Za-z0-9]+$/;
const PIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class DevicePackageError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'DevicePackageError';
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new DevicePackageError(field, message);
}

function plain(value: unknown, field: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail(field, 'must be a plain object');
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key))
      fail(`${field}.${String(key)}`, 'is not a supported field');
  }
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0))
    fail(field, allowEmpty ? 'must be a string' : 'must be a nonempty string');
  return value;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(field, 'must be a nonnegative safe integer');
  return value as number;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    fail(field, 'must be a positive finite number');
  return value;
}

function optional<T>(
  value: T | undefined,
  check: (input: T, field: string) => void,
  field: string,
): void {
  if (value !== undefined) check(value, field);
}

function validateKey(key: string, field: string, pattern = MEMBER): void {
  if (!pattern.test(key)) fail(field, 'must match [A-Za-z][A-Za-z0-9]*');
}

function packagePath(value: unknown, field: string, extension?: string): string {
  const path = text(value, field);
  if (path.includes('\\')) fail(field, 'must use POSIX separators');
  if (path.startsWith('/') || isAbsolute(path) || /^[A-Za-z]:/.test(path))
    fail(field, 'must be package-relative');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    fail(field, 'must be a normalized package-relative file path');
  if (posix.normalize(path) !== path)
    fail(field, 'must be a normalized package-relative file path');
  if (extension !== undefined && !path.endsWith(extension))
    fail(field, `must end with ${extension}`);
  return path;
}

function validateResourceReference(
  value: unknown,
  field: string,
  modes: readonly ResourceReference['mode'][] = ['package', 'file', 'inline', 'store'],
): ResourceReference {
  const reference = plain(value, field);
  only(reference, ['src', 'mode'], field);
  const mode = text(reference.mode, `${field}.mode`) as ResourceReference['mode'];
  if (!modes.includes(mode)) fail(`${field}.mode`, `must be one of ${modes.join(', ')}`);
  const src = text(reference.src, `${field}.src`);
  if (mode === 'package') packagePath(src, `${field}.src`);
  return { src, mode };
}

function normalizeColor(value: string, field: string, alpha: boolean): string {
  const match = /^#([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/.exec(value);
  if (match === null) fail(field, 'must be a #RRGGBB or #RRGGBBAA color');
  const suffix = match[2]?.toUpperCase() ?? 'FF';
  if (!alpha && suffix !== 'FF') fail(field, 'must keep alpha at FF when "alpha" is false');
  return `#${match[1]!.toUpperCase()}${suffix}`;
}

function validateProperty(value: unknown, field: string): DeviceProperty {
  const property = plain(value, field);
  const type = text(property.type, `${field}.type`) as DevicePropertyType;
  const common = [
    'type',
    'title',
    'description',
    'default',
    'nullable',
    'group',
    'order',
    'unit',
  ] as const;
  const perType: Record<DevicePropertyType, readonly string[]> = {
    string: ['maxLength'],
    integer: ['min', 'max', 'step'],
    number: ['min', 'max', 'exclusiveMin', 'step'],
    boolean: [],
    color: ['alpha'],
    enum: ['options'],
    image: ['maxBytes', 'maxPixels'],
    binary: ['maxBytes', 'extensions'],
    firmware: ['maxBytes', 'addressSpaces', 'addressSpace', 'loadAddress'],
  };
  if (!(type in perType))
    fail(`${field}.type`, `must be one of ${Object.keys(perType).join(', ')}`);
  only(property, [...common, ...perType[type]], field);
  optional(property.title, text, `${field}.title`);
  optional(property.description, text, `${field}.description`);
  optional(property.group, text, `${field}.group`);
  optional(property.unit, text, `${field}.unit`);
  optional(
    property.nullable,
    (input, at) => {
      if (typeof input !== 'boolean') fail(at, 'must be a boolean');
    },
    `${field}.nullable`,
  );
  optional(property.order, nonnegativeInteger, `${field}.order`);
  const nullable = property.nullable === true;

  if (property.default === null && !nullable) fail(`${field}.default`, 'requires nullable: true');
  if (property.default !== undefined && property.default !== null) {
    const value = property.default;
    switch (type) {
      case 'string':
        if (typeof value !== 'string') fail(`${field}.default`, 'must be a string or null');
        break;
      case 'integer':
        if (!Number.isSafeInteger(value))
          fail(`${field}.default`, 'must be a safe integer or null');
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value))
          fail(`${field}.default`, 'must be a finite number or null');
        break;
      case 'boolean':
        if (typeof value !== 'boolean') fail(`${field}.default`, 'must be a boolean or null');
        break;
      case 'color':
        if (typeof value !== 'string')
          fail(`${field}.default`, 'must be a #RRGGBB or #RRGGBBAA color');
        break;
      case 'enum': {
        const options = property.options;
        const values = Array.isArray(options)
          ? options.map((option) =>
              typeof option === 'object' && option !== null && 'value' in option
                ? (option as { value?: unknown }).value
                : undefined,
            )
          : [];
        if (typeof value !== 'string' || !values.includes(value))
          fail(`${field}.default`, 'must be one of the declared options');
        break;
      }
      case 'image':
      case 'binary': {
        const reference = validateResourceReference(value, `${field}.default`, ['package']);
        if (reference.mode !== 'package')
          fail(`${field}.default.mode`, 'must be "package" for a package default');
        break;
      }
      case 'firmware':
        validateFirmwareDefault(value, property, `${field}.default`);
        break;
    }
  }

  if (type === 'string') {
    optional(property.maxLength, nonnegativeInteger, `${field}.maxLength`);
    if (typeof property.default === 'string' && typeof property.maxLength === 'number') {
      if ([...property.default].length > property.maxLength)
        fail(`${field}.default`, 'must not exceed maxLength');
    }
  }
  if (type === 'integer' || type === 'number') {
    for (const key of ['min', 'max', 'exclusiveMin'] as const) {
      optional(
        property[key],
        (input, at) => {
          if (typeof input !== 'number' || !Number.isFinite(input))
            fail(at, 'must be a finite number');
        },
        `${field}.${key}`,
      );
    }
    const min = typeof property.min === 'number' ? property.min : undefined;
    const max = typeof property.max === 'number' ? property.max : undefined;
    const exclusiveMin =
      typeof property.exclusiveMin === 'number' ? property.exclusiveMin : undefined;
    if (min !== undefined && exclusiveMin !== undefined)
      fail(field, 'min and exclusiveMin are mutually exclusive');
    if (min !== undefined && max !== undefined && min > max) fail(field, 'min must not exceed max');
    if (exclusiveMin !== undefined && max !== undefined && exclusiveMin >= max)
      fail(field, 'exclusiveMin must be less than max');
    optional(property.step, positiveNumber, `${field}.step`);
    if (
      typeof property.default === 'number' &&
      type === 'integer' &&
      !Number.isSafeInteger(property.default)
    )
      fail(`${field}.default`, 'must be a safe integer');
    if (typeof property.default === 'number') {
      if (min !== undefined && property.default < min)
        fail(`${field}.default`, 'must be greater than or equal to min');
      if (exclusiveMin !== undefined && property.default <= exclusiveMin)
        fail(`${field}.default`, 'must be greater than exclusiveMin');
      if (max !== undefined && property.default > max)
        fail(`${field}.default`, 'must be less than or equal to max');
    }
  }
  let normalizedDefault: string | undefined;
  if (type === 'color') {
    optional(
      property.alpha,
      (input, at) => {
        if (typeof input !== 'boolean') fail(at, 'must be a boolean');
      },
      `${field}.alpha`,
    );
    if (typeof property.default === 'string')
      normalizedDefault = normalizeColor(
        property.default,
        `${field}.default`,
        property.alpha === true,
      );
  }
  if (type === 'enum') {
    if (!Array.isArray(property.options) || property.options.length === 0)
      fail(`${field}.options`, 'must be a nonempty array');
    const values = new Set<string>();
    property.options.forEach((option, index) => {
      const entry = plain(option, `${field}.options[${index}]`);
      only(entry, ['value', 'label'], `${field}.options[${index}]`);
      const optionValue = text(entry.value, `${field}.options[${index}].value`);
      text(entry.label, `${field}.options[${index}].label`);
      if (values.has(optionValue)) fail(`${field}.options[${index}].value`, 'must be unique');
      values.add(optionValue);
    });
  }
  if (type === 'image' || type === 'binary') {
    optional(property.maxBytes, nonnegativeInteger, `${field}.maxBytes`);
    optional(property.maxPixels, nonnegativeInteger, `${field}.maxPixels`);
    if (type === 'binary') {
      optional(
        property.extensions,
        (input, at) => {
          if (!Array.isArray(input) || input.length === 0)
            fail(at, 'must be a nonempty array when declared');
          const seen = new Set<string>();
          input.forEach((extension, index) => {
            if (typeof extension !== 'string' || !/^\.[A-Za-z0-9]+$/.test(extension))
              fail(`${at}[${index}]`, 'must be a dotted ASCII extension such as ".bin"');
            const key = extension.toLowerCase();
            if (seen.has(key)) fail(`${at}[${index}]`, 'must be unique ignoring ASCII case');
            seen.add(key);
          });
        },
        `${field}.extensions`,
      );
    }
  }
  if (type === 'firmware') validateFirmwareProperty(property, field);
  return (normalizedDefault === undefined
    ? property
    : { ...property, default: normalizedDefault }) as unknown as DeviceProperty;
}

function validateFirmwareProperty(property: Record<string, unknown>, field: string): void {
  const spaces = property.addressSpaces;
  if (spaces === undefined) fail(`${field}.addressSpaces`, 'is required for firmware');
  const entries = plain(spaces, `${field}.addressSpaces`);
  if (Object.keys(entries).length === 0)
    fail(`${field}.addressSpaces`, 'must declare at least one address space');
  for (const [id, value] of Object.entries(entries)) {
    const space = plain(value, `${field}.addressSpaces.${id}`);
    only(space, ['title', 'start', 'size'], `${field}.addressSpaces.${id}`);
    optional(space.title, text, `${field}.addressSpaces.${id}.title`);
    nonnegativeInteger(space.start, `${field}.addressSpaces.${id}.start`);
    const size = nonnegativeInteger(space.size, `${field}.addressSpaces.${id}.size`);
    if (size === 0) fail(`${field}.addressSpaces.${id}.size`, 'must be positive');
    if (!Number.isSafeInteger((space.start as number) + size))
      fail(`${field}.addressSpaces.${id}`, 'start + size must be a safe integer');
  }
  const addressSpace = text(property.addressSpace, `${field}.addressSpace`);
  if (!Object.hasOwn(entries, addressSpace))
    fail(`${field}.addressSpace`, 'must reference a declared address space');
  const loadAddress = nonnegativeInteger(property.loadAddress, `${field}.loadAddress`);
  const space = entries[addressSpace] as Record<string, unknown>;
  const start = space.start as number;
  const size = space.size as number;
  if (loadAddress < start || loadAddress >= start + size)
    fail(`${field}.loadAddress`, 'must fall within the default address space');
}

function validateFirmwareDefault(
  value: unknown,
  property: Record<string, unknown>,
  field: string,
): void {
  const reference = plain(value, field);
  only(reference, ['src', 'mode', 'addressSpace', 'loadAddress'], field);
  if (reference.mode !== 'package')
    fail(`${field}.mode`, 'must be "package" for a package default');
  const src = packagePath(reference.src, `${field}.src`);
  const format = /\.(bin|hex|ihx|elf|axf)$/i.exec(src)?.[1]?.toLowerCase();
  if (format === undefined) fail(`${field}.src`, 'must use a known BIN, HEX or ELF file extension');
  const spaces = property.addressSpaces as Record<string, Record<string, unknown>> | undefined;
  const addressSpace =
    reference.addressSpace === undefined
      ? (property.addressSpace as string | undefined)
      : text(reference.addressSpace, `${field}.addressSpace`);
  if (addressSpace === undefined || !Object.hasOwn(spaces ?? {}, addressSpace))
    fail(`${field}.addressSpace`, 'must reference a declared address space');
  if ((format === 'elf' || format === 'axf') && reference.addressSpace !== undefined)
    fail(`${field}.addressSpace`, 'is not supported for ELF firmware');
  if ((format === 'elf' || format === 'axf') && reference.loadAddress !== undefined)
    fail(`${field}.loadAddress`, 'is not supported for ELF firmware');
  if (format !== 'bin' && reference.loadAddress !== undefined)
    fail(`${field}.loadAddress`, 'is only supported for BIN firmware');
  const space = (spaces ?? {})[addressSpace] as
    { readonly start: number; readonly size: number } | undefined;
  if (reference.loadAddress !== undefined && space !== undefined) {
    const loadAddress = nonnegativeInteger(reference.loadAddress, `${field}.loadAddress`);
    if (loadAddress < space.start || loadAddress >= space.start + space.size)
      fail(`${field}.loadAddress`, 'must fall within the selected address space');
  }
}

function validatePixelRect(value: unknown, field: string, positive: boolean): void {
  const rect = plain(value, field);
  only(rect, ['x', 'y', 'width', 'height'], field);
  for (const key of ['x', 'y'] as const) {
    if (typeof rect[key] !== 'number' || !Number.isFinite(rect[key]))
      fail(`${field}.${key}`, 'must be a finite number');
  }
  for (const key of ['width', 'height'] as const) {
    if (typeof rect[key] !== 'number' || !Number.isFinite(rect[key]))
      fail(`${field}.${key}`, 'must be a finite number');
    if (positive && (rect[key] as number) <= 0) fail(`${field}.${key}`, 'must be positive');
  }
}

function validatePoint(value: unknown, field: string): void {
  const point = plain(value, field);
  only(point, ['x', 'y'], field);
  for (const key of ['x', 'y'] as const) {
    if (typeof point[key] !== 'number' || !Number.isFinite(point[key]))
      fail(`${field}.${key}`, 'must be a finite number');
  }
}

/** Validates a parsed `Geometry2D` document or inline object. */
export function validateGeometry(value: unknown, field = 'view2d.geometry'): Geometry2D {
  const geometry = plain(value, field);
  only(geometry, ['sizing', 'bounds', 'bodyBounds', 'bodyImage', 'pins', 'designator'], field);
  if (geometry.sizing !== 'physical' && geometry.sizing !== 'flexible')
    fail(`${field}.sizing`, 'must be "physical" or "flexible"');
  validatePixelRect(geometry.bounds, `${field}.bounds`, true);
  validatePixelRect(geometry.bodyBounds, `${field}.bodyBounds`, true);
  const bounds = geometry.bounds as { x: number; y: number; width: number; height: number };
  const body = geometry.bodyBounds as { x: number; y: number; width: number; height: number };
  if (
    body.x < bounds.x ||
    body.y < bounds.y ||
    body.x + body.width > bounds.x + bounds.width ||
    body.y + body.height > bounds.y + bounds.height
  )
    fail(`${field}.bodyBounds`, 'must stay within bounds');
  if (geometry.bodyImage !== undefined) packagePath(geometry.bodyImage, `${field}.bodyImage`);
  if (geometry.designator !== undefined) validatePoint(geometry.designator, `${field}.designator`);
  const pins = plain(geometry.pins, `${field}.pins`);
  for (const [id, raw] of Object.entries(pins)) {
    if (!PIN.test(id)) fail(`${field}.pins.${id}`, 'must be a valid pin id');
    const pin = plain(raw, `${field}.pins.${id}`);
    only(pin, ['position', 'outward', 'label'], `${field}.pins.${id}`);
    validatePoint(pin.position, `${field}.pins.${id}.position`);
    const position = pin.position as { x: number; y: number };
    if (
      position.x < bounds.x ||
      position.y < bounds.y ||
      position.x > bounds.x + bounds.width ||
      position.y > bounds.y + bounds.height
    )
      fail(`${field}.pins.${id}.position`, 'must stay within bounds');
    const outward = plain(pin.outward, `${field}.pins.${id}.outward`);
    only(outward, ['x', 'y'], `${field}.pins.${id}.outward`);
    if (
      typeof outward.x !== 'number' ||
      typeof outward.y !== 'number' ||
      !Number.isFinite(outward.x) ||
      !Number.isFinite(outward.y) ||
      (outward.x === 0 && outward.y === 0)
    )
      fail(`${field}.pins.${id}.outward`, 'must be a finite nonzero vector');
    if (pin.label !== undefined) {
      const label = plain(pin.label, `${field}.pins.${id}.label`);
      only(label, ['position', 'visible'], `${field}.pins.${id}.label`);
      validatePoint(label.position, `${field}.pins.${id}.label.position`);
      if (label.visible !== undefined && typeof label.visible !== 'boolean')
        fail(`${field}.pins.${id}.label.visible`, 'must be a boolean');
    }
  }
  return geometry as unknown as Geometry2D;
}

function validateValueType(
  value: unknown,
  field: string,
  types: Readonly<Record<string, unknown>>,
): ValueType {
  const type = plain(value, field);
  if ('ref' in type) {
    only(type, ['ref'], field);
    const ref = text(type.ref, `${field}.ref`);
    if (!Object.hasOwn(types, ref)) fail(`${field}.ref`, `references unknown model type "${ref}"`);
    return { ref };
  }
  const kind = text(type.type, `${field}.type`);
  if (
    kind === 'null' ||
    kind === 'boolean' ||
    kind === 'number' ||
    kind === 'string' ||
    kind === 'binary'
  ) {
    only(type, ['type'], field);
    return { type: kind };
  }
  if (kind === 'array') {
    only(type, ['type', 'items'], field);
    return { type: 'array', items: validateValueType(type.items, `${field}.items`, types) };
  }
  if (kind === 'object') {
    only(type, ['type', 'properties', 'optional', 'additionalProperties'], field);
    const properties = plain(type.properties, `${field}.properties`);
    const rendered: Record<string, ValueType> = {};
    for (const [key, child] of Object.entries(properties)) {
      validateKey(key, `${field}.properties.${key}`);
      rendered[key] = validateValueType(child, `${field}.properties.${key}`, types);
    }
    const optional = type.optional;
    if (optional !== undefined) {
      if (!Array.isArray(optional)) fail(`${field}.optional`, 'must be an array');
      const seen = new Set<string>();
      optional.forEach((key, index) => {
        if (typeof key !== 'string' || !Object.hasOwn(properties, key))
          fail(`${field}.optional[${index}]`, 'must name a declared property');
        if (seen.has(key)) fail(`${field}.optional[${index}]`, 'must be unique');
        seen.add(key);
      });
    }
    return {
      type: 'object',
      properties: rendered,
      ...(optional === undefined ? {} : { optional: optional as string[] }),
      ...(type.additionalProperties === undefined
        ? {}
        : {
            additionalProperties: validateValueType(
              type.additionalProperties,
              `${field}.additionalProperties`,
              types,
            ),
          }),
    };
  }
  fail(`${field}.type`, 'must be one of null, boolean, number, string, binary, array, object');
}

function validateModelValue(
  value: unknown,
  field: string,
  types: Readonly<Record<string, unknown>>,
): ValueType {
  return validateValueType(value, field, types);
}

function validateMethod(
  value: unknown,
  field: string,
  types: Readonly<Record<string, unknown>>,
): MethodDefinition {
  const method = plain(value, field);
  only(method, ['params', 'returns'], field);
  return {
    params: validateModelValue(method.params, `${field}.params`, types),
    returns: validateModelValue(method.returns, `${field}.returns`, types),
  };
}

/** Validates the device fields of a parsed project-root `package.json`. */
export function validateDevicePackage(
  input: unknown,
  options: ValidateDevicePackageOptions = {},
): DevicePackageManifest {
  const manifest = plain(input, 'package.json');
  const publisher = text(manifest.publisher, 'publisher');
  if (!IDENTIFIER.test(publisher)) fail('publisher', 'must match [a-z0-9]+(?:-[a-z0-9]+)*');
  const name = text(manifest.name, 'name');
  if (!IDENTIFIER.test(name)) fail('name', 'must match [a-z0-9]+(?:-[a-z0-9]+)*');
  const version = text(manifest.version, 'version');
  if (parse(version)?.raw !== version || !/^[0-9]/.test(version))
    fail('version', 'must be a complete SemVer version');
  const engines = plain(manifest.engines, 'engines');
  only(engines, ['mica'], 'engines');
  const micaRange = text(engines.mica, 'engines.mica');
  if (micaRange.trim() !== micaRange || validRange(micaRange) === null)
    fail('engines.mica', 'must be a valid SemVer range');
  if (options.sdkVersion !== undefined && !satisfiesVersion(options.sdkVersion, micaRange))
    fail('engines.mica', `must include the host SDK version ${options.sdkVersion}`);
  const displayName = text(manifest.displayName, 'displayName');
  optional(manifest.description, text, 'description');
  optional(manifest.license, text, 'license');
  if (manifest.icon !== undefined) {
    const icon = packagePath(manifest.icon, 'icon');
    if (!/\.(?:png|svg)$/.test(icon)) fail('icon', 'must be a PNG or SVG file');
  }
  optional(manifest.designatorPrefix, text, 'designatorPrefix');

  let entries: Record<string, string> | undefined;
  if (manifest.entries !== undefined) {
    const source = plain(manifest.entries, 'entries');
    only(source, ['view3d'], 'entries');
    entries = {};
    for (const [key, path] of Object.entries(source))
      entries[key] = packagePath(path, `entries.${key}`, '.js');
  }

  let properties: Record<string, DeviceProperty> | undefined;
  if (manifest.properties !== undefined) {
    const source = plain(manifest.properties, 'properties');
    properties = {};
    for (const [key, property] of Object.entries(source)) {
      validateKey(key, `properties.${key}`);
      properties[key] = validateProperty(property, `properties.${key}`);
    }
  }

  let pins: Record<string, DevicePin> | undefined;
  if (manifest.pins !== undefined) {
    const source = plain(manifest.pins, 'pins');
    pins = {};
    for (const [key, raw] of Object.entries(source)) {
      if (!PIN.test(key)) fail(`pins.${key}`, 'must be a valid pin id');
      const pin = plain(raw, `pins.${key}`);
      only(pin, ['label', 'description'], `pins.${key}`);
      optional(pin.label, text, `pins.${key}.label`);
      optional(pin.description, text, `pins.${key}.description`);
      pins[key] = pin as unknown as DevicePin;
    }
  }

  let model: ModelDefinition | undefined;
  if (manifest.model !== undefined) {
    const source = plain(manifest.model, 'model');
    only(source, ['entry', 'types', 'methods', 'events'], 'model');
    const entry = packagePath(source.entry, 'model.entry', '.js');
    const types: Record<string, unknown> = {};
    if (source.types !== undefined) {
      const rawTypes = plain(source.types, 'model.types');
      for (const [key, value] of Object.entries(rawTypes)) {
        validateKey(key, `model.types.${key}`);
        types[key] = value;
      }
    }
    const renderedTypes: Record<string, ValueType> = {};
    for (const [key, value] of Object.entries(types))
      renderedTypes[key] = validateModelValue(value, `model.types.${key}`, types);
    const methods: Record<string, MethodDefinition> = {};
    if (source.methods !== undefined) {
      const rawMethods = plain(source.methods, 'model.methods');
      for (const [key, value] of Object.entries(rawMethods)) {
        validateKey(key, `model.methods.${key}`);
        methods[key] = validateMethod(value, `model.methods.${key}`, types);
      }
    }
    const events: Record<string, ValueType> = {};
    if (source.events !== undefined) {
      const rawEvents = plain(source.events, 'model.events');
      for (const [key, value] of Object.entries(rawEvents)) {
        if (!EVENT.test(key)) fail(`model.events.${key}`, 'must match onDidXxx');
        events[key] = validateModelValue(value, `model.events.${key}`, types);
      }
    }
    model = {
      entry,
      ...(source.types === undefined ? {} : { types: renderedTypes }),
      ...(source.methods === undefined ? {} : { methods }),
      ...(source.events === undefined ? {} : { events }),
    };
  } else if (pins !== undefined && Object.keys(pins).length > 0) {
    fail('model', 'is required when pins are declared');
  }

  let view2d: DeviceView2DDefinition | undefined;
  if (manifest.view2d !== undefined) {
    const source = plain(manifest.view2d, 'view2d');
    only(source, ['geometry', 'entry'], 'view2d');
    if (source.geometry === undefined) fail('view2d.geometry', 'is required');
    const geometry =
      typeof source.geometry === 'string'
        ? packagePath(source.geometry, 'view2d.geometry', '.json')
        : validateGeometry(source.geometry);
    view2d = {
      geometry,
      ...(source.entry === undefined
        ? {}
        : { entry: packagePath(source.entry, 'view2d.entry', '.js') }),
    };
  }

  let view: Record<string, DeviceViewEntry> | undefined;
  if (manifest.view !== undefined) {
    const source = plain(manifest.view, 'view');
    view = {};
    for (const [id, raw] of Object.entries(source)) {
      validateKey(id, `view.${id}`);
      const entry = plain(raw, `view.${id}`);
      only(entry, ['title', 'entry', 'defaultLocation', 'icon'], `view.${id}`);
      const title = text(entry.title, `view.${id}.title`);
      const html = packagePath(entry.entry, `view.${id}.entry`, '.html');
      if (
        entry.defaultLocation !== undefined &&
        entry.defaultLocation !== 'sidebar' &&
        entry.defaultLocation !== 'floating'
      )
        fail(`view.${id}.defaultLocation`, 'must be "sidebar" or "floating"');
      optional(entry.icon, text, `view.${id}.icon`);
      view[id] = {
        title,
        entry: html,
        ...(entry.defaultLocation === undefined ? {} : { defaultLocation: entry.defaultLocation }),
        ...(entry.icon === undefined ? {} : { icon: entry.icon as string }),
      };
    }
  }

  const result: DevicePackageManifest = {
    publisher,
    name,
    version,
    ...(manifest.description === undefined ? {} : { description: manifest.description as string }),
    ...(manifest.license === undefined ? {} : { license: manifest.license as string }),
    engines: { mica: micaRange },
    displayName,
    ...(manifest.icon === undefined ? {} : { icon: manifest.icon as string }),
    ...(manifest.designatorPrefix === undefined
      ? {}
      : { designatorPrefix: manifest.designatorPrefix as string }),
    ...(entries === undefined ? {} : { entries }),
    ...(properties === undefined ? {} : { properties }),
    ...(pins === undefined ? {} : { pins }),
    ...(model === undefined ? {} : { model }),
    ...(view2d === undefined ? {} : { view2d }),
    ...(view === undefined ? {} : { view }),
  };
  validateResourcePaths(result);
  return result;
}

/** Validates generated entry paths and static-resource references. */
function validateResourcePaths(manifest: DevicePackageManifest): void {
  const entries: string[] = [];
  if (manifest.view2d?.entry !== undefined) entries.push(manifest.view2d.entry);
  if (manifest.model !== undefined) entries.push(manifest.model.entry);
  for (const entry of Object.values(manifest.entries ?? {})) entries.push(entry);
  const seenEntries = new Set<string>();
  for (const path of entries) {
    if (seenEntries.has(path)) fail('files', `duplicates generated entry ${path}`);
    seenEntries.add(path);
  }

  const resources: string[] = [];
  if (manifest.icon !== undefined) resources.push(manifest.icon);
  const geometry = manifest.view2d?.geometry;
  if (typeof geometry === 'string') resources.push(geometry);
  for (const entry of Object.values(manifest.view ?? {})) resources.push(entry.entry);
  for (const property of Object.values(manifest.properties ?? {})) {
    const reference = property.default;
    if (
      (property.type === 'image' || property.type === 'binary' || property.type === 'firmware') &&
      reference !== null &&
      reference !== undefined &&
      typeof reference === 'object' &&
      'src' in reference &&
      'mode' in reference &&
      (reference as ResourceReference).mode === 'package'
    )
      resources.push((reference as ResourceReference).src);
  }
  for (const path of resources) {
    if (seenEntries.has(path)) fail('files', `resource ${path} collides with a generated entry`);
  }
}

/** Checks `engines.mica` with the standard SemVer implementation. */
export function satisfiesVersion(version: string, range: string): boolean {
  return (
    parse(version)?.raw === version &&
    /^[0-9]/.test(version) &&
    validRange(range) !== null &&
    satisfies(version, range)
  );
}

function ddlTypeName(name: string): string {
  return `Ddl_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function renderDdlType(
  type: ValueTypeIR,
  declarations: ReadonlyMap<string, DeclarationIR>,
  input: boolean,
): string {
  switch (type.kind) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'bool':
      return 'boolean';
    case 'bytes':
      return input ? 'Uint8Array' : 'ReadonlyBytes';
    case 'optional':
      return `${renderDdlType(type.inner, declarations, input)} | null`;
    case 'enum':
      if (type.name === 'Logic') return '"low" | "high" | "unknown"';
      if (type.name === 'SampleStatus') return '"valid" | "floating"';
      if (type.name === 'Overflow') return '"drop_new" | "drop_oldest" | "error"';
      return ddlTypeName(type.name);
    case 'record':
      void declarations;
      return ddlTypeName(type.name);
    case 'sample':
    case 'intent':
      throw new TypeError(`DDL type ${type.kind} cannot cross the model boundary`);
  }
}

function renderPayloadType(type: ValueType, types: Readonly<Record<string, ValueType>>): string {
  if ('ref' in type) return `Model_${type.ref}`;
  switch (type.type) {
    case 'null':
      return 'null';
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'binary':
      return 'Uint8Array';
    case 'array':
      return `readonly ${renderPayloadType(type.items, types)}[]`;
    case 'object': {
      const fields = Object.entries(type.properties).map(([key, value]) => {
        const optional = type.optional?.includes(key) ? '?' : '';
        return `readonly ${JSON.stringify(key)}${optional}: ${renderPayloadType(value, types)};`;
      });
      const object = `{ ${fields.join(' ')} }`;
      if (type.additionalProperties === undefined) return object;
      // TypeScript cannot subtract known literal keys from `string`. Widen the index
      // signature to the union of known value types and the additional value type so the
      // generated type remains instantiable; known keys keep their precise types.
      const known = Object.values(type.properties).map((value) => renderPayloadType(value, types));
      if (type.optional !== undefined && type.optional.length > 0) known.push('undefined');
      known.push(renderPayloadType(type.additionalProperties, types));
      return `${object} & { readonly [key: string]: ${[...new Set(known)].join(' | ')} }`;
    }
  }
}

function renderPropertyType(property: DeviceProperty): string {
  let type: string;
  switch (property.type) {
    case 'string':
    case 'color':
      type = 'string';
      break;
    case 'integer':
    case 'number':
      type = 'number';
      break;
    case 'boolean':
      type = 'boolean';
      break;
    case 'enum':
      type =
        property.options === undefined
          ? 'never'
          : property.options.map((option) => JSON.stringify(option.value)).join(' | ');
      break;
    case 'image':
    case 'binary':
      type = 'ReadonlyBytes';
      break;
    case 'firmware':
      type = 'FirmwareImage';
      break;
  }
  return property.nullable === true ? `${type} | null` : type;
}

function ddlTypeCompatible(
  type: ValueTypeIR,
  property: DeviceProperty,
  declarations: ReadonlyMap<string, DeclarationIR>,
): boolean {
  if (type.kind === 'optional') {
    if (property.nullable !== true) return false;
    return ddlTypeCompatible(type.inner, { ...property, nullable: false }, declarations);
  }
  if (property.nullable === true) return false;
  switch (property.type) {
    case 'number':
    case 'integer':
      return type.kind === 'number';
    case 'string':
    case 'color':
      return type.kind === 'string';
    case 'boolean':
      return type.kind === 'bool';
    case 'image':
    case 'binary':
      return type.kind === 'bytes';
    case 'enum': {
      if (type.kind !== 'enum') return false;
      const declared = declarations.get(type.name) as
        Extract<DeclarationIR, { kind: 'enum' }> | undefined;
      if (declared === undefined) return false;
      const values = new Set(property.options?.map((option) => option.value));
      return (
        declared.members.length === values.size &&
        declared.members.every((member) => values.has(member))
      );
    }
    case 'firmware':
      return false;
  }
}

function literalDefault(computation: DeviceIR['declarations'][number] | undefined): unknown {
  if (computation === undefined || !('default' in computation)) return undefined;
  const operations = computation.default?.body.operations;
  if (operations === undefined) return Symbol.for('unresolved');
  const constant = operations.find((operation) => operation.kind === 'constant');
  if (constant?.kind !== 'constant') return Symbol.for('unresolved');
  const returned = operations.some(
    (operation) => operation.kind === 'returnValue' && operation.value === constant.result,
  );
  if (!returned) return Symbol.for('unresolved');
  switch (constant.constant.kind) {
    case 'number':
    case 'string':
    case 'bool':
      return constant.constant.value;
    case 'none':
      return null;
    case 'bytes':
      return new Uint8Array(constant.constant.value);
    default:
      return Symbol.for('unresolved');
  }
}

function sameDefault(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null && right == null) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => sameDefault(value, right[index]))
    );
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right, key) &&
          sameDefault(
            (left as Record<string, unknown>)[key],
            (right as Record<string, unknown>)[key],
          ),
      )
    );
  }
  return false;
}

/** Validates the compiled IR against the manifest interface, properties and pins. */
export function validateDevicePackageModel(
  manifest: DevicePackageManifest,
  model: DeviceIR,
  geometry?: Geometry2D,
): void {
  const declarations = new Map(
    model.declarations
      .filter(
        (declaration): declaration is DeclarationIR & { name: string } => 'name' in declaration,
      )
      .map((declaration) => [declaration.name, declaration]),
  );
  const modelPins = model.declarations
    .filter(
      (declaration): declaration is Extract<DeclarationIR, { kind: 'pin' }> =>
        declaration.kind === 'pin',
    )
    .map((declaration) => declaration.name)
    .sort();
  const manifestPins = Object.keys(manifest.pins ?? {}).sort();
  if (
    modelPins.length !== manifestPins.length ||
    modelPins.some((pin, index) => pin !== manifestPins[index])
  )
    fail(
      'pins',
      `must match the model pins exactly (manifest: ${manifestPins.join(', ') || 'none'}; model: ${modelPins.join(', ') || 'none'})`,
    );

  for (const declaration of model.declarations) {
    if (declaration.kind !== 'property') continue;
    const property = manifest.properties?.[declaration.name];
    if (property === undefined)
      fail(`properties.${declaration.name}`, 'is used by the model but missing from the manifest');
    if (property.type === 'firmware')
      fail(`properties.${declaration.name}`, 'firmware properties must not be declared in DDL');
    if (!ddlTypeCompatible(declaration.type, property, declarations))
      fail(
        `properties.${declaration.name}`,
        'type or nullability does not match the DDL property declaration',
      );
    if (property.type !== 'image' && property.type !== 'binary') {
      const value = literalDefault(declaration);
      if (value !== Symbol.for('unresolved')) {
        const manifestDefault = property.default;
        if (!sameDefault(value, manifestDefault))
          fail(`properties.${declaration.name}.default`, 'does not match the DDL property default');
      } else if ((declaration.default !== undefined) !== (property.default !== undefined)) {
        fail(
          `properties.${declaration.name}.default`,
          'presence does not match the DDL property default',
        );
      }
    }
  }

  if (geometry !== undefined) {
    const geometryPins = Object.keys(geometry.pins).sort();
    if (
      geometryPins.length !== manifestPins.length ||
      geometryPins.some((pin, index) => pin !== manifestPins[index])
    )
      fail(
        'view2d.geometry.pins',
        `must match the device pins exactly (device: ${manifestPins.join(', ') || 'none'}; geometry: ${geometryPins.join(', ') || 'none'})`,
      );
  }
}

/** Renders `.mica/device.d.ts` for one validated device project. */
export function generateDeviceDeclaration(
  manifest: DevicePackageManifest,
  model: DeviceIR,
): string {
  const declarations = new Map(
    model.declarations
      .filter(
        (declaration): declaration is DeclarationIR & { name: string } => 'name' in declaration,
      )
      .map((declaration) => [declaration.name, declaration]),
  );
  const lines: string[] = [
    "import type { BorrowedBytes, ChannelMessage, DeviceBatch, DeviceContext, FirmwareImage, InputChannel, InputNotification, ModelClient, ModelContext, ModelInstance, Notification, ReadonlyBytes } from '@mica-js/sdk/device';",
    '',
  ];
  for (const declaration of model.declarations) {
    if (declaration.kind === 'enum') {
      lines.push(
        `type ${ddlTypeName(declaration.name)} = ${declaration.members.map((member) => JSON.stringify(member)).join(' | ')};`,
      );
    } else if (declaration.kind === 'record') {
      lines.push(`type ${ddlTypeName(declaration.name)} = {`);
      for (const field of declaration.fields)
        lines.push(
          `  readonly ${JSON.stringify(field.name)}: ${field.type === 'bool' ? 'boolean' : 'number'};`,
        );
      lines.push('};');
    }
  }
  if (
    model.declarations.some(
      (declaration) => declaration.kind === 'enum' || declaration.kind === 'record',
    )
  )
    lines.push('');

  const types = manifest.model?.types ?? {};
  for (const [name, type] of Object.entries(types)) {
    lines.push(`type Model_${name} = ${renderPayloadType(type, types)};`);
  }
  if (Object.keys(types).length > 0) lines.push('');

  lines.push('type DeviceInputs = {');
  for (const declaration of model.declarations) {
    if (declaration.kind === 'channel' && declaration.direction === 'input')
      lines.push(
        `  readonly ${JSON.stringify(declaration.name)}: InputChannel<${renderDdlType(declaration.type, declarations, true)}>;`,
      );
    else if (declaration.kind === 'notification' && declaration.direction === 'input')
      lines.push(`  readonly ${JSON.stringify(declaration.name)}: InputNotification;`);
  }
  if (!lines.at(-1)?.endsWith(';'))
    lines[lines.length - 1] = 'type DeviceInputs = Record<never, never>;';
  else lines.push('};');

  lines.push('type DeviceMemory = {');
  const memoryStart = lines.length;
  for (const declaration of model.declarations) {
    if (declaration.kind === 'memory' && declaration.public)
      lines.push(`  readonly ${JSON.stringify(declaration.name)}: BorrowedBytes;`);
  }
  if (lines.length === memoryStart)
    lines[lines.length - 1] = 'type DeviceMemory = Record<never, never>;';
  else lines.push('};');

  lines.push('type DeviceOutputs = {');
  const outputStart = lines.length;
  for (const declaration of model.declarations) {
    if (declaration.kind === 'channel' && declaration.direction === 'output')
      lines.push(
        `  readonly ${JSON.stringify(declaration.name)}: readonly ChannelMessage<${renderDdlType(declaration.type, declarations, false)}>[];`,
      );
    else if (declaration.kind === 'notification' && declaration.direction === 'output')
      lines.push(`  readonly ${JSON.stringify(declaration.name)}: Notification | null;`);
  }
  if (lines.length === outputStart)
    lines[lines.length - 1] = 'type DeviceOutputs = Record<never, never>;';
  else lines.push('};');

  lines.push(
    'type CoreContext = DeviceContext<DeviceProps, DeviceInputs, DeviceMemory>;',
    'type Batch = DeviceBatch<DeviceOutputs>;',
    '',
  );

  const properties = Object.entries(manifest.properties ?? {})
    .map(([key, property]) => `  readonly ${JSON.stringify(key)}: ${renderPropertyType(property)};`)
    .join('\n');
  const methods = Object.entries(manifest.model?.methods ?? {})
    .map(
      ([key, method]) =>
        `  readonly ${JSON.stringify(key)}: (params: ${renderPayloadType(method.params, types)}) => ${renderPayloadType(method.returns, types)};`,
    )
    .join('\n');
  const events = Object.entries(manifest.model?.events ?? {})
    .map(([key, type]) => `  readonly ${JSON.stringify(key)}: ${renderPayloadType(type, types)};`)
    .join('\n');
  const pins = Object.keys(manifest.pins ?? {})
    .map((pin) => JSON.stringify(pin))
    .join(' | ');

  lines.push(
    'declare global {',
    `  type DeviceProps = {`,
    properties,
    '  };',
    `  type DeviceMethods = {`,
    methods,
    '  };',
    `  type DeviceEvents = {`,
    events,
    '  };',
    '  type DeviceModelContext = ModelContext<CoreContext, DeviceProps, DeviceEvents>;',
    '  type DeviceFactory = (context: DeviceModelContext) => ModelInstance<DeviceMethods, Batch>;',
    '  type DeviceClient = ModelClient<DeviceMethods, DeviceEvents>;',
    `  type DevicePinId = ${pins.length === 0 ? 'never' : pins};`,
    '}',
    '',
  );
  return lines.join('\n');
}

/** Renders `.mica/tsconfig.json`; authors extend it from the project root. */
export function generateDeviceTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2023', 'DOM'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowArbitraryExtensions: true,
        verbatimModuleSyntax: true,
      },
      files: ['./device.d.ts'],
      include: ['../src', '../views'],
    },
    null,
    2,
  )}\n`;
}
