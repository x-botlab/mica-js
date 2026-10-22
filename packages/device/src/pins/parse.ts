import { DeviceError } from '../errors';
import { isPlainRecord } from '../internal/records';
import type { DevicePinDescriptor, DevicePinGroupDescriptor, PinKind, PinSide } from '../types';

const PIN_FIELDS = new Set(['kind', 'side', 'powerDomain', 'levels']);
const GROUP_FIELDS = new Set(['pins']);
const LEVEL_FIELDS = new Set(['low', 'high']);
const PIN_KINDS: readonly PinKind[] = ['power', 'gnd', 'signal'];
const PIN_SIDES: readonly PinSide[] = ['left', 'right', 'top', 'bottom'];
const DEFAULT_SIDE: PinSide = 'left';

/** Parses the optional `pins` declaration (#12). */
export function readPins(value: unknown): ReadonlyMap<string, DevicePinDescriptor> {
  const pins = new Map<string, DevicePinDescriptor>();
  if (value === undefined) {
    return pins;
  }
  if (!isPlainRecord(value)) {
    throw schemaError('Device pins must be an object.', '/pins');
  }
  for (const [key, raw] of Object.entries(value)) {
    if (key.length === 0) {
      throw schemaError('Pin keys must not be empty.', '/pins');
    }
    pins.set(key, readPin(key, raw));
  }
  return pins;
}

function readPin(key: string, value: unknown): DevicePinDescriptor {
  const pointer = `/pins/${escapePointer(key)}`;
  if (!isPlainRecord(value)) {
    throw schemaError(`Pin "${key}" must be an object.`, pointer);
  }
  for (const field of Object.keys(value)) {
    if (!PIN_FIELDS.has(field)) {
      throw new DeviceError('schema/unknown-field', `Pin "${key}" has unknown field "${field}".`, {
        pointer: `${pointer}/${escapePointer(field)}`,
      });
    }
  }
  const kind = value['kind'];
  if (typeof kind !== 'string' || kind.length === 0) {
    throw schemaError(`Pin "${key}" requires a kind.`, `${pointer}/kind`);
  }
  if (!(PIN_KINDS as readonly string[]).includes(kind)) {
    throw new DeviceError(
      'schema/invalid-value',
      `Pin "${key}" has unknown kind ${JSON.stringify(kind)}.`,
      { pointer: `${pointer}/kind` },
    );
  }
  const rawSide = value['side'];
  let side = DEFAULT_SIDE;
  if (rawSide !== undefined) {
    if (typeof rawSide !== 'string' || !(PIN_SIDES as readonly string[]).includes(rawSide)) {
      throw new DeviceError(
        'schema/invalid-value',
        `Pin "${key}" has unknown side ${JSON.stringify(rawSide)}.`,
        { pointer: `${pointer}/side` },
      );
    }
    side = rawSide as PinSide;
  }
  const powerDomain = value['powerDomain'];
  let domain: string | undefined;
  if (powerDomain !== undefined) {
    if (typeof powerDomain !== 'string' || powerDomain.length === 0) {
      throw new DeviceError(
        'schema/invalid-type',
        `Pin "${key}" powerDomain must be a non-empty string.`,
        { pointer: `${pointer}/powerDomain` },
      );
    }
    if (kind !== 'signal') {
      throw new DeviceError(
        'schema/invalid-value',
        `Pin "${key}" powerDomain requires kind "signal".`,
        { pointer: `${pointer}/powerDomain` },
      );
    }
    domain = powerDomain;
  }
  const levels = readLevels(key, value['levels'], pointer, domain);
  return Object.freeze({
    key,
    kind: kind as PinKind,
    side,
    ...(domain === undefined ? {} : { powerDomain: domain }),
    ...(levels === undefined ? {} : { levels }),
  });
}

function readLevels(
  key: string,
  value: unknown,
  pointer: string,
  powerDomain: string | undefined,
): { readonly low: number; readonly high: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new DeviceError('schema/invalid-type', `Pin "${key}" levels must be an object.`, {
      pointer: `${pointer}/levels`,
    });
  }
  for (const field of Object.keys(value)) {
    if (!LEVEL_FIELDS.has(field)) {
      throw new DeviceError(
        'schema/unknown-field',
        `Pin "${key}" levels has unknown field "${field}".`,
        { pointer: `${pointer}/levels/${escapePointer(field)}` },
      );
    }
  }
  if (powerDomain === undefined) {
    throw new DeviceError('schema/invalid-value', `Pin "${key}" levels requires powerDomain.`, {
      pointer: `${pointer}/levels`,
    });
  }
  const low = value['low'];
  const high = value['high'];
  if (typeof low !== 'number' || !Number.isFinite(low)) {
    throw new DeviceError(
      'schema/invalid-type',
      `Pin "${key}" levels.low must be a finite number.`,
      { pointer: `${pointer}/levels/low` },
    );
  }
  if (typeof high !== 'number' || !Number.isFinite(high)) {
    throw new DeviceError(
      'schema/invalid-type',
      `Pin "${key}" levels.high must be a finite number.`,
      { pointer: `${pointer}/levels/high` },
    );
  }
  if (!(low >= 0 && low < high && high <= 1)) {
    throw new DeviceError(
      'schema/invalid-value',
      `Pin "${key}" levels must satisfy 0 <= low < high <= 1.`,
      { pointer: `${pointer}/levels` },
    );
  }
  return Object.freeze({ low, high });
}

/** Parses the optional `pinGroups` declaration (#12) against the declared pins. */
export function readPinGroups(
  value: unknown,
  pins: ReadonlyMap<string, DevicePinDescriptor>,
): ReadonlyMap<string, DevicePinGroupDescriptor> {
  const groups = new Map<string, DevicePinGroupDescriptor>();
  if (value === undefined) {
    return groups;
  }
  if (!isPlainRecord(value)) {
    throw schemaError('Device pinGroups must be an object.', '/pinGroups');
  }
  for (const [key, raw] of Object.entries(value)) {
    if (key.length === 0) {
      throw schemaError('Pin group keys must not be empty.', '/pinGroups');
    }
    groups.set(key, readPinGroup(key, raw, pins));
  }
  return groups;
}

function readPinGroup(
  key: string,
  value: unknown,
  pins: ReadonlyMap<string, DevicePinDescriptor>,
): DevicePinGroupDescriptor {
  const pointer = `/pinGroups/${escapePointer(key)}`;
  if (!isPlainRecord(value)) {
    throw schemaError(`Pin group "${key}" must be an object.`, pointer);
  }
  for (const field of Object.keys(value)) {
    if (!GROUP_FIELDS.has(field)) {
      throw new DeviceError(
        'schema/unknown-field',
        `Pin group "${key}" has unknown field "${field}".`,
        { pointer: `${pointer}/${escapePointer(field)}` },
      );
    }
  }
  const members = value['pins'];
  if (!Array.isArray(members) || members.length === 0) {
    throw new DeviceError(
      'schema/invalid-value',
      `Pin group "${key}" requires a non-empty pins array.`,
      { pointer: `${pointer}/pins` },
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  members.forEach((member, index) => {
    if (typeof member !== 'string' || member.length === 0) {
      throw new DeviceError(
        'schema/invalid-type',
        `Pin group "${key}" member ${index} must be a non-empty string.`,
        { pointer: `${pointer}/pins/${index}` },
      );
    }
    if (seen.has(member)) {
      throw new DeviceError(
        'schema/invalid-value',
        `Pin group "${key}" member ${JSON.stringify(member)} is duplicated.`,
        { pointer: `${pointer}/pins/${index}` },
      );
    }
    if (!pins.has(member)) {
      throw new DeviceError(
        'schema/invalid-value',
        `Pin group "${key}" member ${JSON.stringify(member)} is not a declared pin.`,
        { pointer: `${pointer}/pins/${index}` },
      );
    }
    seen.add(member);
    result.push(member);
  });
  return Object.freeze({ key, pins: Object.freeze(result) });
}

function schemaError(message: string, pointer: string): DeviceError {
  return new DeviceError('device/description-schema', message, { pointer });
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}
