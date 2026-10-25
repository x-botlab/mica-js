import type { FloatBits, RuntimeScalar } from '@mica-js/ir';
import type { TopicPayload, TopicPayloadType, Vec2d, Vec3d } from '@mica-js/device';
import {
  TOPIC_BYTES_MAX_BYTES,
  TOPIC_STRING_MAX_BYTES,
  topicPayloadParams,
} from '../compiler/topics';
import { CircuitError } from './types';

/**
 * Topic payload encoding (U05).
 *
 * An IR endpoint carries scalars only, so both directions of the topic bridge
 * convert between a `TopicPayload` and the fixed scalar tuple its port
 * declares:
 *
 * ```text
 * boolean          -> [bool]
 * number           -> [f64]
 * vec2d            -> [f64, f64]
 * vec3d            -> [f64, f64, f64]
 * string           -> [u32 length, u32 word x 8]      UTF-8, at most 32 bytes
 * bytes / bytes<*> -> [u32 length, u32 word x 8]      raw bytes, at most 32 bytes
 * ```
 *
 * Byte words are little-endian and zero-padded, so the same payload always
 * produces the same scalars and a diff of two publishes is meaningful.
 */

const STRING_BYTES = TOPIC_STRING_MAX_BYTES;
const BYTES_BYTES = TOPIC_BYTES_MAX_BYTES;
const BYTES_PER_WORD = 4;

let encoder: InstanceType<typeof TextEncoder> | undefined;
let decoder: InstanceType<typeof TextDecoder> | undefined;

function bytesOf(type: TopicPayloadType): number {
  switch (type) {
    case 'string':
      return STRING_BYTES;
    case 'bytes':
    case 'bytes<rgb565>':
    case 'bytes<segments>':
      return BYTES_BYTES;
    default:
      return 0;
  }
}

function textEncode(value: string): Uint8Array {
  encoder ??= new TextEncoder();
  return encoder.encode(value);
}

function textDecode(bytes: Uint8Array): string {
  decoder ??= new TextDecoder();
  return decoder.decode(bytes);
}

function invalid(type: TopicPayloadType, detail: string): CircuitError {
  return new CircuitError('invalid-topic-payload', `Payload for a ${type} topic port ${detail}`);
}

function requireBytes(payload: TopicPayload, type: TopicPayloadType): Uint8Array {
  if (type === 'string') {
    if (typeof payload !== 'string') {
      throw invalid(type, `expects a string, received ${describe(payload)}`);
    }
    const encoded = textEncode(payload);
    if (encoded.length > STRING_BYTES) {
      throw invalid(
        type,
        `is ${encoded.length} UTF-8 bytes, more than the ${STRING_BYTES}-byte topic transport limit`,
      );
    }
    return encoded;
  }
  if (!(payload instanceof Uint8Array)) {
    throw invalid(type, `expects a Uint8Array, received ${describe(payload)}`);
  }
  if (payload.length > BYTES_BYTES) {
    throw invalid(
      type,
      `is ${payload.length} bytes, more than the ${BYTES_BYTES}-byte topic transport limit`,
    );
  }
  return payload;
}

/** Packs `bytes` into `u32` words: length first, then little-endian words. */
function packBytes(bytes: Uint8Array, words: number): RuntimeScalar[] {
  const args: RuntimeScalar[] = [bytes.length];
  for (let word = 0; word < words; word += 1) {
    let value = 0;
    for (let byte = 0; byte < BYTES_PER_WORD; byte += 1) {
      const index = word * BYTES_PER_WORD + byte;
      if (index < bytes.length) {
        value |= (bytes[index] as number) << (byte * 8);
      }
    }
    args.push(value >>> 0);
  }
  return args;
}

/** Unpacks the length-prefixed `u32` words written by {@link packBytes}. */
function unpackBytes(args: readonly RuntimeScalar[], type: TopicPayloadType): Uint8Array {
  const length = toInteger(args[0]);
  const capacity = bytesOf(type);
  if (length < 0 || length > capacity) {
    throw invalid(type, `carries an invalid length ${length} (capacity ${capacity})`);
  }
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const word = toInteger(args[1 + Math.floor(index / BYTES_PER_WORD)]);
    bytes[index] = (word >>> ((index % BYTES_PER_WORD) * 8)) & 0xff;
  }
  return bytes;
}

function toInteger(value: RuntimeScalar | undefined): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new CircuitError('invalid-topic-payload', 'Expected an integer word in topic payload');
}

/** Decodes a float scalar, accepting exact `FloatBits` as well as numbers. */
export function scalarToNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== undefined && typeof value === 'object') {
    const bits = value as FloatBits;
    const view = new DataView(new ArrayBuffer(8));
    if (bits.type === 'f32') {
      view.setUint32(0, Number(BigInt(bits.bits) & 0xffff_ffffn), false);
      return view.getFloat32(0, false);
    }
    view.setBigUint64(0, BigInt(bits.bits), false);
    return view.getFloat64(0, false);
  }
  throw new CircuitError('invalid-topic-payload', 'Expected a numeric value in topic payload');
}

function requireVector(
  payload: TopicPayload,
  type: TopicPayloadType,
  keys: readonly string[],
): Record<string, number> {
  if (payload === null || typeof payload !== 'object' || payload instanceof Uint8Array) {
    throw invalid(type, `expects an object with ${keys.join(', ')}, received ${describe(payload)}`);
  }
  const record = payload as unknown as Record<string, unknown>;
  const numbers: Record<string, number> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalid(type, `expects a finite ${key} number, received ${describe(value)}`);
    }
    numbers[key] = value;
  }
  return numbers;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  return typeof value === 'object' ? 'an object' : `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Converts one host payload into the scalar arguments of its IR endpoint.
 *
 * @throws {CircuitError} with code `invalid-topic-payload` when the payload does
 *   not match the declared type or exceeds the transport limits.
 */
export function toIRArgs(
  payload: TopicPayload | unknown,
  type: TopicPayloadType,
): readonly RuntimeScalar[] {
  const words = topicPayloadParams(type);
  switch (type) {
    case 'boolean':
      if (typeof payload !== 'boolean') {
        throw invalid(type, `expects a boolean, received ${describe(payload)}`);
      }
      return Object.freeze([payload]);
    case 'number':
      if (typeof payload !== 'number') {
        throw invalid(type, `expects a number, received ${describe(payload)}`);
      }
      return Object.freeze([payload]);
    case 'vec2d': {
      const { x, y } = requireVector(payload as TopicPayload, type, ['x', 'y']);
      return Object.freeze([x as number, y as number]);
    }
    case 'vec3d': {
      const { x, y, z } = requireVector(payload as TopicPayload, type, ['x', 'y', 'z']);
      return Object.freeze([x as number, y as number, z as number]);
    }
    case 'string':
    case 'bytes':
    case 'bytes<rgb565>':
    case 'bytes<segments>':
      return Object.freeze(
        packBytes(requireBytes(payload as TopicPayload, type), words.length - 1),
      );
  }
}

/**
 * Converts the scalars of one IR endpoint call back into a host payload.
 *
 * @throws {CircuitError} with code `invalid-topic-payload` when the aliasing
 *   length field is out of range for the port's declared capacity.
 */
export function fromIRArgs(args: readonly RuntimeScalar[], type: TopicPayloadType): TopicPayload {
  switch (type) {
    case 'boolean': {
      const value = args[0];
      if (typeof value !== 'boolean') {
        throw invalid(type, `expected a boolean argument, received ${describe(value)}`);
      }
      return value;
    }
    case 'number':
      return scalarToNumber(args[0]);
    case 'vec2d': {
      const point: Vec2d = Object.freeze({
        x: scalarToNumber(args[0]),
        y: scalarToNumber(args[1]),
      });
      return point;
    }
    case 'vec3d': {
      const point: Vec3d = Object.freeze({
        x: scalarToNumber(args[0]),
        y: scalarToNumber(args[1]),
        z: scalarToNumber(args[2]),
      });
      return point;
    }
    case 'string':
      return textDecode(unpackBytes(args, type));
    case 'bytes':
    case 'bytes<rgb565>':
    case 'bytes<segments>':
      return unpackBytes(args, type);
  }
}

/** `true` when `value` is shaped like a `TopicPayload` of `type`. */
export function isTopicPayload(value: unknown, type: TopicPayloadType): boolean {
  try {
    toIRArgs(value, type);
    return true;
  } catch {
    return false;
  }
}
