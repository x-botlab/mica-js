import { describe, expect, it } from 'vitest';
import {
  normalizeColor,
  normalizePropertyValue,
  parsePropertyDescriptor,
  propertyValueProblem,
  readPropertyDescriptors,
  type PropertyDescriptor,
} from './properties';

const DECLARED = {
  label: { type: 'string', title: '名称', default: 'MCU', maxLength: 4 },
  cores: { type: 'integer', default: 1, min: 1, max: 2 },
  speed: {
    type: 'number',
    default: 72,
    min: 1,
    max: 170,
    exclusiveMin: 0,
    step: 1,
    unit: 'MHz',
  },
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
    maxPixels: 4096,
  },
  firmware: {
    type: 'binary',
    default: { src: 'assets/fw.bin', mode: 'file' },
    maxBytes: 1024,
  },
} as const;

function descriptorOf(raw: unknown, key = 'p'): PropertyDescriptor {
  const descriptor = parsePropertyDescriptor(key, raw);
  if (descriptor === undefined) {
    throw new Error(`expected a descriptor for ${JSON.stringify(raw)}`);
  }
  return descriptor;
}

describe('property descriptors', () => {
  it('parses every #7 type with its constraints', () => {
    const descriptors = readPropertyDescriptors(DECLARED);
    expect([...descriptors.keys()]).toEqual([
      'label',
      'cores',
      'speed',
      'enabled',
      'accent',
      'orientation',
      'panel',
      'firmware',
    ]);
    expect(descriptors.get('label')).toEqual({
      key: 'label',
      type: 'string',
      title: '名称',
      default: 'MCU',
      maxLength: 4,
    });
    expect(descriptors.get('speed')).toEqual({
      key: 'speed',
      type: 'number',
      default: 72,
      min: 1,
      max: 170,
      exclusiveMin: 0,
      step: 1,
      unit: 'MHz',
    });
    expect(descriptors.get('accent')).toEqual({
      key: 'accent',
      type: 'color',
      default: '#3b82f6',
      alpha: true,
    });
    expect(descriptors.get('orientation')?.options).toHaveLength(2);
    expect(descriptors.get('panel')).toMatchObject({ maxBytes: 65536, maxPixels: 4096 });
    expect(descriptors.get('firmware')).toMatchObject({ maxBytes: 1024 });
  });

  it('skips declarations that are not usable', () => {
    const descriptors = readPropertyDescriptors({
      unknown: { type: 'widget' },
      noOptions: { type: 'enum', options: [] },
      duplicateOptions: {
        type: 'enum',
        options: [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'B' },
        ],
      },
      notAnObject: 3,
      ok: { type: 'boolean', default: true },
    });
    expect([...descriptors.keys()]).toEqual(['ok']);
    expect(readPropertyDescriptors(undefined).size).toBe(0);
    expect(readPropertyDescriptors([1]).size).toBe(0);
  });

  it('drops a default that breaks its own constraints', () => {
    expect(
      parsePropertyDescriptor('speed', { type: 'number', default: 999, max: 170 })?.default,
    ).toBeUndefined();
    expect(
      parsePropertyDescriptor('mode', {
        type: 'enum',
        default: 'x',
        options: [{ value: 'a', label: 'A' }],
      })?.default,
    ).toBeUndefined();
  });
});

describe('property values', () => {
  it('checks scalars against the declared type and bounds', () => {
    expect(propertyValueProblem(descriptorOf(DECLARED.label), 'MCU')).toBeUndefined();
    expect(propertyValueProblem(descriptorOf(DECLARED.label), 'MCUXS')).toMatchObject({
      code: 'schema/invalid-value',
    });
    expect(propertyValueProblem(descriptorOf(DECLARED.label), 3)?.code).toBe('schema/invalid-type');
    expect(propertyValueProblem(descriptorOf(DECLARED.cores), 2)).toBeUndefined();
    expect(propertyValueProblem(descriptorOf(DECLARED.cores), 1.5)?.code).toBe(
      'schema/invalid-type',
    );
    expect(propertyValueProblem(descriptorOf(DECLARED.cores), 3)?.code).toBe(
      'schema/invalid-value',
    );
    expect(propertyValueProblem(descriptorOf(DECLARED.speed), 0)?.code).toBe(
      'schema/invalid-value',
    );
    expect(propertyValueProblem(descriptorOf(DECLARED.speed), Number.NaN)?.code).toBe(
      'schema/invalid-type',
    );
    expect(propertyValueProblem(descriptorOf(DECLARED.enabled), false)).toBeUndefined();
    expect(propertyValueProblem(descriptorOf(DECLARED.enabled), 'true')?.code).toBe(
      'schema/invalid-type',
    );
  });

  it('checks colors, enums and resource references', () => {
    expect(propertyValueProblem(descriptorOf(DECLARED.accent), '#3b82f6')).toBeUndefined();
    expect(propertyValueProblem(descriptorOf(DECLARED.accent), 'blue')?.code).toBe(
      'schema/invalid-value',
    );
    expect(propertyValueProblem(descriptorOf(DECLARED.orientation), 'portrait')).toBeUndefined();
    expect(propertyValueProblem(descriptorOf(DECLARED.orientation), 'other')?.code).toBe(
      'schema/invalid-value',
    );
    expect(
      propertyValueProblem(descriptorOf(DECLARED.firmware), {
        src: 'assets/fw.bin',
        mode: 'file',
      }),
    ).toBeUndefined();
    expect(
      propertyValueProblem(descriptorOf(DECLARED.firmware), { src: 'assets/fw.bin' })?.code,
    ).toBe('schema/invalid-type');
    expect(propertyValueProblem(descriptorOf(DECLARED.panel), 'assets/panel.png')?.code).toBe(
      'schema/invalid-type',
    );
  });

  it('accepts null only for nullable declarations', () => {
    expect(propertyValueProblem(descriptorOf({ type: 'string' }), null)?.code).toBe(
      'schema/invalid-value',
    );
    expect(propertyValueProblem(descriptorOf({ type: 'string', nullable: true }), null)).toBe(
      undefined,
    );
  });

  it('normalizes colors to upper case', () => {
    expect(normalizeColor('#3b82f6')).toBe('#3B82F6');
    expect(normalizeColor('#3b82f680')).toBe('#3B82F680');
    expect(normalizeColor('3b82f6')).toBeUndefined();
    const accent = descriptorOf(DECLARED.accent);
    expect(normalizePropertyValue(accent, '#3b82f6')).toBe('#3B82F6');
    expect(normalizePropertyValue(descriptorOf(DECLARED.label), 'MCU')).toBe('MCU');
  });
});
