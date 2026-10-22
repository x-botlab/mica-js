import { isPlainRecord } from '../internal/records';
import type { TopicMetadata, TopicPayload, TopicPayloadType } from '../types';
import { messagingError } from './errors';

/**
 * Captures one topic payload for a declared #10 port. Byte payloads are copied; vector
 * payloads are validated for their fixed key set and frozen. Tagged byte layouts are a
 * host/format-layer concern, so only the representation is checked here.
 */
export function captureTopicPayload(
  deviceId: string,
  port: string,
  type: TopicPayloadType,
  value: unknown,
): TopicPayload {
  const invalid = (detail: string): never => {
    throw messagingError(
      'device/topic-payload',
      deviceId,
      `port ${JSON.stringify(port)} expects ${type}: ${detail}.`,
    );
  };
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : invalid('expected a boolean');
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? value === 0
          ? 0
          : value
        : invalid('expected a finite number');
    case 'string':
      return typeof value === 'string' ? value : invalid('expected a string');
    case 'vec2d':
      return captureVector(value, ['x', 'y'], invalid);
    case 'vec3d':
      return captureVector(value, ['x', 'y', 'z'], invalid);
    case 'bytes':
    case 'bytes<rgb565>':
    case 'bytes<segments>':
      return value instanceof Uint8Array ? new Uint8Array(value) : invalid('expected a Uint8Array');
    default:
      return invalid('unknown payload type');
  }
}

function captureVector(
  value: unknown,
  keys: readonly string[],
  invalid: (detail: string) => never,
): TopicPayload {
  if (!isPlainRecord(value)) {
    return invalid(`expected an object with keys ${keys.join(', ')}`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    !actual.every((key) => keys.includes(key))
  ) {
    return invalid(`expected exactly the keys ${keys.join(', ')}`);
  }
  const result: Record<string, number> = {};
  for (const key of keys) {
    const component = value[key];
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      return invalid(`component ${key} must be a finite number`);
    }
    result[key] = component === 0 ? 0 : component;
  }
  return Object.freeze(result) as unknown as TopicPayload;
}

export function captureTopicMetadata(deviceId: string, value: unknown): TopicMetadata {
  if (!isPlainRecord(value)) {
    throw messagingError('device/topic-payload', deviceId, 'topic metadata must be an object.');
  }
  const simTime = value['simTime'];
  if (typeof simTime !== 'number' || !Number.isSafeInteger(simTime) || simTime < 0) {
    throw messagingError(
      'device/topic-payload',
      deviceId,
      'topic metadata simTime must be a non-negative safe integer.',
    );
  }
  return Object.freeze({ simTime: simTime === 0 ? 0 : simTime });
}

/** Gives each listener its own byte/vector payload while sharing immutable scalar values. */
export function cloneTopicPayload(payload: TopicPayload): TopicPayload {
  if (payload instanceof Uint8Array) {
    return new Uint8Array(payload);
  }
  if (typeof payload === 'object' && payload !== null) {
    return Object.freeze({ ...payload });
  }
  return payload;
}
