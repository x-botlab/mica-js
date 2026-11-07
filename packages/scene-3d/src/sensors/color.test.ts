import { describe, expect, it, vi } from 'vitest';

import type { ModelEntity, SensorEntity } from '../entities';
import { Quaternion } from '../math';
import type { PhysicsRuntime, RaycastHit } from '../physics';
import {
  ColorSensor,
  createMaterialColorResolver,
  createSolidColorResolver,
  type Rgb,
} from './color';

function entity(radius = 0, mountedOn?: string): SensorEntity {
  return {
    id: 'color-1',
    type: 'sensor',
    position: { x: 0, y: 1, z: 0 },
    rotation: Quaternion.identity,
    sensorType: 'color',
    config: { type: 'color', sampleRadius: radius, updateRate: 10 },
    ...(mountedOn === undefined ? {} : { mountedOn }),
  };
}

const hit = (bodyId = 'track', point = { x: 0, y: 0, z: 0 }): RaycastHit => ({
  bodyId,
  distance: 1,
  point,
  normal: { x: 0, y: 1, z: 0 },
});

function runtime(raycast: PhysicsRuntime['raycast']): PhysicsRuntime {
  return { raycast, getBodyTransform: vi.fn() } as unknown as PhysicsRuntime;
}

describe('ColorSensor and surface color resolvers', () => {
  it('reads a dark track below a sensor and uses white when no surface is hit', () => {
    const resolver = createSolidColorResolver({ red: 20, green: 30, blue: 40 });
    const raycast = vi
      .fn<PhysicsRuntime['raycast']>()
      .mockReturnValueOnce(hit())
      .mockReturnValueOnce(null);
    const sensor = new ColorSensor(entity(), { resolver });

    expect(sensor.tryUpdate(runtime(raycast), 0n)).toMatchObject({
      color: [20, 30, 40],
      grayscale: 28,
    });
    expect(sensor.tryUpdate(runtime(raycast), 100_000_000_000n)?.color).toEqual([255, 255, 255]);
  });

  it('averages five raycast samples across two surfaces', () => {
    const colors: Rgb[] = [
      { red: 0, green: 0, blue: 0 },
      { red: 255, green: 255, blue: 255 },
      { red: 255, green: 255, blue: 255 },
      { red: 255, green: 255, blue: 255 },
      { red: 255, green: 255, blue: 255 },
    ];
    let index = 0;
    const varyingResolver = { resolve: () => colors[index++] ?? { red: 0, green: 0, blue: 0 } };
    const raycast = vi.fn<PhysicsRuntime['raycast']>().mockReturnValue(hit());
    const sensor = new ColorSensor(entity(0.1), { resolver: varyingResolver });

    expect(sensor.tryUpdate(runtime(raycast), 0n)?.color).toEqual([204, 204, 204]);
    expect(raycast).toHaveBeenCalledTimes(5);
  });

  it('rotates the downward ray with a mounted entity', () => {
    const rotation = Quaternion.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    const raycast = vi.fn<PhysicsRuntime['raycast']>().mockReturnValue(hit());
    const physics = {
      getBodyTransform: vi.fn().mockReturnValue({ position: { x: 0, y: 0, z: 0 }, rotation }),
      raycast,
    } as unknown as PhysicsRuntime;

    new ColorSensor(entity(0, 'robot'), {
      resolver: createSolidColorResolver({ red: 1, green: 2, blue: 3 }),
    }).tryUpdate(physics, 0n);
    expect(raycast.mock.calls[0]?.[1]?.x).toBeCloseTo(0);
    expect(raycast.mock.calls[0]?.[1]?.y).toBeCloseTo(0);
    expect(raycast.mock.calls[0]?.[1]?.z).toBeCloseTo(-1);
  });

  it('uses a per-entity sampler before material color and parses #rgb colors', () => {
    const model = {
      id: 'track',
      type: 'model',
      material: { color: '#fff' },
    } as ModelEntity;
    const samplerColor = { red: 4, green: 5, blue: 6 };
    const resolver = createMaterialColorResolver([model], {
      samplers: { track: () => samplerColor },
    });

    expect(resolver.resolve(hit('track'))).toEqual(samplerColor);
    expect(createMaterialColorResolver([model]).resolve(hit('track'))).toEqual({
      red: 255,
      green: 255,
      blue: 255,
    });
  });
});
