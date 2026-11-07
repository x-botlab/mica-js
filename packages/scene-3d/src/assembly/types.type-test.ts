import type { AssemblyInstance, SceneEntity } from '../entities';
import type { Quaternion, Vec3d } from '../math';
import type { AssemblyDefinition } from './index';

declare const position: Vec3d;
declare const rotation: Quaternion;

const entity: SceneEntity = { id: 'chassis', type: 'model', position, rotation };

const definition: AssemblyDefinition = {
  version: 1,
  name: 'robot-car',
  displayName: '双轮循迹小车',
  schematic: './robot-car.sch',
  entities: [entity],
  centerOfMass: position,
  metadata: {
    author: 'Mica',
    description: 'Reusable two-wheel robot.',
    thumbnail: './thumbnails/robot-car.png',
    tags: ['robot', 'line-follower'],
  },
};

const instance: AssemblyInstance = {
  id: 'car-1',
  type: 'assembly',
  assembly: 'robot-car',
  position,
  rotation,
};

// @ts-expect-error the schema version is pinned to 1
const futureVersion: AssemblyDefinition = { ...definition, version: 2 };
// @ts-expect-error an assembly definition must bind a schematic
const missingSchematic: AssemblyDefinition = { version: 1, name: 'empty', entities: [] };
// @ts-expect-error an assembly definition needs an entity list
const missingEntities: AssemblyDefinition = { version: 1, name: 'empty', schematic: 'empty.sch' };
// @ts-expect-error an assembly instance must reference a definition
const missingReference: AssemblyInstance = { id: 'car-1', type: 'assembly', position, rotation };
// @ts-expect-error assembly definitions are immutable
definition.name = 'other';
// @ts-expect-error assembly instances are immutable
instance.assembly = 'other';
// @ts-expect-error assembly entity lists are immutable
definition.entities = [];

void [
  definition,
  entity,
  futureVersion,
  instance,
  missingEntities,
  missingReference,
  missingSchematic,
];
