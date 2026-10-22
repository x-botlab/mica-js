import { describe, expect, it } from 'vitest';
import { catchError, codesOf } from '../../format/test-helpers';
import {
  createDeviceRegistry,
  type DevicePackageRegistration,
  type DeviceRegistrationEntry,
} from './registry';
import { parseDeviceReference } from './reference';

const MCU: DeviceRegistrationEntry = {
  id: 'stm32g431rbt6-lqfp64',
  displayName: 'STM32G431RBT6',
  description: 'LQFP64 MCU',
  symbol: {
    pins: {
      PC0: { x: -20, y: 0 },
      PC1: { x: -20, y: 10 },
    },
    bounds: { x: -30, y: -10, width: 60, height: 40 },
  },
  raw: { pins: { PC0: { direction: 'output' }, PC1: { direction: 'output' } } },
};

const LCD: DeviceRegistrationEntry = {
  id: 'ct117e-m4-tft-lcd-2-4',
  symbol: { name: 'TFT LCD', pins: { D0: { x: 0, y: 0 } } },
};

function packageOf(devices: readonly DeviceRegistrationEntry[]): DevicePackageRegistration {
  return { packageId: 'stm32-package', devices };
}

function codesOfRegister(run: () => void): readonly string[] {
  return codesOf(catchError(run).diagnostics);
}

describe('createDeviceRegistry', () => {
  it('resolves devices by reference or raw string', () => {
    const registry = createDeviceRegistry([packageOf([MCU, LCD])]);
    const device = registry.resolve('stm32-package:stm32g431rbt6-lqfp64');
    expect(device?.displayName).toBe('STM32G431RBT6');
    expect(device?.description).toBe('LQFP64 MCU');
    expect(device?.symbol?.name).toBe('STM32G431RBT6');
    expect(device?.symbol?.pins['PC0']).toEqual({ x: -20, y: 0 });
    expect(device?.symbol?.bounds).toEqual({ x: -30, y: -10, width: 60, height: 40 });

    expect(registry.resolve('stm32-package:ct117e-m4-tft-lcd-2-4')?.symbol?.name).toBe('TFT LCD');
    expect(registry.resolve('stm32-package:missing')).toBeUndefined();
    expect(registry.resolve('unknown:device')).toBeUndefined();
    expect(registry.resolve('not-a-reference')).toBeUndefined();
  });

  it('accepts a parsed reference', () => {
    const registry = createDeviceRegistry([packageOf([MCU])]);
    const reference = parseDeviceReference('stm32-package:stm32g431rbt6-lqfp64');
    expect(reference).toBeDefined();
    expect(reference === undefined ? undefined : registry.getDeviceSymbol(reference)?.name).toBe(
      'STM32G431RBT6',
    );
  });

  it('falls back to the device id for display and symbol names', () => {
    const registry = createDeviceRegistry([packageOf([LCD])]);
    expect(
      registry.getDeviceName(parseDeviceReference('stm32-package:ct117e-m4-tft-lcd-2-4')!),
    ).toBe('TFT LCD');
    expect(registry.getDeviceName(parseDeviceReference('stm32-package:missing')!)).toBeUndefined();

    const unnamed = createDeviceRegistry([packageOf([{ id: 'plain' }])]);
    expect(unnamed.getDeviceName(parseDeviceReference('stm32-package:plain')!)).toBe('plain');
  });

  it('keeps devices without symbol geometry and only warns', () => {
    const registry = createDeviceRegistry([packageOf([{ id: 'plain', displayName: 'Plain' }])]);
    const device = registry.resolve('stm32-package:plain');
    expect(device?.displayName).toBe('Plain');
    expect(device?.symbol).toBeUndefined();
    expect(registry.getDeviceSymbol(parseDeviceReference('stm32-package:plain')!)).toBeUndefined();
    expect(codesOf(registry.diagnostics)).toEqual(['device/no-symbol']);
  });

  it('rejects invalid and reserved package ids', () => {
    expect(
      codesOfRegister(() => createDeviceRegistry([{ packageId: 'bad id', devices: [] }])),
    ).toContain('device/invalid-package');
    expect(
      codesOfRegister(() => createDeviceRegistry([{ packageId: 'builtin', devices: [] }])),
    ).toContain('device/reserved-namespace');
  });

  it('requires replace when re-registering a package', () => {
    const registry = createDeviceRegistry([packageOf([MCU])]);
    expect(codesOfRegister(() => registry.registerPackage(packageOf([LCD])))).toContain(
      'device/duplicate-package',
    );
    expect(registry.resolve('stm32-package:stm32g431rbt6-lqfp64')).toBeDefined();

    registry.registerPackage(packageOf([LCD]), { replace: true });
    expect(registry.resolve('stm32-package:stm32g431rbt6-lqfp64')).toBeUndefined();
    expect(registry.resolve('stm32-package:ct117e-m4-tft-lcd-2-4')).toBeDefined();
  });

  it('rejects duplicate device ids within a package', () => {
    expect(codesOfRegister(() => createDeviceRegistry([packageOf([MCU, MCU])]))).toContain(
      'device/duplicate-device',
    );
  });

  it('rejects empty device ids', () => {
    expect(codesOfRegister(() => createDeviceRegistry([packageOf([{ id: '' }])]))).toContain(
      'device/invalid-description',
    );
  });

  it('rejects symbol pins that are absent from the pin declaration', () => {
    const entry: DeviceRegistrationEntry = {
      id: 'dev',
      symbol: { pins: { PC0: { x: 0, y: 0 }, PB1: { x: 1, y: 1 } } },
      raw: { pins: { PC0: { direction: 'output' } } },
    };
    const error = catchError(() => createDeviceRegistry([packageOf([entry])]));
    expect(codesOf(error.diagnostics).filter((code) => code === 'device/unknown-pin')).toHaveLength(
      1,
    );
  });

  it('accepts symbol pins when the description declares no pins', () => {
    const registry = createDeviceRegistry([packageOf([LCD])]);
    expect(registry.diagnostics).toEqual([]);
  });

  it('keeps pin sides and rejects invalid ones', () => {
    const registry = createDeviceRegistry([
      packageOf([
        {
          id: 'sided',
          symbol: {
            pins: {
              A: { x: -10, y: 0, side: 'left' },
              B: { x: 0, y: -10, side: 'top' },
            },
          },
        },
      ]),
    ]);
    expect(registry.resolve('stm32-package:sided')?.symbol?.pins).toEqual({
      A: { x: -10, y: 0, side: 'left' },
      B: { x: 0, y: -10, side: 'top' },
    });

    expect(
      codesOfRegister(() =>
        createDeviceRegistry([
          packageOf([
            {
              id: 'bad',
              symbol: { pins: { A: { x: 0, y: 0, side: 'middle' as never } } },
            },
          ]),
        ]),
      ),
    ).toContain('device/invalid-description');
  });

  it('derives symbol geometry from the pin declaration when no symbol is authored', () => {
    const registry = createDeviceRegistry([
      packageOf([
        {
          id: 'ldo',
          displayName: 'LDO',
          raw: {
            pins: {
              VIN: { side: 'top' },
              GND: { side: 'bottom' },
              EN: { side: 'left' },
              VOUT: { side: 'right' },
            },
          },
        },
      ]),
    ]);
    const symbol = registry.resolve('stm32-package:ldo')?.symbol;
    expect(symbol?.name).toBe('LDO');
    expect(symbol?.bounds).toBeDefined();
    expect(symbol?.pins['VIN']?.side).toBe('top');
    expect(symbol?.pins['GND']?.side).toBe('bottom');
    expect(symbol?.pins['EN']?.side).toBe('left');
    expect(symbol?.pins['VOUT']?.side).toBe('right');
    expect(registry.diagnostics).toEqual([]);
  });

  it('prefers authored symbol geometry over synthesis', () => {
    const registry = createDeviceRegistry([packageOf([MCU])]);
    expect(registry.resolve('stm32-package:stm32g431rbt6-lqfp64')?.symbol?.pins['PC0']).toEqual({
      x: -20,
      y: 0,
    });
  });

  it('rejects malformed symbol geometry', () => {
    expect(
      codesOfRegister(() =>
        createDeviceRegistry([packageOf([{ id: 'dev', symbol: {} as never }])]),
      ),
    ).toContain('device/invalid-description');

    expect(
      codesOfRegister(() =>
        createDeviceRegistry([
          packageOf([{ id: 'dev', symbol: { pins: { A: { x: Number.NaN, y: 0 } } } }]),
        ]),
      ),
    ).toContain('device/invalid-description');

    expect(
      codesOfRegister(() =>
        createDeviceRegistry([
          packageOf([
            {
              id: 'dev',
              symbol: {
                pins: {},
                bounds: { x: 0, y: 0, width: -1, height: Number.POSITIVE_INFINITY },
              },
            },
          ]),
        ]),
      ),
    ).toContain('device/invalid-description');
  });

  it('does not register a package when any device fails', () => {
    const registry = createDeviceRegistry([packageOf([MCU])]);
    expect(
      codesOfRegister(() =>
        registry.registerPackage({
          packageId: 'broken-package',
          devices: [LCD, { id: 'bad', symbol: { pins: { A: { x: 0, y: Number.NaN } } } }],
        }),
      ),
    ).toContain('device/invalid-description');
    expect(registry.resolve('broken-package:ct117e-m4-tft-lcd-2-4')).toBeUndefined();
  });

  it('lists devices deterministically', () => {
    const registry = createDeviceRegistry([
      { packageId: 'z-package', devices: [{ id: 'b' }, { id: 'a' }] },
      packageOf([MCU, LCD]),
    ]);
    expect(
      registry.listDevices().map((device) => `${device.packageId}:${device.deviceId}`),
    ).toEqual([
      'stm32-package:ct117e-m4-tft-lcd-2-4',
      'stm32-package:stm32g431rbt6-lqfp64',
      'z-package:a',
      'z-package:b',
    ]);
    expect(registry.listDevices('z-package')).toHaveLength(2);
    expect(registry.listDevices('missing')).toEqual([]);
  });

  it('keeps unknown description fields in raw', () => {
    const registry = createDeviceRegistry([packageOf([MCU])]);
    expect(registry.resolve('stm32-package:stm32g431rbt6-lqfp64')?.raw).toEqual({
      pins: { PC0: { direction: 'output' }, PC1: { direction: 'output' } },
    });
  });

  it('treats non-object raw descriptions as empty', () => {
    const registry = createDeviceRegistry([
      packageOf([{ id: 'dev', symbol: { pins: {} }, raw: 'oops' as never }]),
    ]);
    expect(registry.resolve('stm32-package:dev')?.raw).toEqual({});
  });

  it('reads the designator prefix from the entry or the description', () => {
    const registry = createDeviceRegistry([
      packageOf([
        { id: 'resistor', designatorPrefix: ' R ' },
        { id: 'display', raw: { designatorPrefix: 'DS' } },
        { id: 'chip' },
        { id: 'blank', designatorPrefix: '   ' },
      ]),
    ]);
    const prefix = (deviceId: string): string | undefined => {
      const reference = parseDeviceReference(`stm32-package:${deviceId}`);
      return reference === undefined ? undefined : registry.getDeviceDesignatorPrefix?.(reference);
    };
    expect(prefix('resistor')).toBe('R');
    expect(prefix('display')).toBe('DS');
    expect(prefix('chip')).toBeUndefined();
    expect(prefix('blank')).toBeUndefined();
    expect(prefix('missing')).toBeUndefined();
  });
});
