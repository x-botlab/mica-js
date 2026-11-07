import { describe, expect, it } from 'vitest';
import { BUILTIN_MATERIAL_PRESETS } from '../../format/materials';
import { computeAcrylicPhysics, resolveAcrylicMaterial } from './physics';

const plate = (width = 0.1, height = 0.1, thickness = 0.003) => ({
  contour: { type: 'rect' as const, width, height },
  thickness,
});

describe('acrylic physics', () => {
  it('computes standard acrylic mass in SI units', () => {
    // 0.1 m × 0.1 m × 0.003 m × 1180 kg/m³ = 0.0354 kg.
    expect(computeAcrylicPhysics(plate()).mass).toBeCloseTo(0.0354, 4);
  });

  it('scales mass with plate area', () => {
    const base = computeAcrylicPhysics(plate()).mass;
    expect(computeAcrylicPhysics(plate(0.2, 0.2)).mass / base).toBeCloseTo(4);
  });

  it('uses thin-plate principal inertia and bounding radius', () => {
    const physics = computeAcrylicPhysics(plate(0.1, 0.2));
    const mass = physics.mass;
    expect(physics.inertia.y).toBeCloseTo((mass * (0.1 ** 2 + 0.2 ** 2)) / 12);
    expect(physics.inertia.x).toBeGreaterThan(physics.inertia.z);
    expect(physics.boundingRadius).toBeCloseTo(Math.hypot(0.05, 0.1, 0.0015), 5);
  });

  it('resolves default and local material presets', () => {
    const library = {
      presets: {
        ...BUILTIN_MATERIAL_PRESETS,
        custom: {
          ...BUILTIN_MATERIAL_PRESETS.acrylic,
          density: 2,
          friction: 0.2,
          restitution: 0.1,
        },
      },
      default: 'custom',
    };
    expect(computeAcrylicPhysics(plate(), { library }).mass).toBeCloseTo(0.06, 4);
    expect(
      computeAcrylicPhysics({ ...plate(), material: { preset: 'custom', density: 3 } }, { library })
        .mass,
    ).toBeCloseTo(0.09, 4);
  });

  it('selects deterministic collider strategies', () => {
    expect(computeAcrylicPhysics(plate()).collider).toEqual({
      type: 'trimesh',
      source: 'geometry',
    });
    expect(computeAcrylicPhysics(plate(), { convex: true }).collider).toEqual({
      type: 'convex-hull',
      source: 'geometry',
    });
  });

  it('treats a document library as additive over the built-in presets', () => {
    // The document only declares its own preset; `acrylic` must still resolve from the built-ins.
    const library = {
      presets: {
        'carbon-plate': {
          displayName: '碳纤板',
          density: 1.6,
          friction: 0.4,
          restitution: 0.2,
        },
      },
      default: 'carbon-plate',
    };
    expect(computeAcrylicPhysics(plate(), { library }).mass).toBeCloseTo(0.048, 4);
    expect(
      computeAcrylicPhysics({ ...plate(), material: 'acrylic' }, { library }).mass,
    ).toBeCloseTo(0.0354, 4);
    expect(resolveAcrylicMaterial(plate(), library).preset).toBe('carbon-plate');
    expect(resolveAcrylicMaterial({ ...plate(), material: 'acrylic' }, library).preset).toBe(
      'acrylic',
    );
  });

  it('lets local overrides win over document presets and exposes presentation fields', () => {
    const library = {
      presets: {
        smoked: {
          displayName: '茶色亚克力',
          density: 1.18,
          friction: 0.5,
          restitution: 0.3,
          color: '#334455',
          opacity: 0.6,
          texture: 'assets/track.png',
        },
      },
      default: 'smoked',
    };
    const resolved = resolveAcrylicMaterial(
      { ...plate(), material: { preset: 'smoked', color: '#ff0000', opacity: 0.9 } },
      library,
    );
    expect(resolved).toMatchObject({
      preset: 'smoked',
      color: '#ff0000',
      opacity: 0.9,
      texture: 'assets/track.png',
    });
  });

  it('rejects unknown presets', () => {
    expect(() => computeAcrylicPhysics({ ...plate(), material: 'nope' })).toThrow(
      /Unknown acrylic material preset/,
    );
  });
});
