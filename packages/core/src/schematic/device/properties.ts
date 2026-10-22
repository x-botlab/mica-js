import { isAssetReference } from '../../format/value';
import type { PropertyValue } from '../../format/value';
import { isRecord } from '../../format/validate';

/** Property value types a device may declare (#7). */
export const PROPERTY_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'color',
  'enum',
  'image',
  'binary',
] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface PropertyOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Descriptor of one device property (#7). `default` is the declared default, `title` falls back to
 * the key, and the remaining fields carry the constraints of the type.
 */
export interface PropertyDescriptor {
  readonly key: string;
  readonly type: PropertyType;
  readonly title?: string;
  readonly description?: string;
  /** Declared default; absent when the description omits it or it breaks its own constraints. */
  readonly default?: PropertyValue;
  /** When true an explicit `null` is a valid instance value. */
  readonly nullable?: boolean;
  /** `string`: maximum length in Unicode code points. */
  readonly maxLength?: number;
  /** `integer` / `number`: closed lower bound. */
  readonly min?: number;
  /** `integer` / `number`: closed upper bound. */
  readonly max?: number;
  /** `number`: open lower bound; mutually exclusive with `min`. */
  readonly exclusiveMin?: number;
  /** `integer` / `number`: editing step, always greater than zero. */
  readonly step?: number;
  /** `number`: display unit of the stored value. */
  readonly unit?: string;
  /** `color`: whether `#RRGGBBAA` values are accepted. */
  readonly alpha?: boolean;
  /** `enum`: non-empty option list. */
  readonly options?: readonly PropertyOption[];
  /** `image` / `binary`: host-side payload limit in bytes. */
  readonly maxBytes?: number;
  /** `image`: host-side pixel limit. */
  readonly maxPixels?: number;
}

export interface PropertyValueProblem {
  readonly code: 'schema/invalid-type' | 'schema/invalid-value';
  readonly message: string;
}

const COLOR_PATTERN = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isPropertyType(value: unknown): value is PropertyType {
  return typeof value === 'string' && (PROPERTY_TYPES as readonly string[]).includes(value);
}

/** Uppercases a `#RRGGBB` / `#RRGGBBAA` color; `undefined` when the text is not a color. */
export function normalizeColor(value: string): string | undefined {
  return COLOR_PATTERN.test(value) ? value.toUpperCase() : undefined;
}

/** Parses one declared property; `undefined` when the type is unknown or the descriptor unusable. */
export function parsePropertyDescriptor(key: string, raw: unknown): PropertyDescriptor | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const type = raw['type'];
  if (!isPropertyType(type)) {
    return undefined;
  }
  const draft: {
    -readonly [K in keyof PropertyDescriptor]: PropertyDescriptor[K];
  } = { key, type };

  const title = readText(raw['title']);
  if (title !== undefined) {
    draft.title = title;
  }
  const description = readText(raw['description']);
  if (description !== undefined) {
    draft.description = description;
  }
  if (raw['nullable'] === true) {
    draft.nullable = true;
  }

  if (type === 'string') {
    const maxLength = readCount(raw['maxLength']);
    if (maxLength !== undefined) {
      draft.maxLength = maxLength;
    }
  }
  if (type === 'integer' || type === 'number') {
    const min = readFinite(raw['min']);
    if (min !== undefined) {
      draft.min = min;
    }
    const max = readFinite(raw['max']);
    if (max !== undefined) {
      draft.max = max;
    }
    const step = readFinite(raw['step']);
    if (step !== undefined && step > 0) {
      draft.step = step;
    }
    if (type === 'number') {
      const exclusiveMin = readFinite(raw['exclusiveMin']);
      if (exclusiveMin !== undefined) {
        draft.exclusiveMin = exclusiveMin;
      }
      const unit = readText(raw['unit']);
      if (unit !== undefined) {
        draft.unit = unit;
      }
    }
  }
  if (type === 'color' && raw['alpha'] === true) {
    draft.alpha = true;
  }
  if (type === 'enum') {
    const options = readOptions(raw['options']);
    if (options === undefined) {
      return undefined;
    }
    draft.options = options;
  }
  if (type === 'image' || type === 'binary') {
    const maxBytes = readCount(raw['maxBytes']);
    if (maxBytes !== undefined) {
      draft.maxBytes = maxBytes;
    }
    if (type === 'image') {
      const maxPixels = readCount(raw['maxPixels']);
      if (maxPixels !== undefined) {
        draft.maxPixels = maxPixels;
      }
    }
  }

  const defaultValue = raw['default'];
  if (defaultValue !== undefined && propertyValueProblem(draft, defaultValue) === undefined) {
    draft.default = defaultValue as PropertyValue;
  }
  return draft;
}

/** Parses the `properties` object of a device description, skipping unusable declarations. */
export function readPropertyDescriptors(raw: unknown): ReadonlyMap<string, PropertyDescriptor> {
  const descriptors = new Map<string, PropertyDescriptor>();
  if (!isRecord(raw)) {
    return descriptors;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0) {
      continue;
    }
    const descriptor = parsePropertyDescriptor(key, value);
    if (descriptor !== undefined) {
      descriptors.set(key, descriptor);
    }
  }
  return descriptors;
}

/** Constraint violation of `value` for `descriptor`; `undefined` when the value is acceptable. */
export function propertyValueProblem(
  descriptor: PropertyDescriptor,
  value: unknown,
): PropertyValueProblem | undefined {
  const key = descriptor.key;
  if (value === null) {
    return descriptor.nullable === true
      ? undefined
      : { code: 'schema/invalid-value', message: `Property "${key}" is not nullable.` };
  }
  switch (descriptor.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return { code: 'schema/invalid-type', message: `Property "${key}" must be a string.` };
      }
      const maxLength = descriptor.maxLength;
      if (maxLength !== undefined && [...value].length > maxLength) {
        return {
          code: 'schema/invalid-value',
          message: `Property "${key}" must be at most ${String(maxLength)} characters.`,
        };
      }
      return undefined;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return {
          code: 'schema/invalid-type',
          message: `Property "${key}" must be a safe integer.`,
        };
      }
      return boundProblem(descriptor, value);
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return {
          code: 'schema/invalid-type',
          message: `Property "${key}" must be a finite number.`,
        };
      }
      if (descriptor.exclusiveMin !== undefined && value <= descriptor.exclusiveMin) {
        return {
          code: 'schema/invalid-value',
          message: `Property "${key}" must be greater than ${String(descriptor.exclusiveMin)}.`,
        };
      }
      return boundProblem(descriptor, value);
    }
    case 'boolean':
      return typeof value === 'boolean'
        ? undefined
        : { code: 'schema/invalid-type', message: `Property "${key}" must be a boolean.` };
    case 'color': {
      if (typeof value !== 'string') {
        return { code: 'schema/invalid-type', message: `Property "${key}" must be a string.` };
      }
      const normalized = normalizeColor(value);
      if (normalized === undefined) {
        return {
          code: 'schema/invalid-value',
          message: `Property "${key}" must be a "#RRGGBB" color.`,
        };
      }
      if (descriptor.alpha !== true && normalized.length === 9) {
        return {
          code: 'schema/invalid-value',
          message: `Property "${key}" does not accept alpha; use "#RRGGBB".`,
        };
      }
      return undefined;
    }
    case 'enum': {
      if (typeof value !== 'string') {
        return { code: 'schema/invalid-type', message: `Property "${key}" must be a string.` };
      }
      const allowed = (descriptor.options ?? []).map((option) => option.value);
      return allowed.includes(value)
        ? undefined
        : {
            code: 'schema/invalid-value',
            message: `Property "${key}" must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}.`,
          };
    }
    case 'image':
    case 'binary':
      return isAssetReference(value)
        ? undefined
        : {
            code: 'schema/invalid-type',
            message: `Property "${key}" must be a resource reference { "src", "mode" }.`,
          };
  }
}

/** Canonical stored value: colors are uppercased, everything else is stored as given. */
export function normalizePropertyValue(
  descriptor: PropertyDescriptor,
  value: PropertyValue,
): PropertyValue {
  if (descriptor.type === 'color' && typeof value === 'string') {
    return normalizeColor(value) ?? value;
  }
  return value;
}

function boundProblem(
  descriptor: PropertyDescriptor,
  value: number,
): PropertyValueProblem | undefined {
  const key = descriptor.key;
  if (descriptor.min !== undefined && value < descriptor.min) {
    return {
      code: 'schema/invalid-value',
      message: `Property "${key}" must be at least ${String(descriptor.min)}.`,
    };
  }
  if (descriptor.max !== undefined && value > descriptor.max) {
    return {
      code: 'schema/invalid-value',
      message: `Property "${key}" must be at most ${String(descriptor.max)}.`,
    };
  }
  return undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readOptions(value: unknown): readonly PropertyOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const options: PropertyOption[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const optionValue = entry['value'];
    const label = entry['label'];
    if (
      typeof optionValue !== 'string' ||
      optionValue.length === 0 ||
      typeof label !== 'string' ||
      label.length === 0 ||
      seen.has(optionValue)
    ) {
      return undefined;
    }
    seen.add(optionValue);
    options.push({ value: optionValue, label });
  }
  return options;
}
