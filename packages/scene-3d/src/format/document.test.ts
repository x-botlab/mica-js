import { describe, expect, it } from 'vitest';
import { BUILTIN_MATERIAL_PRESETS, SCENE3D_VERSION } from '../index';
import type { EnvironmentConfig, Scene3DDocument, WorldConfig } from '../index';

const WORLD: WorldConfig = {
  gravity: { x: 0, y: -9.81, z: 0 },
  physicsStep: 1000 / 60,
  ground: {
    enabled: true,
    texture: 'assets/track-black-line.png',
    friction: 0.8,
    restitution: 0.1,
  },
};

const ENVIRONMENT: EnvironmentConfig = {
  ambientLight: { color: '#ffffff', intensity: 0.6 },
  directionalLight: {
    color: '#ffffff',
    intensity: 1.2,
    position: { x: 1, y: 2, z: 3 },
  },
  skybox: 'assets/skybox.hdr',
};

const DOCUMENT: Scene3DDocument = {
  version: SCENE3D_VERSION,
  schematic: 'robot.sch',
  world: WORLD,
  entities: [
    {
      id: 'base',
      type: 'model',
      name: '底盘',
      position: { x: 0, y: 0.003, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
  ],
  environment: ENVIRONMENT,
  materials: {
    presets: BUILTIN_MATERIAL_PRESETS,
    default: 'acrylic',
  },
};

describe('Scene3DDocument', () => {
  it('carries the current schema version', () => {
    expect(SCENE3D_VERSION).toBe(1);
    expect(DOCUMENT.version).toBe(SCENE3D_VERSION);
  });

  it('accepts a complete document with world, entities, environment and materials', () => {
    expect(DOCUMENT.world).toBe(WORLD);
    expect(DOCUMENT.world.gravity).toEqual({ x: 0, y: -9.81, z: 0 });
    expect(DOCUMENT.world.physicsStep).toBeCloseTo(16.67);
    expect(DOCUMENT.world.ground?.enabled).toBe(true);

    expect(DOCUMENT.entities).toHaveLength(1);
    expect(DOCUMENT.entities[0]).toMatchObject({
      id: 'base',
      type: 'model',
    });

    expect(DOCUMENT.environment.ambientLight.intensity).toBeGreaterThan(0);
    expect(DOCUMENT.environment.directionalLight?.position).toEqual({ x: 1, y: 2, z: 3 });

    const defaultName = DOCUMENT.materials?.default ?? 'acrylic';
    expect(DOCUMENT.materials?.presets[defaultName]).toBe(BUILTIN_MATERIAL_PRESETS.acrylic);
  });

  it('allows every optional section to be omitted', () => {
    const minimal: Scene3DDocument = {
      version: SCENE3D_VERSION,
      world: {
        gravity: { x: 0, y: -9.81, z: 0 },
        physicsStep: 16.67,
      },
      entities: [],
      environment: {
        ambientLight: { color: '#ffffff', intensity: 1 },
      },
    };

    expect(minimal.schematic).toBeUndefined();
    expect(minimal.materials).toBeUndefined();
    expect(minimal.world.ground).toBeUndefined();
    expect(minimal.environment.directionalLight).toBeUndefined();
    expect(minimal.environment.skybox).toBeUndefined();
  });

  it('stores an empty entity list without requiring entity-specific types', () => {
    const empty: Scene3DDocument = {
      ...DOCUMENT,
      entities: [],
    };

    expect(empty.entities).toEqual([]);
  });
});
