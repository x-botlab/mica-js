import { parseDeliveryKind, parsePayloadType } from '@mica-js/core/canvas';
import { readPropertyDescriptors, type PropertyDescriptor } from '@mica-js/core/schematic';
import { readConnections } from './connection/description';
import { DeviceError } from './errors';
import { isPlainRecord } from './internal/records';
import { readPinGroups, readPins } from './pins/parse';
import {
  type DeviceDescription,
  type DeviceDescriptionMetadata,
  type DevicePortDescriptor,
} from './types';

const PORT_FIELDS = new Set(['title', 'description', 'direction', 'type', 'delivery']);

/**
 * Parses an already-loaded device description object (#11).
 *
 * `metadata` carries the identity and display fields owned by the package index; the object
 * itself is not required to repeat them. Property descriptors follow #7 (unusable ones are
 * ignored) and ports follow #10 (direction, closed payload list and unknown fields are
 * validated). JSON syntax errors belong to the provider that produced the object.
 *
 * @throws {DeviceError} when the object or its containers do not match the contract.
 */
export function parseDeviceDescription(
  definition: unknown,
  metadata: DeviceDescriptionMetadata,
): DeviceDescription {
  const { name, displayName, description } = readMetadata(metadata);
  if (!isPlainRecord(definition)) {
    throw new DeviceError('device/description-schema', 'Device description must be an object.', {
      pointer: '',
    });
  }
  const pins = readPins(definition['pins']);
  return {
    name,
    displayName,
    description,
    properties: readProperties(definition['properties']),
    ports: readPorts(definition['ports']),
    pins,
    pinGroups: readPinGroups(definition['pinGroups'], pins),
    connections: readConnections(definition),
    designatorPrefix: readDesignatorPrefix(definition['designatorPrefix']),
  };
}

function readMetadata(metadata: DeviceDescriptionMetadata): {
  readonly name: string;
  readonly displayName: string;
  readonly description: string | undefined;
} {
  if (!isPlainRecord(metadata)) {
    throw new DeviceError('device/description-schema', 'Device metadata must be an object.', {
      pointer: '/metadata',
    });
  }
  const name = readMetadataText(metadata['name'], '/metadata/name', 'Device name', true);
  if (name === undefined) {
    throw new DeviceError('device/description-schema', 'Device name must be a non-empty string.', {
      pointer: '/metadata/name',
    });
  }
  const displayName =
    readMetadataText(metadata['displayName'], '/metadata/displayName', 'Device display name') ??
    name;
  const description = readMetadataText(
    metadata['description'],
    '/metadata/description',
    'Device description',
  );
  return { name, displayName, description };
}

function readMetadataText(
  value: unknown,
  pointer: string,
  label: string,
  required = false,
): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DeviceError('device/description-schema', `${label} must be a string.`, {
      pointer,
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

function readProperties(value: unknown): ReadonlyMap<string, PropertyDescriptor> {
  if (value === undefined) {
    return new Map();
  }
  if (!isPlainRecord(value)) {
    throw new DeviceError('device/description-schema', 'Device properties must be an object.', {
      pointer: '/properties',
    });
  }
  return readPropertyDescriptors(value);
}

function readPorts(value: unknown): ReadonlyMap<string, DevicePortDescriptor> {
  if (value === undefined) {
    return new Map();
  }
  if (!isPlainRecord(value)) {
    throw new DeviceError('device/description-schema', 'Device ports must be an object.', {
      pointer: '/ports',
    });
  }
  const ports = new Map<string, DevicePortDescriptor>();
  for (const [key, raw] of Object.entries(value)) {
    if (key.length === 0) {
      throw new DeviceError('schema/invalid-value', 'Port keys must not be empty.', {
        pointer: '/ports',
      });
    }
    ports.set(key, readPort(key, raw));
  }
  return ports;
}

function readPort(key: string, value: unknown): DevicePortDescriptor {
  const pointer = `/ports/${escapePointer(key)}`;
  if (!isPlainRecord(value)) {
    throw new DeviceError('schema/invalid-type', `Port "${key}" must be an object.`, { pointer });
  }
  for (const field of Object.keys(value)) {
    if (!PORT_FIELDS.has(field)) {
      throw new DeviceError('schema/unknown-field', `Port "${key}" has unknown field "${field}".`, {
        pointer: `${pointer}/${escapePointer(field)}`,
      });
    }
  }
  const title = readOptionalText(value['title'], `${pointer}/title`, `Port "${key}" title`);
  const description = readOptionalText(
    value['description'],
    `${pointer}/description`,
    `Port "${key}" description`,
  );
  const direction = value['direction'];
  if (direction !== 'input' && direction !== 'output') {
    throw new DeviceError(
      'schema/invalid-value',
      `Port "${key}" direction must be "input" or "output".`,
      { pointer: `${pointer}/direction` },
    );
  }
  const payloadType = value['type'];
  const type = typeof payloadType === 'string' ? parsePayloadType(payloadType) : undefined;
  if (type === undefined) {
    throw new DeviceError(
      'type/unknown',
      `Port "${key}" has unknown payload type ${JSON.stringify(payloadType)}.`,
      { pointer: `${pointer}/type` },
    );
  }
  const port: {
    -readonly [K in keyof DevicePortDescriptor]: DevicePortDescriptor[K];
  } = { key, direction, type };
  const declaredDelivery = value['delivery'];
  if (declaredDelivery !== undefined) {
    // RFC 0017: `delivery` is optional and independent of `type`; anything else is rejected rather
    // than silently falling back to the payload type default.
    const delivery = parseDeliveryKind(declaredDelivery);
    if (delivery === undefined) {
      throw new DeviceError(
        'schema/invalid-value',
        `Port "${key}" delivery must be "level" or "message".`,
        { pointer: `${pointer}/delivery` },
      );
    }
    port.delivery = delivery;
  }
  if (title !== undefined) {
    port.title = title;
  }
  if (description !== undefined) {
    port.description = description;
  }
  return port;
}

function readDesignatorPrefix(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DeviceError(
      'device/description-schema',
      'Device designatorPrefix must be a string.',
      { pointer: '/designatorPrefix' },
    );
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readOptionalText(value: unknown, pointer: string, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DeviceError('schema/invalid-type', `${label} must be a string.`, { pointer });
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}
