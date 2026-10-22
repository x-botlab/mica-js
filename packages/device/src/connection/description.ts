import { DeviceError } from '../errors';
import { isPlainRecord } from '../internal/records';
import type { DeviceConnectionDescriptor } from './types';

const CONNECTION_FIELDS = new Set(['pins', 'initial']);

/**
 * Reads the optional `connections` declaration (#14). Pins must already be declared by the
 * same description; pin descriptors themselves belong to #55 and are not parsed here.
 */
export function readConnections(
  definition: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, DeviceConnectionDescriptor> {
  const raw = definition['connections'];
  if (raw === undefined) {
    return new Map();
  }
  if (!isPlainRecord(raw)) {
    throw new DeviceError('schema/invalid-type', 'Device connections must be an object.', {
      pointer: '/connections',
    });
  }
  const declaredPins = readDeclaredPins(definition['pins']);
  const connections = new Map<string, DeviceConnectionDescriptor>();
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0) {
      throw new DeviceError('schema/invalid-value', 'Connection keys must not be empty.', {
        pointer: '/connections',
      });
    }
    const pointer = `/connections/${escapePointer(key)}`;
    if (!isPlainRecord(value)) {
      throw new DeviceError('schema/invalid-type', `Connection "${key}" must be an object.`, {
        pointer,
      });
    }
    for (const field of Object.keys(value)) {
      if (!CONNECTION_FIELDS.has(field)) {
        throw new DeviceError(
          'schema/unknown-field',
          `Connection "${key}" has unknown field "${field}".`,
          { pointer: `${pointer}/${escapePointer(field)}` },
        );
      }
    }
    connections.set(key, {
      key,
      pins: readPins(key, value['pins'], declaredPins, pointer),
      initial: readInitial(key, value['initial'], pointer),
    });
  }
  return connections;
}

function readDeclaredPins(value: unknown): ReadonlySet<string> {
  return isPlainRecord(value) ? new Set(Object.keys(value)) : new Set();
}

function readPins(
  key: string,
  value: unknown,
  declaredPins: ReadonlySet<string>,
  pointer: string,
): readonly [string, string] {
  if (!Array.isArray(value)) {
    throw new DeviceError(
      'schema/invalid-type',
      `Connection "${key}" pins must be an array of two pin ids.`,
      { pointer: `${pointer}/pins` },
    );
  }
  if (value.length !== 2) {
    throw new DeviceError(
      'schema/invalid-value',
      `Connection "${key}" pins must contain exactly two pin ids.`,
      { pointer: `${pointer}/pins` },
    );
  }
  const names: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const pin = value[index];
    if (typeof pin !== 'string' || pin.length === 0) {
      throw new DeviceError(
        'schema/invalid-type',
        `Connection "${key}" pin ${index} must be a non-empty string.`,
        { pointer: `${pointer}/pins/${index}` },
      );
    }
    if (!declaredPins.has(pin)) {
      throw new DeviceError(
        'schema/invalid-value',
        `Connection "${key}" pin ${JSON.stringify(pin)} is not declared by this device.`,
        { pointer: `${pointer}/pins/${index}` },
      );
    }
    names.push(pin);
  }
  if (names[0] === names[1]) {
    throw new DeviceError('schema/invalid-value', `Connection "${key}" pins must be distinct.`, {
      pointer: `${pointer}/pins`,
    });
  }
  return [names[0]!, names[1]!];
}

function readInitial(
  key: string,
  value: unknown,
  pointer: string,
): DeviceConnectionDescriptor['initial'] {
  if (value === undefined) {
    return 'open';
  }
  if (value !== 'open' && value !== 'closed') {
    throw new DeviceError(
      'schema/invalid-value',
      `Connection "${key}" initial must be "open" or "closed".`,
      { pointer: `${pointer}/initial` },
    );
  }
  return value;
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}
