import type { PayloadType } from '@mica-js/document/canvas';

/** Stable key of one device endpoint. */
export function targetKey(symbol: string, port: string): string {
  return `${symbol}\u0000${port}`;
}

/**
 * Value equality of two payloads.
 *
 * A canvas topic is a `level` unless it carries text or bytes (RFC 0017), so re-sending the value a
 * device already published only costs a widget repaint. Byte payloads compare by content because a
 * device may hand out a fresh buffer per step.
 */
export function samePayload(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (previous instanceof Uint8Array && next instanceof Uint8Array) {
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index] !== next[index]) return false;
    }
    return true;
  }
  if (typeof previous !== 'object' || previous === null) return false;
  if (typeof next !== 'object' || next === null) return false;
  const a = previous as { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown };
  const b = next as { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown };
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function isVec2d(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as { readonly x?: unknown; readonly y?: unknown };
  return typeof point.x === 'number' && typeof point.y === 'number';
}

/** Whether `payload` matches the declared topic payload type. */
export function payloadMatches(type: PayloadType, payload: unknown): boolean {
  switch (type) {
    case 'boolean':
      return typeof payload === 'boolean';
    case 'number':
      return typeof payload === 'number';
    case 'string':
      return typeof payload === 'string';
    case 'bytes':
    case 'bytes<rgb565>':
    case 'bytes<segments>':
      return payload instanceof Uint8Array;
    case 'vec2d':
      return isVec2d(payload);
    case 'vec3d':
      return isVec2d(payload) && typeof (payload as { readonly z?: unknown }).z === 'number';
  }
}

/** Copies a byte payload so an RPC transfer never detaches the producer's buffer. */
export function copyBytePayload(payload: unknown): unknown {
  return payload instanceof Uint8Array ? new Uint8Array(payload) : payload;
}

/** Snapshots mutable payloads accepted by the prepared topic contract. */
export function copyPayload(payload: unknown): unknown {
  if (payload instanceof Uint8Array) return new Uint8Array(payload);
  return typeof payload === 'object' && payload !== null ? { ...payload } : payload;
}
