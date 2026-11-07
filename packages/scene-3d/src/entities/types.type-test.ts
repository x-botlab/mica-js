import type { Quaternion, Vec2d, Vec3d } from '../math';
import type {
  AssemblyInstance,
  BodyType,
  ColliderDescriptor,
  EntityType,
  GeometryDescriptor,
  JointEntity,
  MaterialDescriptor,
  ModelEntity,
  PhysicsConfig,
  SceneEntity,
  SensorEntity,
} from './index';

declare const position: Vec3d;
declare const rotation: Quaternion;
declare const planeSize: Vec2d;

const entity: SceneEntity = {
  id: 'entity',
  type: 'model',
  name: 'Entity',
  position,
  rotation,
};

const entityTypes: readonly EntityType[] = ['model', 'assembly', 'joint', 'sensor'];
const bodyTypes: readonly BodyType[] = ['static', 'dynamic', 'kinematic'];

const material: MaterialDescriptor = {
  color: '#80c0ff',
  texture: 'textures/acrylic.png',
  metalness: 0.1,
  roughness: 0.4,
  opacity: 0.85,
  friction: 0.6,
  restitution: 0.2,
};

const model: ModelEntity = {
  ...entity,
  type: 'model',
  geometry: { type: 'box', size: position },
  material,
  collider: { type: 'compound', children: [{ type: 'convex-hull', source: 'geometry' }] },
  physics: {
    bodyType: 'dynamic',
    mass: 1.5,
    velocity: position,
    angularVelocity: position,
    constraints: { freezePosition: { x: true }, freezeRotation: { z: false } },
  },
};

const asSceneEntity: SceneEntity = model;

const assembly: AssemblyInstance = {
  id: 'robot',
  type: 'assembly',
  position,
  rotation,
  assembly: 'robotics:robot-car',
  overrides: { maxSpeed: 1.5 },
};

const joint: JointEntity = {
  id: 'left-motor',
  type: 'joint',
  position,
  rotation,
  bindings: {
    torque: { symbol: 'motor-left', port: 'torque' },
    position: { symbol: 'encoder-left', port: 'position' },
  },
};

const sensor: SensorEntity = {
  id: 'sonar',
  type: 'sensor',
  position,
  rotation,
  sensorType: 'distance',
  config: { type: 'distance', maxRange: 2, fov: 15, updateRate: 10 },
  mountedOn: 'chassis',
  bindings: {
    distance: { symbol: 'sonar-front', port: 'distance' },
  },
};

const assemblyAsSceneEntity: SceneEntity = assembly;
const jointAsSceneEntity: SceneEntity = joint;
const sensorAsSceneEntity: SceneEntity = sensor;

const geometries: readonly GeometryDescriptor[] = [
  { type: 'box', size: position },
  { type: 'sphere', radius: 0.5 },
  { type: 'cylinder', radius: 0.25, height: 1 },
  { type: 'capsule', radius: 0.25, height: 1 },
  { type: 'plane', size: planeSize },
];

// @ts-expect-error a scene entity requires an initial position
const missingPosition: SceneEntity = { id: 'missing', type: 'model', rotation };
// @ts-expect-error a scene entity requires an initial rotation
const missingRotation: SceneEntity = { id: 'missing', type: 'model', position };
// @ts-expect-error the entity discriminant is a closed union
const unknownEntityType: SceneEntity = { id: 'bad', type: 'light', position, rotation };
// @ts-expect-error a model entity must keep the model discriminant
const wrongModelType: ModelEntity = { ...model, type: 'assembly' };
// @ts-expect-error a model entity needs geometry even when the other payloads are present
const missingGeometry: ModelEntity = { ...model, geometry: undefined };
const legacySymbol: SceneEntity = {
  id: 'legacy',
  type: 'model',
  position,
  rotation,
  // @ts-expect-error scene entities no longer carry a schematic symbol
  symbol: 'M1',
};
// @ts-expect-error an assembly instance must reference an assembly definition
const missingAssembly: AssemblyInstance = { id: 'robot', type: 'assembly', position, rotation };
// @ts-expect-error an assembly reference is a package:name string
const numericAssembly: AssemblyInstance = { ...assembly, assembly: 42 };
const partialBinding = { symbol: 'motor-left' };
const incompleteJointBinding: JointEntity = {
  ...joint,
  // @ts-expect-error a joint binding requires both a symbol and a port
  bindings: { torque: partialBinding },
};
const incompleteSensorBinding: SensorEntity = {
  ...sensor,
  // @ts-expect-error a sensor binding requires a port name
  bindings: { distance: partialBinding },
};
// @ts-expect-error joint bindings are read-only
joint.bindings = { torque: { symbol: 'motor-right', port: 'torque' } };
// @ts-expect-error sensor bindings are read-only
sensor.bindings = { distance: { symbol: 'sonar-back', port: 'distance' } };
// @ts-expect-error assembly overrides are read-only
assembly.overrides = { maxSpeed: 2 };
// @ts-expect-error plane geometry takes a 2D extent, so a 3D literal has an excess axis
const planeWithThreeAxes: GeometryDescriptor = { type: 'plane', size: { x: 1, y: 1, z: 1 } };
// @ts-expect-error sphere geometry needs a radius
const sphereWithoutRadius: GeometryDescriptor = { type: 'sphere' };
// @ts-expect-error geometry is a closed union
const unknownGeometry: GeometryDescriptor = { type: 'torus', radius: 1 };
// @ts-expect-error bodyType is a closed union
const unknownBodyType: PhysicsConfig = { bodyType: 'floating' };
// @ts-expect-error mass is a number of kilograms
const stringMass: PhysicsConfig = { bodyType: 'dynamic', mass: 'heavy' };
const unknownAxis: PhysicsConfig = {
  bodyType: 'kinematic',
  // @ts-expect-error constraints only freeze the x, y and z axes
  constraints: { freezePosition: { w: true } },
};
// @ts-expect-error friction is mandatory for every material
const missingFriction: MaterialDescriptor = { restitution: 0.2 };
// @ts-expect-error restitution is mandatory for every material
const missingRestitution: MaterialDescriptor = { friction: 0.5 };
const badCompoundChild: ColliderDescriptor = {
  type: 'compound',
  // @ts-expect-error compound children must be colliders, not geometry descriptors
  children: [{ type: 'mesh', source: 'geometry' }],
};
// @ts-expect-error trimesh colliders are generated from the entity geometry
const badTrimeshSource: ColliderDescriptor = { type: 'trimesh', source: 'mesh' };
// @ts-expect-error scene entities are immutable
entity.id = 'renamed';
// @ts-expect-error model physics is immutable
model.physics = { bodyType: 'static' };

void [
  asSceneEntity,
  assembly,
  assemblyAsSceneEntity,
  bodyTypes,
  entity,
  entityTypes,
  geometries,
  incompleteJointBinding,
  incompleteSensorBinding,
  joint,
  jointAsSceneEntity,
  legacySymbol,
  material,
  missingAssembly,
  missingFriction,
  missingGeometry,
  missingPosition,
  missingRestitution,
  missingRotation,
  model,
  numericAssembly,
  partialBinding,
  planeWithThreeAxes,
  sensor,
  sensorAsSceneEntity,
  sphereWithoutRadius,
  stringMass,
  unknownAxis,
  unknownBodyType,
  unknownEntityType,
  unknownGeometry,
  wrongModelType,
  badCompoundChild,
  badTrimeshSource,
];
