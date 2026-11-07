import { describe, expect, it } from 'vitest';
import { Quaternion, Vec3d } from '../math';
import {
  BODY_TYPES,
  ENTITY_TYPES,
  GEOMETRY_TYPES,
  type AssemblyInstance,
  type ColliderDescriptor,
  type GeometryDescriptor,
  type JointEntity,
  type MaterialDescriptor,
  type ModelEntity,
  type PhysicsConfig,
  type SceneEntity,
  type SensorEntity,
} from './index';

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

/** Exhaustive switch used to prove that every geometry variant narrows to its own payload. */
function describeGeometry(geometry: GeometryDescriptor): string {
  switch (geometry.type) {
    case 'box':
      return `box ${geometry.size.x}x${geometry.size.y}x${geometry.size.z}`;
    case 'sphere':
      return `sphere r=${geometry.radius}`;
    case 'cylinder':
      return `cylinder r=${geometry.radius} h=${geometry.height}`;
    case 'capsule':
      return `capsule r=${geometry.radius} h=${geometry.height}`;
    case 'plane':
      return `plane ${geometry.size.x}x${geometry.size.y}`;
    case 'acrylic':
      return `acrylic ${geometry.acrylic.thickness}mm`;
    default:
      return assertNever(geometry);
  }
}

describe('entity type catalogue', () => {
  it('exposes the entity kinds from the design document', () => {
    expect(ENTITY_TYPES).toEqual(['model', 'assembly', 'joint', 'sensor']);
  });

  it('accepts static, dynamic and kinematic rigid bodies', () => {
    expect(BODY_TYPES).toEqual(['static', 'dynamic', 'kinematic']);

    const configs: readonly PhysicsConfig[] = BODY_TYPES.map((bodyType) => ({ bodyType }));

    expect(configs.map((config) => config.bodyType)).toEqual([...BODY_TYPES]);
  });

  it('lists every primitive geometry kind', () => {
    expect(GEOMETRY_TYPES).toEqual(['box', 'sphere', 'cylinder', 'capsule', 'plane', 'acrylic']);
  });
});

describe('SceneEntity', () => {
  it('describes an entity by identity, kind and initial pose', () => {
    const entity: SceneEntity = {
      id: 'entity-1',
      type: 'model',
      position: { x: 1, y: 2, z: 3 },
      rotation: Quaternion.identity,
    };

    expect(entity.id).toBe('entity-1');
    expect(entity.type).toBe('model');
    expect(entity.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(entity.name).toBeUndefined();
    expect(entity).not.toHaveProperty('symbol');
  });
});

describe('AssemblyInstance', () => {
  it('references an assembly definition instead of binding a schematic symbol', () => {
    const instance: AssemblyInstance = {
      id: 'robot-1',
      type: 'assembly',
      position: { x: 0, y: 0, z: 0 },
      rotation: Quaternion.identity,
      assembly: 'robotics:robot-car',
    };

    const tuned: AssemblyInstance = {
      ...instance,
      id: 'robot-2',
      overrides: { maxSpeed: 1.5 },
    };

    expect(instance.assembly).toBe('robotics:robot-car');
    expect(instance.overrides).toBeUndefined();
    expect(tuned.overrides).toEqual({ maxSpeed: 1.5 });
    expect(instance).not.toHaveProperty('symbol');
  });
});

describe('GeometryDescriptor', () => {
  it('narrows each primitive shape by its discriminant', () => {
    const geometries: readonly GeometryDescriptor[] = [
      { type: 'box', size: { x: 1, y: 2, z: 3 } },
      { type: 'sphere', radius: 0.5 },
      { type: 'cylinder', radius: 0.25, height: 1 },
      { type: 'capsule', radius: 0.1, height: 0.5 },
      { type: 'plane', size: { x: 4, y: 2 } },
      {
        type: 'acrylic',
        acrylic: { contour: { type: 'rect', width: 0.01, height: 0.005 }, thickness: 0.003 },
      },
    ];

    expect(geometries.map((geometry) => geometry.type)).toEqual([...GEOMETRY_TYPES]);
    expect(geometries.map(describeGeometry)).toEqual([
      'box 1x2x3',
      'sphere r=0.5',
      'cylinder r=0.25 h=1',
      'capsule r=0.1 h=0.5',
      'plane 4x2',
      'acrylic 0.003mm',
    ]);
  });
});

describe('MaterialDescriptor', () => {
  it('requires friction and restitution but keeps rendering fields optional', () => {
    const minimal: MaterialDescriptor = { friction: 0.6, restitution: 0.2 };
    const full: MaterialDescriptor = {
      color: '#80c0ff',
      texture: 'textures/acrylic.png',
      metalness: 0.1,
      roughness: 0.4,
      opacity: 0.85,
      friction: 0.6,
      restitution: 0.2,
    };

    expect(minimal.color).toBeUndefined();
    expect(full.opacity).toBe(0.85);
  });
});

describe('ColliderDescriptor', () => {
  it('supports primitive, generated and compound colliders', () => {
    const colliders: readonly ColliderDescriptor[] = [
      { type: 'box', size: { x: 1, y: 1, z: 1 } },
      { type: 'sphere', radius: 0.5 },
      { type: 'cylinder', radius: 0.25, height: 1 },
      { type: 'capsule', radius: 0.25, height: 1 },
      { type: 'trimesh', source: 'geometry' },
      { type: 'convex-hull', source: 'geometry' },
      {
        type: 'compound',
        children: [
          { type: 'box', size: { x: 1, y: 1, z: 1 } },
          { type: 'sphere', radius: 0.5 },
        ],
      },
    ];

    expect(colliders.map((collider) => collider.type)).toEqual([
      'box',
      'sphere',
      'cylinder',
      'capsule',
      'trimesh',
      'convex-hull',
      'compound',
    ]);
  });
});

describe('PhysicsConfig', () => {
  it('carries mass, velocity and per-axis constraints', () => {
    const physics: PhysicsConfig = {
      bodyType: 'dynamic',
      mass: 0.25,
      velocity: { x: 0, y: 0, z: -1 },
      angularVelocity: { x: 0, y: 2, z: 0 },
      constraints: {
        freezePosition: { x: true, y: false, z: true },
        freezeRotation: { x: true },
      },
    };

    expect(physics.mass).toBe(0.25);
    expect(physics.velocity).toEqual({ x: 0, y: 0, z: -1 });
    expect(physics.angularVelocity).toEqual({ x: 0, y: 2, z: 0 });
    expect(physics.constraints?.freezePosition?.x).toBe(true);
    expect(physics.constraints?.freezeRotation?.y).toBeUndefined();
  });
});

describe('ModelEntity', () => {
  it('composes geometry, material, collider and physics on top of the base pose', () => {
    const model: ModelEntity = {
      id: 'ground',
      type: 'model',
      name: 'Ground',
      position: Vec3d.zero,
      rotation: Quaternion.identity,
      geometry: { type: 'plane', size: { x: 10, y: 10 } },
      material: { friction: 0.8, restitution: 0.1 },
      collider: { type: 'box', size: { x: 10, y: 0.1, z: 10 } },
      physics: {
        bodyType: 'static',
        constraints: { freezePosition: { x: true, y: true, z: true } },
      },
    };

    expect(model.type).toBe('model');
    expect(model.geometry.type).toBe('plane');
    expect(model.material.friction).toBe(0.8);
    expect(model.collider.type).toBe('box');
    expect(model.physics.bodyType).toBe('static');
  });
});

describe('JointEntity', () => {
  it('binds multiple ports (torque, position, velocity) to schematic', () => {
    const joint: JointEntity = {
      id: 'left-motor',
      type: 'joint',
      position: Vec3d.zero,
      rotation: Quaternion.identity,
      jointType: 'revolute',
      bodyA: 'chassis',
      bodyB: 'left-wheel',
      axis: { x: 1, y: 0, z: 0 },
      bindings: {
        torque: { symbol: 'motor-left', port: 'torque' },
        position: { symbol: 'encoder-left', port: 'position' },
      },
    };

    expect(joint.type).toBe('joint');
    expect(joint.bindings).toEqual({
      torque: { symbol: 'motor-left', port: 'torque' },
      position: { symbol: 'encoder-left', port: 'position' },
    });
  });

  it('keeps bindings optional for passive joints', () => {
    const passive: JointEntity = {
      id: 'caster',
      type: 'joint',
      position: Vec3d.zero,
      rotation: Quaternion.identity,
      jointType: 'fixed',
      bodyA: 'chassis',
    };

    expect(passive.bindings).toBeUndefined();
    expect(passive.bodyB).toBeUndefined();
  });
});

describe('SensorEntity', () => {
  it('publishes readings through schematic ports', () => {
    const sensor: SensorEntity = {
      id: 'front-distance',
      type: 'sensor',
      position: { x: 0.1, y: 0.05, z: 0 },
      rotation: Quaternion.identity,
      sensorType: 'distance',
      config: { type: 'distance', maxRange: 2, fov: 15, updateRate: 10 },
      bindings: {
        distance: { symbol: 'sonar-front', port: 'distance' },
      },
    };

    expect(sensor.type).toBe('sensor');
    expect(sensor.bindings).toEqual({
      distance: { symbol: 'sonar-front', port: 'distance' },
    });
  });

  it('allows an unbound sensor', () => {
    const unbound: SensorEntity = {
      id: 'debug-distance',
      type: 'sensor',
      position: Vec3d.zero,
      rotation: Quaternion.identity,
      sensorType: 'distance',
      config: { type: 'distance', maxRange: 2, fov: 15, updateRate: 10 },
    };

    expect(unbound.bindings).toBeUndefined();
  });
});

/** Exhaustive switch used to prove each entity kind narrows to its concrete interface. */
function describeEntity(
  entity: ModelEntity | AssemblyInstance | JointEntity | SensorEntity,
): string {
  switch (entity.type) {
    case 'model':
      return `model ${entity.geometry.type}`;
    case 'assembly':
      return `assembly ${entity.assembly}`;
    case 'joint':
      return `joint ${entity.bindings?.torque?.symbol ?? 'passive'}`;
    case 'sensor':
      return `sensor ${Object.keys(entity.bindings ?? {})[0] ?? 'unbound'}`;
    default:
      return assertNever(entity);
  }
}

describe('entity kinds', () => {
  it('narrows every discriminant to its concrete interface', () => {
    const entities: readonly (ModelEntity | AssemblyInstance | JointEntity | SensorEntity)[] = [
      {
        id: 'plate',
        type: 'model',
        position: Vec3d.zero,
        rotation: Quaternion.identity,
        geometry: { type: 'box', size: { x: 1, y: 1, z: 1 } },
        material: { friction: 0.5, restitution: 0.1 },
        collider: { type: 'box', size: { x: 1, y: 1, z: 1 } },
        physics: { bodyType: 'static' },
      },
      {
        id: 'robot',
        type: 'assembly',
        position: Vec3d.zero,
        rotation: Quaternion.identity,
        assembly: 'robotics:robot-car',
      },
      {
        id: 'motor',
        type: 'joint',
        position: Vec3d.zero,
        rotation: Quaternion.identity,
        jointType: 'revolute',
        bodyA: 'floor',
        axis: { x: 0, y: 1, z: 0 },
        bindings: {
          torque: { symbol: 'motor-left', port: 'torque' },
        },
      },
      {
        id: 'sonar',
        type: 'sensor',
        position: Vec3d.zero,
        rotation: Quaternion.identity,
        sensorType: 'distance',
        config: { type: 'distance', maxRange: 2, fov: 15, updateRate: 10 },
        bindings: {
          distance: { symbol: 'sonar-front', port: 'distance' },
        },
      },
    ];

    expect(entities.map((entity) => entity.type)).toEqual([...ENTITY_TYPES]);
    expect(entities.map(describeEntity)).toEqual([
      'model box',
      'assembly robotics:robot-car',
      'joint motor-left',
      'sensor distance',
    ]);
  });
});
