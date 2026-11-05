import { describe, expect, it } from 'vitest';
import { isUuidV4 } from './uuid';

describe('isUuidV4', () => {
  it('accepts a canonical version 4 UUID', () => {
    expect(isUuidV4('9f4b1c1e-8f8f-4b5a-9e7a-3d5c2b1a0f4e')).toBe(true);
    expect(isUuidV4('00000000-0000-4000-8000-000000000000')).toBe(true);
  });

  it('accepts every variant nibble', () => {
    for (const variant of ['8', '9', 'a', 'b', 'A', 'B']) {
      expect(isUuidV4(`123e4567-e89b-42d3-${variant}456-426614174000`)).toBe(true);
    }
  });

  it('rejects a non-4 version nibble', () => {
    expect(isUuidV4('9f4b1c1e-8f8f-1b5a-9e7a-3d5c2b1a0f4e')).toBe(false);
    expect(isUuidV4('9f4b1c1e-8f8f-5b5a-9e7a-3d5c2b1a0f4e')).toBe(false);
  });

  it('rejects an invalid variant nibble', () => {
    expect(isUuidV4('9f4b1c1e-8f8f-4b5a-1e7a-3d5c2b1a0f4e')).toBe(false);
    expect(isUuidV4('9f4b1c1e-8f8f-4b5a-c0de-3d5c2b1a0f4e')).toBe(false);
  });

  it('rejects malformed shapes', () => {
    expect(isUuidV4('')).toBe(false);
    expect(isUuidV4('not-a-uuid')).toBe(false);
    expect(isUuidV4('9f4b1c1e8f8f4b5a9e7a3d5c2b1a0f4e')).toBe(false);
    expect(isUuidV4('9f4b1c1e-8f8f-4b5a-9e7a-3d5c2b1a0f4')).toBe(false);
    expect(isUuidV4('9f4b1c1e-8f8f-4b5a-9e7a-3d5c2b1a0f4e-extra')).toBe(false);
    expect(isUuidV4('9f4b1c1e-8f8f-4b5a-9e7a-3d5c2b1a0f4z')).toBe(false);
    expect(isUuidV4(' 9f4b1c1e-8f8f-4b5a-9e7a-3d5c2b1a0f4e')).toBe(false);
  });
});
