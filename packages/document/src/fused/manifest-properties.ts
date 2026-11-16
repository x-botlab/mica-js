/**
 * Property descriptions of a unified device manifest (RFC 0009, extended by RFC 0020 and
 * RFC 0026). Descriptions and defaults are validated and rejected instead of being ignored.
 */
import type { FusedDiagnostic } from './diagnostics';
import type {
  DevicePropertyDescriptor,
  DevicePropertyType,
  FirmwareAddressSpace,
  PropertyOption,
} from './types/manifest';
import type { PropertyValue } from './types/property';
import { isExtensionFilter, isMemberKey, normalizeColor, packagePathProblem } from './rules';
import {
  forbidUnknownFields,
  hasOwn,
  isRecord,
  readArrayField,
  readBooleanField,
  readIntegerField,
  readNumberField,
  readObjectField,
  readStringField,
  report,
} from './read';

const PROPERTY_TYPES: readonly DevicePropertyType[] = [
  'string',
  'integer',
  'number',
  'boolean',
  'color',
  'enum',
  'image',
  'binary',
  'firmware',
];

const COMMON_FIELDS = ['type', 'title', 'description', 'default', 'nullable', 'group', 'order'];

const TYPE_FIELDS: Readonly<Record<DevicePropertyType, readonly string[]>> = {
  string: [...COMMON_FIELDS, 'maxLength'],
  integer: [...COMMON_FIELDS, 'min', 'max', 'step'],
  number: [...COMMON_FIELDS, 'min', 'max', 'exclusiveMin', 'step', 'unit'],
  boolean: COMMON_FIELDS,
  color: [...COMMON_FIELDS, 'alpha'],
  enum: [...COMMON_FIELDS, 'options'],
  image: [...COMMON_FIELDS, 'maxBytes', 'maxPixels'],
  binary: [...COMMON_FIELDS, 'maxBytes', 'extensions'],
  firmware: [...COMMON_FIELDS, 'maxBytes', 'addressSpaces', 'addressSpace', 'loadAddress'],
};

type DraftDescriptor = {
  -readonly [K in keyof DevicePropertyDescriptor]: DevicePropertyDescriptor[K];
};

export function isDevicePropertyType(value: string): value is DevicePropertyType {
  return (PROPERTY_TYPES as readonly string[]).includes(value);
}

/** Reads the `properties` map of a manifest. */
export function readPropertyDescriptors(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): Readonly<Record<string, DevicePropertyDescriptor>> | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "properties" must be an object.', path);
    return undefined;
  }
  const descriptors: Record<string, DevicePropertyDescriptor> = Object.create(null) as Record<
    string,
    DevicePropertyDescriptor
  >;
  let failed = false;
  for (const [key, raw] of Object.entries(value)) {
    const descriptorPath = [...path, key];
    if (!isMemberKey(key)) {
      report(
        diagnostics,
        'package/invalid-manifest',
        `Property key ${JSON.stringify(key)} must match [A-Za-z][A-Za-z0-9]*.`,
        descriptorPath,
      );
      failed = true;
      continue;
    }
    const descriptor = readPropertyDescriptor(raw, descriptorPath, diagnostics);
    if (descriptor === undefined) {
      failed = true;
      continue;
    }
    descriptors[key] = descriptor;
  }
  return failed ? undefined : descriptors;
}

function readPropertyDescriptor(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): DevicePropertyDescriptor | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Property description must be an object.', path);
    return undefined;
  }
  const type = readStringField(value, 'type', path, diagnostics, true, { nonEmpty: true });
  if (type === undefined) {
    return undefined;
  }
  if (!isDevicePropertyType(type)) {
    report(
      diagnostics,
      'package/invalid-manifest',
      `Unknown property type ${JSON.stringify(type)}.`,
      [...path, 'type'],
    );
    return undefined;
  }
  forbidUnknownFields(value, TYPE_FIELDS[type], path, diagnostics);

  const draft: DraftDescriptor = { type };
  let failed = false;

  const title = readStringField(value, 'title', path, diagnostics, false, { nonEmpty: true });
  if (title !== undefined) {
    draft.title = title;
  }
  const description = readStringField(value, 'description', path, diagnostics, false, {
    nonEmpty: true,
  });
  if (description !== undefined) {
    draft.description = description;
  }
  const group = readStringField(value, 'group', path, diagnostics, false, { nonEmpty: true });
  if (group !== undefined) {
    draft.group = group;
  }
  const nullable = readBooleanField(value, 'nullable', path, diagnostics, false);
  if (nullable === true) {
    draft.nullable = true;
  }
  if (hasOwn(value, 'order')) {
    const order = readIntegerField(value, 'order', path, diagnostics);
    if (order === undefined) {
      failed = true;
    } else if (order < 0) {
      report(
        diagnostics,
        'package/invalid-manifest',
        'Field "order" must be a non-negative integer.',
        [...path, 'order'],
      );
      failed = true;
    } else {
      draft.order = order;
    }
  }

  switch (type) {
    case 'string': {
      const maxLength = readCount(value, 'maxLength', path, diagnostics);
      if (maxLength === 'invalid') {
        failed = true;
      } else if (maxLength !== undefined) {
        draft.maxLength = maxLength;
      }
      break;
    }
    case 'integer':
    case 'number': {
      if (!readBounds(value, type, path, diagnostics, draft)) {
        failed = true;
      }
      if (type === 'number') {
        const unit = readStringField(value, 'unit', path, diagnostics, false, { nonEmpty: true });
        if (unit !== undefined) {
          draft.unit = unit;
        }
      }
      break;
    }
    case 'color': {
      if (readBooleanField(value, 'alpha', path, diagnostics, false) === true) {
        draft.alpha = true;
      }
      break;
    }
    case 'enum': {
      const options = readOptions(value, path, diagnostics);
      if (options === undefined) {
        failed = true;
      } else {
        draft.options = options;
      }
      break;
    }
    case 'image':
    case 'binary':
    case 'firmware': {
      const maxBytes = readCount(value, 'maxBytes', path, diagnostics);
      if (maxBytes === 'invalid') {
        failed = true;
      } else if (maxBytes !== undefined) {
        draft.maxBytes = maxBytes;
      }
      if (type === 'image') {
        const maxPixels = readCount(value, 'maxPixels', path, diagnostics);
        if (maxPixels === 'invalid') {
          failed = true;
        } else if (maxPixels !== undefined) {
          draft.maxPixels = maxPixels;
        }
      }
      if (type === 'binary') {
        const extensions = readExtensions(value, path, diagnostics);
        if (extensions === 'invalid') {
          failed = true;
        } else if (extensions !== undefined) {
          draft.extensions = extensions;
        }
      }
      if (type === 'firmware' && !readFirmwareFields(value, path, diagnostics, draft)) {
        failed = true;
      }
      break;
    }
    default:
      break;
  }

  if (hasOwn(value, 'default')) {
    const defaultValue = checkDefault(value['default'], draft, [...path, 'default'], diagnostics);
    if (defaultValue !== undefined) {
      draft.default = defaultValue.value;
    } else {
      failed = true;
    }
  }

  return failed ? undefined : draft;
}

type CountResult = number | 'invalid' | undefined;

function readCount(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): CountResult {
  if (!hasOwn(value, key)) {
    return undefined;
  }
  const count = readIntegerField(value, key, path, diagnostics);
  if (count === undefined) {
    return 'invalid';
  }
  if (count < 0) {
    report(
      diagnostics,
      'package/invalid-manifest',
      `Field "${key}" must be a non-negative integer.`,
      [...path, key],
    );
    return 'invalid';
  }
  return count;
}

function readBounds(
  value: Record<string, unknown>,
  type: 'integer' | 'number',
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  draft: DraftDescriptor,
): boolean {
  let ok = true;
  const min = readNumberField(value, 'min', path, diagnostics, false);
  const max = readNumberField(value, 'max', path, diagnostics, false);
  if (type === 'integer') {
    if (hasOwn(value, 'min') && (min === undefined || !Number.isSafeInteger(min))) {
      report(
        diagnostics,
        'package/invalid-manifest',
        'Field "min" must be a safe integer for an integer property.',
        [...path, 'min'],
      );
      ok = false;
    } else if (min !== undefined) {
      draft.min = min;
    }
    if (hasOwn(value, 'max') && (max === undefined || !Number.isSafeInteger(max))) {
      report(
        diagnostics,
        'package/invalid-manifest',
        'Field "max" must be a safe integer for an integer property.',
        [...path, 'max'],
      );
      ok = false;
    } else if (max !== undefined) {
      draft.max = max;
    }
  } else {
    if (min !== undefined) {
      draft.min = min;
    }
    if (max !== undefined) {
      draft.max = max;
    }
    const exclusiveMin = readNumberField(value, 'exclusiveMin', path, diagnostics, false);
    if (exclusiveMin !== undefined) {
      draft.exclusiveMin = exclusiveMin;
    }
  }
  if (draft.min !== undefined && draft.max !== undefined && draft.min > draft.max) {
    report(diagnostics, 'package/invalid-manifest', 'Field "min" must not be greater than "max".', [
      ...path,
      'min',
    ]);
    ok = false;
  }
  if (hasOwn(value, 'step')) {
    const step = readNumberField(value, 'step', path, diagnostics, false);
    if (step === undefined || step <= 0) {
      report(diagnostics, 'package/invalid-manifest', 'Field "step" must be greater than zero.', [
        ...path,
        'step',
      ]);
      ok = false;
    } else if (type === 'integer' && !Number.isSafeInteger(step)) {
      report(
        diagnostics,
        'package/invalid-manifest',
        'Field "step" must be a safe integer for an integer property.',
        [...path, 'step'],
      );
      ok = false;
    } else {
      draft.step = step;
    }
  }
  return ok;
}

function readOptions(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): readonly PropertyOption[] | undefined {
  const raw = readArrayField(value, 'options', path, diagnostics);
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length === 0) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Field "options" must contain at least one option.',
      [...path, 'options'],
    );
    return undefined;
  }
  const options: PropertyOption[] = [];
  const seen = new Set<string>();
  let failed = false;
  raw.forEach((entry, index) => {
    const optionPath = [...path, 'options', String(index)];
    if (!isRecord(entry)) {
      report(diagnostics, 'schema/invalid-type', 'Enum option must be an object.', optionPath);
      failed = true;
      return;
    }
    forbidUnknownFields(entry, ['value', 'label'], optionPath, diagnostics);
    const optionValue = readStringField(entry, 'value', optionPath, diagnostics, true, {
      nonEmpty: true,
    });
    const label = readStringField(entry, 'label', optionPath, diagnostics, true, {
      nonEmpty: true,
    });
    if (optionValue === undefined || label === undefined) {
      failed = true;
      return;
    }
    if (seen.has(optionValue)) {
      report(
        diagnostics,
        'package/invalid-manifest',
        `Enum option value ${JSON.stringify(optionValue)} is declared more than once.`,
        [...optionPath, 'value'],
      );
      failed = true;
      return;
    }
    seen.add(optionValue);
    options.push({ value: optionValue, label });
  });
  return failed ? undefined : options;
}

function readExtensions(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): readonly string[] | 'invalid' | undefined {
  if (!hasOwn(value, 'extensions')) {
    return undefined;
  }
  const raw = readArrayField(value, 'extensions', path, diagnostics);
  if (raw === undefined) {
    return 'invalid';
  }
  if (raw.length === 0) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Field "extensions" must contain at least one extension.',
      [...path, 'extensions'],
    );
    return 'invalid';
  }
  const extensions: string[] = [];
  const seen = new Set<string>();
  let failed = false;
  raw.forEach((entry, index) => {
    const entryPath = [...path, 'extensions', String(index)];
    if (typeof entry !== 'string' || !isExtensionFilter(entry)) {
      report(
        diagnostics,
        'package/invalid-manifest',
        'Extension filters must match "\\.[A-Za-z0-9]+".',
        entryPath,
      );
      failed = true;
      return;
    }
    const folded = entry.toLowerCase();
    if (seen.has(folded)) {
      report(
        diagnostics,
        'package/invalid-manifest',
        `Extension filter ${JSON.stringify(entry)} is declared more than once.`,
        entryPath,
      );
      failed = true;
      return;
    }
    seen.add(folded);
    extensions.push(entry);
  });
  return failed ? 'invalid' : extensions;
}

function readFirmwareFields(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  draft: DraftDescriptor,
): boolean {
  let ok = true;
  const spacesPath = [...path, 'addressSpaces'];
  const rawSpaces = readObjectField(value, 'addressSpaces', path, diagnostics);
  let spaces: Record<string, FirmwareAddressSpace> | undefined;
  if (rawSpaces === undefined) {
    ok = false;
  } else if (Object.keys(rawSpaces).length === 0) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Field "addressSpaces" must declare at least one address space.',
      spacesPath,
    );
    ok = false;
  } else {
    spaces = Object.create(null) as Record<string, FirmwareAddressSpace>;
    for (const [id, raw] of Object.entries(rawSpaces)) {
      const spacePath = [...spacesPath, id];
      if (id.length === 0) {
        report(
          diagnostics,
          'package/invalid-manifest',
          'Address space ids must not be empty.',
          spacePath,
        );
        ok = false;
        continue;
      }
      const space = readAddressSpace(raw, spacePath, diagnostics);
      if (space === undefined) {
        ok = false;
        continue;
      }
      spaces[id] = space;
    }
    if (ok) {
      draft.addressSpaces = spaces;
    }
  }

  const addressSpace = readStringField(value, 'addressSpace', path, diagnostics, true, {
    nonEmpty: true,
  });
  const loadAddress = readIntegerField(value, 'loadAddress', path, diagnostics, true);
  if (loadAddress !== undefined && loadAddress < 0) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Field "loadAddress" must be a non-negative safe integer.',
      [...path, 'loadAddress'],
    );
    ok = false;
  }
  if (addressSpace === undefined || spaces === undefined) {
    return false;
  }
  const space = spaces[addressSpace];
  if (space === undefined) {
    report(
      diagnostics,
      'package/invalid-manifest',
      `Field "addressSpace" must name a declared address space; "${addressSpace}" is unknown.`,
      [...path, 'addressSpace'],
    );
    return false;
  }
  draft.addressSpace = addressSpace;
  if (loadAddress === undefined) {
    return false;
  }
  draft.loadAddress = loadAddress;
  if (loadAddress < space.start || loadAddress >= space.start + space.size) {
    report(
      diagnostics,
      'package/invalid-manifest',
      `Field "loadAddress" must lie inside the "${addressSpace}" range.`,
      [...path, 'loadAddress'],
    );
    ok = false;
  }
  return ok;
}

function readAddressSpace(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): FirmwareAddressSpace | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Address space must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['title', 'start', 'size'], path, diagnostics);
  const title = readStringField(value, 'title', path, diagnostics, false, { nonEmpty: true });
  const start = readIntegerField(value, 'start', path, diagnostics, true);
  const size = readIntegerField(value, 'size', path, diagnostics, true);
  let failed = false;
  if (start !== undefined && start < 0) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Field "start" must be a non-negative safe integer.',
      [...path, 'start'],
    );
    failed = true;
  }
  if (size !== undefined && size <= 0) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Field "size" must be a positive safe integer.',
      [...path, 'size'],
    );
    failed = true;
  }
  if (start !== undefined && size !== undefined && !Number.isSafeInteger(start + size)) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'The address space must end at a safe integer.',
      [...path, 'size'],
    );
    failed = true;
  }
  if (failed || start === undefined || size === undefined) {
    return undefined;
  }
  return { ...(title === undefined ? {} : { title }), start, size };
}

interface CheckedDefault {
  readonly value: PropertyValue;
}

/**
 * Validates a declared default against its own description (RFC 0020 rejects an unusable default
 * instead of dropping it).
 */
function checkDefault(
  value: unknown,
  descriptor: DevicePropertyDescriptor,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): CheckedDefault | undefined {
  const fail = (message: string): undefined => {
    report(diagnostics, 'package/invalid-manifest', message, path);
    return undefined;
  };
  if (value === null) {
    return descriptor.nullable === true
      ? { value: null }
      : fail('A default of null requires "nullable": true.');
  }
  switch (descriptor.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return fail('Default must be a string.');
      }
      const maxLength = descriptor.maxLength;
      if (maxLength !== undefined && [...value].length > maxLength) {
        return fail(`Default must be at most ${String(maxLength)} characters.`);
      }
      return { value };
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return fail('Default must be a safe integer.');
      }
      if (descriptor.min !== undefined && value < descriptor.min) {
        return fail(`Default must be at least ${String(descriptor.min)}.`);
      }
      if (descriptor.max !== undefined && value > descriptor.max) {
        return fail(`Default must be at most ${String(descriptor.max)}.`);
      }
      return { value };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail('Default must be a finite number.');
      }
      if (descriptor.exclusiveMin !== undefined && value <= descriptor.exclusiveMin) {
        return fail(`Default must be greater than ${String(descriptor.exclusiveMin)}.`);
      }
      if (descriptor.min !== undefined && value < descriptor.min) {
        return fail(`Default must be at least ${String(descriptor.min)}.`);
      }
      if (descriptor.max !== undefined && value > descriptor.max) {
        return fail(`Default must be at most ${String(descriptor.max)}.`);
      }
      return { value };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { value } : fail('Default must be a boolean.');
    case 'color': {
      const color = typeof value === 'string' ? normalizeColor(value) : undefined;
      if (color === undefined) {
        return fail('Default must be a "#RRGGBB" or "#RRGGBBAA" color.');
      }
      if (descriptor.alpha !== true && color.length === 9 && !color.endsWith('FF')) {
        return fail('Default must use an FF alpha channel unless "alpha": true.');
      }
      return { value: color };
    }
    case 'enum': {
      const allowed = (descriptor.options ?? []).map((option) => option.value);
      return typeof value === 'string' && allowed.includes(value)
        ? { value }
        : fail(
            `Default must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}.`,
          );
    }
    case 'image':
    case 'binary': {
      const reference = checkPackageReference(value, path, diagnostics);
      return reference === undefined ? undefined : { value: reference };
    }
    case 'firmware': {
      const reference = checkPackageReference(value, path, diagnostics);
      if (reference === undefined) {
        return undefined;
      }
      const spaceId = reference.addressSpace;
      if (spaceId !== undefined) {
        const space = descriptor.addressSpaces?.[spaceId];
        if (space === undefined) {
          return fail(`Default address space "${spaceId}" is not declared.`);
        }
        const loadAddress = reference.loadAddress;
        if (
          loadAddress !== undefined &&
          (loadAddress < space.start || loadAddress >= space.start + space.size)
        ) {
          return fail(`Default load address must lie inside the "${spaceId}" range.`);
        }
      }
      return { value: reference };
    }
  }
}

/** A package-mode resource reference, the only file form a manifest default may use. */
function checkPackageReference(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
):
  | {
      readonly src: string;
      readonly mode: 'package';
      readonly addressSpace?: string;
      readonly loadAddress?: number;
    }
  | undefined {
  if (!isRecord(value)) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Default must be a "package" resource reference.',
      path,
    );
    return undefined;
  }
  forbidUnknownFields(value, ['src', 'mode', 'addressSpace', 'loadAddress'], path, diagnostics);
  const mode = readStringField(value, 'mode', path, diagnostics, true, { nonEmpty: true });
  const src = readStringField(value, 'src', path, diagnostics, true, { nonEmpty: true });
  if (mode !== 'package') {
    report(
      diagnostics,
      'package/invalid-manifest',
      'A declared package default must use "mode": "package".',
      [...path, 'mode'],
    );
    return undefined;
  }
  if (src === undefined) {
    return undefined;
  }
  const srcProblem = packagePathProblem(src);
  if (srcProblem !== undefined) {
    report(diagnostics, 'package/invalid-manifest', `Default "src" ${srcProblem}.`, [
      ...path,
      'src',
    ]);
    return undefined;
  }
  const addressSpace = readStringField(value, 'addressSpace', path, diagnostics, false, {
    nonEmpty: true,
  });
  const loadAddress = readIntegerField(value, 'loadAddress', path, diagnostics, false);
  if (loadAddress !== undefined && loadAddress < 0) {
    report(
      diagnostics,
      'package/invalid-manifest',
      'Default "loadAddress" must be a non-negative safe integer.',
      [...path, 'loadAddress'],
    );
    return undefined;
  }
  return {
    src,
    mode: 'package',
    ...(addressSpace === undefined ? {} : { addressSpace }),
    ...(loadAddress === undefined ? {} : { loadAddress }),
  };
}
