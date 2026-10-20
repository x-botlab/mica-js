import { describe, expect, it } from 'vitest';
import {
  LABEL_DEVICE,
  formatDeviceReference,
  isLabelDevice,
  isReservedPackageId,
  isValidPackageId,
  parseDeviceReference,
} from './reference';

describe('parseDeviceReference', () => {
  it('splits package and device ids', () => {
    expect(parseDeviceReference('stm32-package:stm32g431rbt6-lqfp64')).toEqual({
      raw: 'stm32-package:stm32g431rbt6-lqfp64',
      packageId: 'stm32-package',
      deviceId: 'stm32g431rbt6-lqfp64',
    });
  });

  it('accepts scoped package ids', () => {
    expect(parseDeviceReference('@mica/devices:lcd')).toEqual({
      raw: '@mica/devices:lcd',
      packageId: '@mica/devices',
      deviceId: 'lcd',
    });
  });

  it('accepts the builtin label device', () => {
    expect(parseDeviceReference(LABEL_DEVICE)).toEqual({
      raw: 'builtin:label',
      packageId: 'builtin',
      deviceId: 'label',
    });
    expect(isLabelDevice(LABEL_DEVICE)).toBe(true);
    expect(isLabelDevice('builtin:other')).toBe(false);
  });

  it.each([
    '',
    ':lcd',
    'pkg:',
    'pkg',
    'pkg:a:b',
    'pkg:-lcd',
    '@scope:lcd',
    '@scope/name/extra:lcd',
    'pkg:a b',
  ])('rejects %j', (raw) => {
    expect(parseDeviceReference(raw)).toBeUndefined();
  });
});

describe('package id helpers', () => {
  it('validates package ids', () => {
    expect(isValidPackageId('stm32-package')).toBe(true);
    expect(isValidPackageId('@mica/devices')).toBe(true);
    expect(isValidPackageId('@mica')).toBe(false);
    expect(isValidPackageId('')).toBe(false);
  });

  it('treats builtin as a reserved namespace', () => {
    expect(isReservedPackageId('builtin')).toBe(true);
    expect(isReservedPackageId('builtin/extra')).toBe(true);
    expect(isReservedPackageId('builtins')).toBe(false);
  });

  it('formats references', () => {
    expect(formatDeviceReference('pkg', 'dev')).toBe('pkg:dev');
  });
});
