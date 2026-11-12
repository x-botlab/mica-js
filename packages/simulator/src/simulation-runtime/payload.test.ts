import { describe, expect, it } from 'vitest';
import { bytesView } from '../values';
import { copyBytePayload, copyPayload, payloadMatches, samePayload } from './payload';

const BYTE_TYPES = ['bytes', 'bytes<rgb565>', 'bytes<segments>'] as const;

describe('topic payload contract', () => {
  it('accepts the read-only view of a byte buffer for every byte payload type', () => {
    const view = bytesView(new Uint8Array([1, 2, 3]));
    for (const type of BYTE_TYPES) expect(payloadMatches(type, view)).toBe(true);
    expect(payloadMatches('bytes', new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('rejects values that only resemble bytes', () => {
    const lookalike = {
      length: 3,
      byteLength: 3,
      slice: () => new Uint8Array(0),
      *[Symbol.iterator]() {},
    };
    expect(payloadMatches('bytes', lookalike)).toBe(false);
    expect(payloadMatches('bytes', [1, 2, 3])).toBe(false);
    expect(payloadMatches('bytes', '123')).toBe(false);
    expect(payloadMatches('bytes', new Uint16Array([1, 2]))).toBe(false);
  });

  it('restores a byte view to an owned array when copying', () => {
    const view = bytesView(new Uint8Array([4, 5, 6]));
    const copy = copyPayload(view);
    expect(copy).toBeInstanceOf(Uint8Array);
    expect(copy).not.toBe(view);
    expect(Array.from(copy as Uint8Array)).toEqual([4, 5, 6]);
    const transferred = copyBytePayload(view);
    expect(transferred).toBeInstanceOf(Uint8Array);
    expect(Array.from(transferred as Uint8Array)).toEqual([4, 5, 6]);
  });

  it('compares a byte view by content against an owned array', () => {
    const view = bytesView(new Uint8Array([7, 8]));
    expect(samePayload(view, new Uint8Array([7, 8]))).toBe(true);
    expect(samePayload(new Uint8Array([7, 8]), view)).toBe(true);
    expect(samePayload(view, new Uint8Array([7, 9]))).toBe(false);
    expect(samePayload(view, new Uint8Array([7]))).toBe(false);
    expect(samePayload(view, { x: 1, y: 2 })).toBe(false);
  });
});
