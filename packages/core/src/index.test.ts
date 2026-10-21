import { describe, expect, it } from 'vitest';
import { MICA_CORE_VERSION } from './index';

describe('@mica-js/core pipeline', () => {
  it('exposes the package version', () => {
    expect(MICA_CORE_VERSION).toBe('0.0.0');
  });
});
