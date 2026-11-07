/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SceneEntity } from '../entities';
import { ASSEMBLY_VERSION, validateAssemblyDefinition } from './index';
import type { AssemblyDefinition, AssemblyValidationResult } from './index';

const POSITION = { x: 0, y: 0.025, z: 0 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function entity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chassis',
    type: 'model',
    position: POSITION,
    rotation: IDENTITY,
    ...overrides,
  };
}

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: 'robot-car',
    displayName: '双轮循迹小车',
    schematic: './robot-car.sch',
    entities: [entity()],
    centerOfMass: { x: 0, y: 0.025, z: 0 },
    metadata: {
      author: 'Mica',
      description: 'A reusable two-wheel robot.',
      thumbnail: './thumbnails/robot-car.png',
      tags: ['robot', 'line-follower'],
    },
    ...overrides,
  };
}

function codes(value: unknown): readonly string[] {
  return validateAssemblyDefinition(value).diagnostics.map((diagnostic) => diagnostic.code);
}

function diagnosticCodes(result: AssemblyValidationResult): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe('ASSEMBLY_VERSION', () => {
  it('pins the `.assembly.json` schema version', () => {
    expect(ASSEMBLY_VERSION).toBe(1);
  });
});

describe('validateAssemblyDefinition', () => {
  it('accepts a complete definition', () => {
    expect(validateAssemblyDefinition(definition())).toEqual({ ok: true, diagnostics: [] });
  });

  it('accepts a minimal definition and an empty entity list', () => {
    const result = validateAssemblyDefinition({
      version: 1,
      name: 'empty',
      schematic: 'empty.sch',
      entities: [],
    });

    expect(result).toEqual({ ok: true, diagnostics: [] });
  });

  it.each([null, undefined, 42, 'assembly', true, []])(
    'rejects a non-object root (%j)',
    (value) => {
      const result = validateAssemblyDefinition(value);

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        {
          code: 'assembly/invalid-root',
          message: 'Assembly definition must be a JSON object.',
          path: [],
        },
      ]);
    },
  );

  it.each([0, 2, '1', undefined])('rejects unsupported version %j', (version) => {
    const result = validateAssemblyDefinition(definition({ version }));

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'assembly/unsupported-version', path: ['version'] }),
    );
  });

  it.each(['name', 'schematic'])('requires a non-empty %s', (field) => {
    for (const value of [undefined, '', '   ', 7]) {
      const result = validateAssemblyDefinition(definition({ [field]: value }));

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'assembly/invalid-field', path: [field] }),
      );
    }
  });

  it('rejects a malformed displayName', () => {
    const result = validateAssemblyDefinition(definition({ displayName: 7 }));

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'assembly/invalid-field', path: ['displayName'] }),
    );
  });

  it.each([undefined, 'not-an-array', 42])('rejects entities %j', (entities) => {
    const result = validateAssemblyDefinition(definition({ entities }));

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'assembly/invalid-field', path: ['entities'] }),
    );
  });

  it('rejects an entity that is not an object', () => {
    const result = validateAssemblyDefinition(definition({ entities: [42] }));

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'assembly/invalid-entity', path: ['entities', '0'] }),
    );
  });

  it('rejects an entity without an id', () => {
    const result = validateAssemblyDefinition(
      definition({ entities: [entity({ id: undefined })] }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-entity',
        path: ['entities', '0', 'id'],
      }),
    );
  });

  it('rejects duplicate entity ids', () => {
    const result = validateAssemblyDefinition({
      ...definition(),
      entities: [entity(), entity({ id: 'chassis' })],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/duplicate-entity-id',
        path: ['entities', '1', 'id'],
      }),
    );
  });

  it('rejects an unknown entity type', () => {
    const result = validateAssemblyDefinition(
      definition({ entities: [entity({ type: 'light' })] }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-entity',
        path: ['entities', '0', 'type'],
      }),
    );
  });

  it('requires a finite position and a full quaternion rotation', () => {
    const result = validateAssemblyDefinition({
      ...definition(),
      entities: [
        entity({ position: undefined }),
        entity({ id: 'bad-position', position: { x: Number.NaN, y: 0, z: 0 } }),
        entity({ id: 'bad-rotation', rotation: { x: 0, y: 0, z: 0 } }),
      ],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-field',
        path: ['entities', '0', 'position'],
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-field',
        path: ['entities', '1', 'position'],
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-field',
        path: ['entities', '2', 'rotation'],
      }),
    );
  });

  it('rejects malformed optional entity fields', () => {
    const result = validateAssemblyDefinition({
      ...definition(),
      entities: [entity({ name: 7 })],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-field',
        path: ['entities', '0', 'name'],
      }),
    );
  });

  it('rejects malformed topic bindings on joints and sensors', () => {
    const jointResult = validateAssemblyDefinition({
      ...definition(),
      entities: [
        entity({
          type: 'joint',
          bindings: {
            torque: { symbol: 'motor-left' },
            position: 'encoder-left',
          },
        }),
      ],
    });

    expect(
      diagnosticCodes(jointResult).filter((code) => code === 'assembly/invalid-binding'),
    ).toHaveLength(2);
    expect(jointResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-binding',
        path: ['entities', '0', 'bindings', 'torque', 'port'],
      }),
    );
    expect(jointResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-binding',
        path: ['entities', '0', 'bindings', 'position'],
      }),
    );

    const sensorResult = validateAssemblyDefinition({
      ...definition(),
      entities: [
        entity({ type: 'sensor', bindings: { intensity: { symbol: '', port: 'distance' } } }),
      ],
    });

    expect(sensorResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-binding',
        path: ['entities', '0', 'bindings', 'intensity', 'symbol'],
      }),
    );
  });

  it('requires a definition reference on a nested assembly entity', () => {
    const result = validateAssemblyDefinition({
      ...definition(),
      entities: [entity({ type: 'assembly' })],
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-field',
        path: ['entities', '0', 'assembly'],
      }),
    );
  });

  it.each([null, 'origin', { x: 0, y: Number.POSITIVE_INFINITY, z: 0 }])(
    'rejects an invalid centerOfMass (%j)',
    (centerOfMass) => {
      const result = validateAssemblyDefinition(definition({ centerOfMass }));

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'assembly/invalid-field', path: ['centerOfMass'] }),
      );
    },
  );

  it('rejects malformed metadata', () => {
    expect(codes(validateAssemblyDefinition(definition({ metadata: 'robot' })))).toContain(
      'assembly/invalid-field',
    );

    const result = validateAssemblyDefinition(
      definition({ metadata: { author: 7, tags: ['robot', ''] } }),
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'assembly/invalid-field', path: ['metadata', 'author'] }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'assembly/invalid-field',
        path: ['metadata', 'tags', '1'],
      }),
    );
  });

  it('rejects metadata tags that are not an array', () => {
    const result = validateAssemblyDefinition(definition({ metadata: { tags: 'robot' } }));

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'assembly/invalid-field', path: ['metadata', 'tags'] }),
    );
  });
});

describe('examples/robot-car.assembly.json', () => {
  const example: unknown = JSON.parse(
    readFileSync(new URL('../../examples/robot-car.assembly.json', import.meta.url), 'utf8'),
  );

  it('validates against the definition contract', () => {
    expect(validateAssemblyDefinition(example)).toEqual({ ok: true, diagnostics: [] });
  });

  it('contains a chassis, two wheels, two motors and sensors', () => {
    const assembly = example as AssemblyDefinition;
    const ofType = (type: SceneEntity['type']) =>
      assembly.entities.filter((entity) => entity.type === type).map((entity) => entity.id);

    expect(assembly.name).toBe('robot-car');
    expect(assembly.schematic).toBe('./robot-car.sch');
    expect(ofType('model')).toEqual(
      expect.arrayContaining(['chassis', 'left-wheel', 'right-wheel']),
    );
    expect(ofType('joint')).toEqual(['left-motor', 'right-motor']);
    expect(ofType('sensor')).toEqual(['left-line-sensor', 'right-line-sensor', 'distance-sensor']);
    expect(assembly.centerOfMass).toEqual({ x: 0.01, y: 0.028, z: 0 });
    expect(assembly.metadata?.tags).toContain('robot');
  });
});
