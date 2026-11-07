import { describe, expect, it } from 'vitest';
import { BUILTIN_MATERIAL_PRESETS } from '../index';
import type { MaterialLibrary, MaterialPreset } from '../index';

const REQUIRED_PRESET_KEYS = [
  'acrylic',
  'acrylic-colored',
  'pc-board',
  'wood',
  'aluminum',
  'steel',
  'pla',
  'abs',
  'petg',
  'tpu',
  'pvc',
  'pp',
  'nylon',
] as const;

/** All coefficients the physics and rendering layers treat as unit-interval values. */
function expectUnitInterval(value: number | undefined): void {
  if (value === undefined) {
    return;
  }
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}

const PRESETS: ReadonlyArray<readonly [string, MaterialPreset]> =
  Object.entries(BUILTIN_MATERIAL_PRESETS);

describe('BUILTIN_MATERIAL_PRESETS', () => {
  it('ships the original sheet materials plus the 3D-printing and common plastics', () => {
    expect(PRESETS).toHaveLength(13);

    for (const name of REQUIRED_PRESET_KEYS) {
      expect(BUILTIN_MATERIAL_PRESETS[name]).toBeDefined();
    }
  });

  it('keeps every physical property within a plausible range', () => {
    for (const [name, preset] of PRESETS) {
      expect(preset.displayName.length, `${name} has a display name`).toBeGreaterThan(0);
      expect(preset.density, `${name} has a positive density`).toBeGreaterThan(0);

      expectUnitInterval(preset.friction);
      expectUnitInterval(preset.restitution);

      // Visual defaults are optional, but when present they must be valid.
      if (preset.color !== undefined) {
        expect(preset.color).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expectUnitInterval(preset.opacity);
      expectUnitInterval(preset.metalness);
      expectUnitInterval(preset.roughness);
    }
  });

  it('preserves the original six material presets', () => {
    expect(BUILTIN_MATERIAL_PRESETS.acrylic).toMatchObject({
      density: 1.18,
      friction: 0.5,
      restitution: 0.3,
    });
    expect(BUILTIN_MATERIAL_PRESETS['acrylic-colored']).toMatchObject({
      density: 1.18,
      friction: 0.5,
      restitution: 0.3,
    });
    expect(BUILTIN_MATERIAL_PRESETS['pc-board']).toMatchObject({
      density: 1.2,
      friction: 0.4,
      restitution: 0.5,
    });
    expect(BUILTIN_MATERIAL_PRESETS.wood).toMatchObject({
      density: 0.65,
      friction: 0.6,
      restitution: 0.2,
    });
    expect(BUILTIN_MATERIAL_PRESETS.aluminum).toMatchObject({
      density: 2.7,
      friction: 0.3,
      restitution: 0.4,
    });
    expect(BUILTIN_MATERIAL_PRESETS.steel).toMatchObject({
      density: 7.85,
      friction: 0.4,
      restitution: 0.3,
    });
  });

  it('uses the specified physical values for 3D-printing filaments', () => {
    expect(BUILTIN_MATERIAL_PRESETS.pla).toMatchObject({
      density: 1.24,
      friction: 0.5,
      restitution: 0.2,
    });
    expect(BUILTIN_MATERIAL_PRESETS.abs).toMatchObject({
      density: 1.05,
      friction: 0.4,
      restitution: 0.3,
    });
    expect(BUILTIN_MATERIAL_PRESETS.petg).toMatchObject({
      density: 1.27,
      friction: 0.45,
      restitution: 0.25,
    });
    expect(BUILTIN_MATERIAL_PRESETS.tpu).toMatchObject({
      density: 1.2,
      friction: 0.7,
      restitution: 0.5,
    });
  });

  it('uses the specified physical values for common plastics', () => {
    expect(BUILTIN_MATERIAL_PRESETS.pvc).toMatchObject({
      density: 1.38,
      friction: 0.5,
      restitution: 0.2,
    });
    expect(BUILTIN_MATERIAL_PRESETS.pp).toMatchObject({
      density: 0.9,
      friction: 0.3,
      restitution: 0.4,
    });
    expect(BUILTIN_MATERIAL_PRESETS.nylon).toMatchObject({
      density: 1.14,
      friction: 0.25,
      restitution: 0.35,
    });
  });

  it('gives every 3D-printing and plastic preset visual defaults', () => {
    for (const name of ['pla', 'abs', 'petg', 'tpu', 'pvc', 'pp', 'nylon'] as const) {
      const preset = BUILTIN_MATERIAL_PRESETS[name];

      expect(preset.color, `${name} has a color`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.opacity, `${name} has an opacity`).toBeDefined();
      expect(preset.metalness, `${name} has a metalness`).toBeDefined();
      expect(preset.roughness, `${name} has a roughness`).toBeDefined();
    }
  });

  it('is deeply frozen so documents can share it', () => {
    expect(Object.isFrozen(BUILTIN_MATERIAL_PRESETS)).toBe(true);
    for (const [, preset] of PRESETS) {
      expect(Object.isFrozen(preset)).toBe(true);
    }
  });

  it('can back a scene-level material library', () => {
    const library: MaterialLibrary = {
      presets: BUILTIN_MATERIAL_PRESETS,
      default: 'acrylic',
    };

    const defaultName = library.default ?? 'acrylic';
    expect(library.presets[defaultName]).toBe(BUILTIN_MATERIAL_PRESETS.acrylic);
  });
});
