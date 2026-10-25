import { SCHEMA_ERROR_CODES, type SchemaErrorCode } from '@mica-js/core/canvas';
import { isPlainRecord } from '../internal/records';
import type { TopicMetadata, TopicPayload, TopicPayloadType } from '../types';
import { messagingError } from './errors';

/** RFC 0010 §2.7: `bytes<rgb565>` starts with an 8-byte little-endian header. */
const RGB565_HEADER_BYTES = 8;
/** RFC 0010 §2.7: one RGB565 pixel is a single 16-bit word. */
const RGB565_BYTES_PER_PIXEL = 2;
/** RFC 0010 §2.8: one payload byte packs the state of eight segments. */
const SEGMENTS_PER_BYTE = 8;

const VEC2D_KEYS = Object.freeze(['x', 'y'] as const);
const VEC3D_KEYS = Object.freeze(['x', 'y', 'z'] as const);

/** One schema conformance problem reported by {@link validateTopicPayload}. */
export interface ValidationIssue {
  /** Stable error code; `message` is human-readable and not part of the contract. */
  readonly code: SchemaErrorCode;
  /** Generic description of `code`, e.g. `"The value does not conform to the schema"`. */
  readonly description: string;
  /** Location of the offending value, defaulting to `"payload"`. */
  readonly path: string;
  /** Specific explanation, including any length arithmetic that was applied. */
  readonly message: string;
}

/** Outcome of one payload validation. A failure always carries exactly one issue. */
export type ValidationResult =
  | { readonly valid: true; readonly error?: undefined }
  | { readonly valid: false; readonly error: ValidationIssue };

/** Device-supplied context a layout check may need. */
export interface ValidateTopicPayloadOptions {
  /**
   * Segment count of the device behind a `bytes<segments>` port (RFC 0010 §2.8). Without it the
   * expected length is unknown, so only an empty payload can be rejected.
   */
  readonly segmentCount?: number;
}

const VALID: ValidationResult = Object.freeze({ valid: true });

function valid(): ValidationResult {
  return VALID;
}

function issue(code: SchemaErrorCode, path: string, detail: string): ValidationResult {
  return {
    valid: false,
    error: Object.freeze({
      code,
      description: SCHEMA_ERROR_CODES[code],
      path,
      message: `${path}: ${detail}`,
    }),
  };
}

function invalidValue(path: string, detail: string): ValidationResult {
  return issue('schema/invalid-value', path, detail);
}

function typeMismatch(path: string, expected: string, value: unknown): ValidationResult {
  return issue('schema/type-mismatch', path, `expected ${expected}, got ${describeValue(value)}`);
}

/** Short description of a received value for type-mismatch messages. */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value instanceof Uint8Array) {
    return `a Uint8Array of ${value.length} bytes`;
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (typeof value === 'object') {
    return 'an object';
  }
  return typeof value === 'string'
    ? `string ${JSON.stringify(value)}`
    : `${typeof value} ${String(value)}`;
}

/**
 * Captures one topic payload for a declared #10 port. Byte payloads are copied; vector
 * payloads are validated for their fixed key set and frozen. Tagged byte layouts are a
 * host/format-layer concern, so only the representation is checked here; use
 * {@link validateTopicPayload} to check a layout before capturing.
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
      return captureVector(value, VEC2D_KEYS, invalid);
    case 'vec3d':
      return captureVector(value, VEC3D_KEYS, invalid);
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

/**
 * Validates one topic payload against its declared type, including the tagged byte layouts of
 * RFC 0010: `bytes<rgb565>` (§2.7) and `bytes<segments>` (§2.8).
 *
 * Layout checking is separate from capture so a host can reject a message before it is copied
 * into a device. Failures use the shared `schema/*` codes; a successful result never carries an
 * error.
 *
 * @param path location reported in the issue, e.g. `"input.frame"` (defaults to `"payload"`).
 * @param options device context a layout check needs, such as the segment count.
 */
export function validateTopicPayload(
  value: unknown,
  type: TopicPayloadType,
  path: string = 'payload',
  options: ValidateTopicPayloadOptions = {},
): ValidationResult {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean' ? valid() : typeMismatch(path, 'a boolean', value);
    case 'number':
      if (typeof value !== 'number') {
        return typeMismatch(path, 'a finite number', value);
      }
      return Number.isFinite(value) ? valid() : invalidValue(path, 'number must be finite');
    case 'string':
      return typeof value === 'string' ? valid() : typeMismatch(path, 'a string', value);
    case 'vec2d':
      return validateVector(value, VEC2D_KEYS, path);
    case 'vec3d':
      return validateVector(value, VEC3D_KEYS, path);
    case 'bytes':
      return value instanceof Uint8Array ? valid() : typeMismatch(path, 'Uint8Array', value);
    case 'bytes<rgb565>':
      return value instanceof Uint8Array
        ? validateRgb565Layout(value, path)
        : typeMismatch(path, 'Uint8Array', value);
    case 'bytes<segments>':
      if (!(value instanceof Uint8Array)) {
        return typeMismatch(path, 'Uint8Array', value);
      }
      return options.segmentCount === undefined
        ? validateSegmentsPresence(value, path)
        : validateSegmentsLayout(value, options.segmentCount, path);
    default:
      return invalidValue(path, `unknown payload type ${JSON.stringify(type)}`);
  }
}

function validateVector(value: unknown, keys: readonly string[], path: string): ValidationResult {
  const expected = `an object with keys ${keys.join(', ')}`;
  if (!isPlainRecord(value)) {
    return typeMismatch(path, expected, value);
  }
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) {
    return issue(
      'schema/unknown-field',
      path,
      `unknown field ${JSON.stringify(unknown)}; expected exactly the keys ${keys.join(', ')}`,
    );
  }
  for (const key of keys) {
    const componentPath = `${path}.${key}`;
    if (!Object.hasOwn(value, key)) {
      return invalidValue(componentPath, 'required component is missing');
    }
    const component = value[key];
    if (typeof component !== 'number') {
      return typeMismatch(componentPath, 'a finite number', component);
    }
    if (!Number.isFinite(component)) {
      return invalidValue(componentPath, 'number must be finite');
    }
  }
  return valid();
}

/**
 * Validates the RFC 0010 §2.7 `bytes<rgb565>` layout: an 8-byte little-endian header followed by
 * one 16-bit word per pixel.
 *
 * ```text
 * [0-1] uint16 width   [2-3] uint16 height   [4-7] uint32 reserved
 * ```
 *
 * Both dimensions must be positive and the payload must be exactly `8 + width × height × 2`
 * bytes. The reserved word is not constrained.
 */
export function validateRgb565Layout(data: Uint8Array, path: string = 'payload'): ValidationResult {
  if (data.length < RGB565_HEADER_BYTES) {
    return invalidValue(
      path,
      `bytes<rgb565> requires at least ${RGB565_HEADER_BYTES} bytes for the header, got ${data.length}`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  if (width === 0 || height === 0) {
    return invalidValue(
      path,
      `bytes<rgb565> width and height must be positive, got ${width} × ${height}`,
    );
  }
  const expected = RGB565_HEADER_BYTES + width * height * RGB565_BYTES_PER_PIXEL;
  if (data.length !== expected) {
    return invalidValue(
      path,
      `bytes<rgb565> length mismatch: expected ${expected} ` +
        `(${RGB565_HEADER_BYTES} + ${width} × ${height} × ${RGB565_BYTES_PER_PIXEL}), ` +
        `got ${data.length}`,
    );
  }
  return valid();
}

/**
 * Validates the RFC 0010 §2.8 `bytes<segments>` layout: every byte packs the state of eight
 * segments, so the payload is exactly `ceil(segmentCount / 8)` bytes. The segment count comes
 * from the device definition; 9 and 16 segments both need two bytes.
 */
export function validateSegmentsLayout(
  data: Uint8Array,
  segmentCount: number,
  path: string = 'payload',
): ValidationResult {
  if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) {
    return invalidValue(
      path,
      `bytes<segments> segment count must be a positive integer, got ${segmentCount}`,
    );
  }
  const expected = Math.ceil(segmentCount / SEGMENTS_PER_BYTE);
  if (data.length !== expected) {
    return invalidValue(
      path,
      `bytes<segments> length mismatch: expected ${expected} ` +
        `(ceil(${segmentCount} / ${SEGMENTS_PER_BYTE})), got ${data.length}`,
    );
  }
  return valid();
}

/** Without a segment count the expected length is unknown, so only emptiness is rejected. */
function validateSegmentsPresence(data: Uint8Array, path: string): ValidationResult {
  return data.length === 0 ? invalidValue(path, 'bytes<segments> must not be empty') : valid();
}
