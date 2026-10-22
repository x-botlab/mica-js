import { describe, expect, it } from 'vitest';
import type { PropertyValue } from '@mica-js/core/schematic';
import { DeviceError, type DeviceErrorCode } from './errors';
import { parseDeviceDescription } from './description';
import { deepFreezeClone, resolveDeviceProperties } from './properties';

const DECLARED = {
  label: { type: 'string', default: 'MCU', maxLength: 4 },
  cores: { type: 'integer', default: 1, min: 1, max: 2 },
  speed: { type: 'number', default: 72, min: 1, max: 170, unit: 'MHz' },
  enabled: { type: 'boolean', default: true },
  accent: { type: 'color', default: '#3b82f6', alpha: true },
  orientation: {
    type: 'enum',
    default: 'landscape',
    options: [
      { value: 'landscape', label: '横向' },
      { value: 'portrait', label: '纵向' },
    ],
  },
  panel: {
    type: 'image',
    default: { src: 'assets/panel.png', mode: 'file' },
    maxBytes: 65536,
  },
  firmware: {
    type: 'binary',
    default: { src: 'assets/fw.bin', mode: 'file' },
    maxBytes: 1024,
  },
  optional: { type: 'string' },
  badDefault: { type: 'integer', default: 1.5 },
} as const;

function descriptionOf(properties: unknown = DECLARED) {
  return parseDeviceDescription({ properties }, { name: 'acme:demo' });
}

function expectCode(run: () => unknown, code: DeviceErrorCode, pointer?: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceError);
    expect((error as DeviceError).code).toBe(code);
    if (pointer !== undefined) {
      expect((error as DeviceError).pointer).toBe(pointer);
    }
    return;
  }
  throw new Error('Expected DeviceError.');
}

describe('resolveDeviceProperties', () => {
  it('fills defaults without keeping mutable aliases', () => {
    const snapshot = resolveDeviceProperties(descriptionOf());
    expect(snapshot['label']).toBe('MCU');
    expect(snapshot['cores']).toBe(1);
    expect(snapshot['speed']).toBe(72);
    expect(snapshot['enabled']).toBe(true);
    expect(snapshot['accent']).toBe('#3B82F6');
    expect(snapshot['orientation']).toBe('landscape');
    expect(snapshot['panel']).toEqual({ src: 'assets/panel.png', mode: 'file' });
    expect(snapshot['firmware']).toEqual({ src: 'assets/fw.bin', mode: 'file' });
    expect('optional' in snapshot).toBe(false);
    expect('badDefault' in snapshot).toBe(false);
  });

  it('applies instance overrides and normalizes colors', () => {
    const snapshot = resolveDeviceProperties(descriptionOf(), {
      label: 'LCD',
      cores: 2,
      accent: '#ff0000',
      panel: { src: 'assets/other.png', mode: 'inline' },
    });
    expect(snapshot['label']).toBe('LCD');
    expect(snapshot['cores']).toBe(2);
    expect(snapshot['accent']).toBe('#FF0000');
    expect(snapshot['panel']).toEqual({ src: 'assets/other.png', mode: 'inline' });
  });

  it('ignores undeclared override keys', () => {
    const snapshot = resolveDeviceProperties(descriptionOf(), {
      unknown: 1,
    } as unknown as Readonly<Record<string, PropertyValue>>);
    expect('unknown' in snapshot).toBe(false);
    expect(snapshot['label']).toBe('MCU');
  });

  it('treats an undefined override as absent', () => {
    const snapshot = resolveDeviceProperties(descriptionOf(), {
      label: undefined,
    } as unknown as Readonly<Record<string, PropertyValue>>);
    expect(snapshot['label']).toBe('MCU');
  });

  it('rejects invalid override values with #7 codes', () => {
    expectCode(
      () => resolveDeviceProperties(descriptionOf(), { label: 42 as never }),
      'schema/invalid-type',
    );
    expectCode(
      () => resolveDeviceProperties(descriptionOf(), { cores: 3 }),
      'schema/invalid-value',
      '/overrides/cores',
    );
    expectCode(
      () => resolveDeviceProperties(descriptionOf(), { enabled: 'yes' as never }),
      'schema/invalid-type',
    );
    expectCode(
      () => resolveDeviceProperties(descriptionOf(), { accent: 'red' }),
      'schema/invalid-value',
    );
    expectCode(
      () => resolveDeviceProperties(descriptionOf(), { orientation: 'diagonal' }),
      'schema/invalid-value',
    );
    expectCode(
      () => resolveDeviceProperties(descriptionOf(), { panel: 'assets/panel.png' }),
      'schema/invalid-type',
    );
    expectCode(
      () => resolveDeviceProperties(descriptionOf(), { label: null }),
      'schema/invalid-value',
    );
  });

  it('keeps an explicit null for nullable properties', () => {
    const description = descriptionOf({
      maybe: { type: 'string', default: 'value', nullable: true },
    });
    expect(resolveDeviceProperties(description, { maybe: null })['maybe']).toBeNull();
  });

  it('leaves a property without a usable default absent until overridden', () => {
    const description = descriptionOf({
      optional: { type: 'string' },
      badDefault: { type: 'integer', default: 1.5 },
    });
    expect('optional' in resolveDeviceProperties(description)).toBe(false);
    expect('badDefault' in resolveDeviceProperties(description)).toBe(false);
    expect(resolveDeviceProperties(description, { optional: 'set' })['optional']).toBe('set');
    expect(resolveDeviceProperties(description, { badDefault: 2 })['badDefault']).toBe(2);
  });

  it('rejects a non-object override bag', () => {
    expectCode(
      () =>
        resolveDeviceProperties(descriptionOf(), null as unknown as Record<string, PropertyValue>),
      'schema/invalid-type',
    );
    expectCode(
      () =>
        resolveDeviceProperties(descriptionOf(), [] as unknown as Record<string, PropertyValue>),
      'schema/invalid-type',
    );
    expectCode(
      () =>
        resolveDeviceProperties(
          descriptionOf(),
          new Map([['label', 'LCD']]) as unknown as Record<string, PropertyValue>,
        ),
      'schema/invalid-type',
      '/overrides',
    );
    expectCode(
      () =>
        resolveDeviceProperties(
          descriptionOf(),
          new Set() as unknown as Record<string, PropertyValue>,
        ),
      'schema/invalid-type',
    );
  });

  it('returns independent snapshots for separate instances', () => {
    const first = resolveDeviceProperties(descriptionOf());
    const second = resolveDeviceProperties(descriptionOf());
    expect(first).not.toBe(second);
    expect(first['panel']).not.toBe(second['panel']);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('isolates mutable aliases and freezes the whole value tree', () => {
    const overrides = { panel: { src: 'assets/first.png', mode: 'file' as const } };
    const snapshot = resolveDeviceProperties(descriptionOf(), overrides);
    overrides.panel.src = 'assets/second.png';
    expect(snapshot['panel']).toEqual({ src: 'assets/first.png', mode: 'file' });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot['panel'])).toBe(true);
    const mutable = snapshot as Record<string, unknown>;
    expect(() => {
      mutable['label'] = 'changed';
    }).toThrow(TypeError);
    const panel = snapshot['panel'] as { src: string; mode: string };
    expect(() => {
      panel.src = 'changed.png';
    }).toThrow(TypeError);
  });

  it('isolates defaults from later descriptor mutation', () => {
    const description = descriptionOf({
      panel: { type: 'image', default: { src: 'assets/panel.png', mode: 'file' } },
    });
    const descriptor = description.properties.get('panel');
    const reference = descriptor?.default as { src: string; mode: string };
    const snapshot = resolveDeviceProperties(description);
    reference.src = 'assets/changed.png';
    expect(snapshot['panel']).toEqual({ src: 'assets/panel.png', mode: 'file' });
  });

  it('deep-freezes nested objects and arrays', () => {
    const value = deepFreezeClone({ list: [{ nested: [1, 2] }] }) as {
      list: Array<{ nested: number[] }>;
    };
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(value.list[0]?.nested)).toBe(true);
    expect(() => {
      value.list.push({ nested: [3] });
    }).toThrow(TypeError);
  });
});
