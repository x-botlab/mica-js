import { describe, expect, it } from 'vitest';
import { PAYLOAD_TYPES, isAssignable, parsePayloadType } from './type-name';

describe('parsePayloadType', () => {
  it('resolves every payload type name', () => {
    for (const name of PAYLOAD_TYPES) {
      expect(parsePayloadType(name)).toBe(name);
    }
  });

  it('exposes exactly the eight payload types of #10', () => {
    expect(PAYLOAD_TYPES).toEqual([
      'boolean',
      'number',
      'string',
      'vec2d',
      'vec3d',
      'bytes',
      'bytes<rgb565>',
      'bytes<segments>',
    ]);
  });

  it('rejects unknown names', () => {
    expect(parsePayloadType('')).toBeUndefined();
    expect(parsePayloadType('int')).toBeUndefined();
    expect(parsePayloadType('Vec2d')).toBeUndefined();
    expect(parsePayloadType('bytes<rgb888>')).toBeUndefined();
    expect(parsePayloadType(' bytes')).toBeUndefined();
  });
});

describe('isAssignable', () => {
  it('accepts an identical payload type', () => {
    for (const name of PAYLOAD_TYPES) {
      expect(isAssignable(name, name)).toBe(true);
    }
  });

  it('rejects every different payload type', () => {
    for (const from of PAYLOAD_TYPES) {
      for (const to of PAYLOAD_TYPES) {
        if (from !== to) {
          expect(isAssignable(from, to)).toBe(false);
        }
      }
    }
  });
});
