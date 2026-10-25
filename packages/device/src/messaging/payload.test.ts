import { describe, expect, it } from 'vitest';
import type { TopicPayloadType } from '../types';
import { validateRgb565Layout, validateSegmentsLayout, validateTopicPayload } from './payload';

/** Whole `bytes<rgb565>` payload: little-endian header followed by zeroed pixels. */
function rgb565(width: number, height: number): Uint8Array {
  return rgb565Header(width, height, 8 + width * height * 2);
}

/** Payload of `length` bytes whose header declares `width × height`. */
function rgb565Header(width: number, height: number, length: number): Uint8Array {
  const data = new Uint8Array(length);
  const view = new DataView(data.buffer);
  view.setUint16(0, width, true);
  view.setUint16(2, height, true);
  return data;
}

describe('bytes<rgb565> layout validation (RFC 0010 §2.7)', () => {
  it('accepts 8 header bytes plus width × height × 2 pixel bytes', () => {
    const sizes = [
      [1, 1],
      [3, 2],
      [16, 16],
      [480, 320],
    ] as const;
    for (const [width, height] of sizes) {
      const payload = rgb565(width, height);
      expect(validateRgb565Layout(payload)).toEqual({ valid: true });
      expect(validateTopicPayload(payload, 'bytes<rgb565>')).toEqual({ valid: true });
    }
  });

  it('rejects a payload whose length is not 8 + width × height × 2', () => {
    const result = validateTopicPayload(rgb565Header(16, 16, 100), 'bytes<rgb565>');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('schema/invalid-value');
    expect(result.error?.message).toContain('length mismatch');
    expect(result.error?.message).toContain('expected 520 (8 + 16 × 16 × 2), got 100');
  });

  it('rejects a payload longer than the declared dimensions', () => {
    const result = validateRgb565Layout(rgb565Header(2, 2, 24));
    expect(result.valid).toBe(false);
    expect(result.error?.message).toContain('length mismatch');
    expect(result.error?.message).toContain('expected 16 (8 + 2 × 2 × 2), got 24');
  });

  it('rejects zero width and zero height', () => {
    const zeroWidth = validateTopicPayload(rgb565Header(0, 16, 8), 'bytes<rgb565>');
    expect(zeroWidth.valid).toBe(false);
    expect(zeroWidth.error?.message).toContain('must be positive');

    const zeroHeight = validateRgb565Layout(rgb565Header(16, 0, 8));
    expect(zeroHeight.valid).toBe(false);
    expect(zeroHeight.error?.message).toContain('must be positive');
  });

  it('rejects data shorter than the 8-byte header', () => {
    const result = validateTopicPayload(new Uint8Array(4), 'bytes<rgb565>');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('schema/invalid-value');
    expect(result.error?.message).toContain('at least 8 bytes');
  });

  it('requires a Uint8Array before reading a layout', () => {
    const result = validateTopicPayload([0, 0, 0, 0, 0, 0, 0, 0], 'bytes<rgb565>');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('schema/type-mismatch');
    expect(result.error?.message).toContain('expected Uint8Array');
  });

  it('reads the header relative to the view, not the backing buffer', () => {
    const backing = new Uint8Array(8 + 8 + 2);
    const view = new DataView(backing.buffer);
    view.setUint16(8, 1, true);
    view.setUint16(10, 1, true);
    const payload = backing.subarray(8);
    expect(payload.length).toBe(10);
    expect(validateRgb565Layout(payload)).toEqual({ valid: true });
  });

  it('reports the path and the shared code description', () => {
    const result = validateTopicPayload(new Uint8Array(4), 'bytes<rgb565>', 'input.frame');
    expect(result.error).toMatchObject({
      code: 'schema/invalid-value',
      description: 'The value does not conform to the schema',
      path: 'input.frame',
    });
    expect(result.error?.message.startsWith('input.frame: ')).toBe(true);
  });
});

describe('bytes<segments> layout validation (RFC 0010 §2.8)', () => {
  it('expects ceil(segmentCount / 8) bytes', () => {
    const cases = [
      [1, 1],
      [8, 1],
      [9, 2],
      [16, 2],
      [17, 3],
    ] as const;
    for (const [segmentCount, bytes] of cases) {
      expect(validateSegmentsLayout(new Uint8Array(bytes), segmentCount)).toEqual({ valid: true });
      expect(validateSegmentsLayout(new Uint8Array(bytes + 1), segmentCount).valid).toBe(false);
    }
  });

  it('reports the ceiling arithmetic when the length is wrong', () => {
    const result = validateSegmentsLayout(new Uint8Array(3), 16);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('schema/invalid-value');
    expect(result.error?.message).toContain('length mismatch');
    expect(result.error?.message).toContain('expected 2 (ceil(16 / 8)), got 3');
  });

  it('rejects a segment count that is not a positive integer', () => {
    for (const segmentCount of [0, -8, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateSegmentsLayout(new Uint8Array(1), segmentCount);
      expect(result.valid).toBe(false);
      expect(result.error?.message).toContain('segment count must be a positive integer');
    }
  });

  it('applies the layout when the device segment count is supplied', () => {
    const wrong = validateTopicPayload(new Uint8Array(3), 'bytes<segments>', 'input.bar', {
      segmentCount: 16,
    });
    expect(wrong.valid).toBe(false);
    expect(wrong.error?.message).toContain('length mismatch');

    const right = validateTopicPayload(new Uint8Array(2), 'bytes<segments>', 'input.bar', {
      segmentCount: 16,
    });
    expect(right).toEqual({ valid: true });
  });

  it('only rejects an empty payload when the segment count is unknown', () => {
    const empty = validateTopicPayload(new Uint8Array(0), 'bytes<segments>');
    expect(empty.valid).toBe(false);
    expect(empty.error?.code).toBe('schema/invalid-value');
    expect(empty.error?.message).toContain('must not be empty');
    expect(validateTopicPayload(new Uint8Array(3), 'bytes<segments>')).toEqual({ valid: true });
  });

  it('requires a Uint8Array', () => {
    const result = validateTopicPayload('0101', 'bytes<segments>');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('schema/type-mismatch');
  });
});

describe('validateTopicPayload representation', () => {
  it('accepts scalar and byte payloads', () => {
    expect(validateTopicPayload(true, 'boolean')).toEqual({ valid: true });
    expect(validateTopicPayload(1.5, 'number')).toEqual({ valid: true });
    expect(validateTopicPayload('idle', 'string')).toEqual({ valid: true });
    expect(validateTopicPayload(new Uint8Array(0), 'bytes')).toEqual({ valid: true });
  });

  it('rejects a mismatched representation type', () => {
    for (const [value, type] of [
      ['true', 'boolean'],
      [1, 'string'],
      [true, 'bytes'],
    ] as const) {
      const result = validateTopicPayload(value, type);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('schema/type-mismatch');
    }
  });

  it('rejects a non-finite number as a value problem', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateTopicPayload(value, 'number');
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('schema/invalid-value');
      expect(result.error?.message).toContain('must be finite');
    }
  });

  it('checks the fixed vector key set', () => {
    expect(validateTopicPayload({ x: 1, y: -2 }, 'vec2d')).toEqual({ valid: true });
    expect(validateTopicPayload({ x: 1, y: 2, z: 3 }, 'vec3d')).toEqual({ valid: true });

    expect(validateTopicPayload({ x: 1, y: 2, z: 3 }, 'vec2d').error?.code).toBe(
      'schema/unknown-field',
    );
    expect(validateTopicPayload({ x: 1 }, 'vec2d').error?.message).toContain(
      'payload.y: required component is missing',
    );
    expect(validateTopicPayload({ x: 1, y: Number.NaN }, 'vec2d').error?.code).toBe(
      'schema/invalid-value',
    );
    expect(validateTopicPayload({ x: 1, y: '2' }, 'vec2d').error?.code).toBe(
      'schema/type-mismatch',
    );
  });

  it('rejects an unknown payload type at runtime', () => {
    const result = validateTopicPayload(1, 'bytes<rgb666>' as TopicPayloadType);
    expect(result.valid).toBe(false);
    expect(result.error?.message).toContain('unknown payload type');
  });
});
