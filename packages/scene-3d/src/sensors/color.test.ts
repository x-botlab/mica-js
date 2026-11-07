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

  it('filters the mounted body from every colour sample', () => {
    const raycast = vi.fn<PhysicsRuntime['raycast']>().mockImplementation(() => {
      const selfHit = raycast.mock.calls.length % 2 === 1;
      return hit(selfHit ? 'robot' : 'ground');
    });
    const sensor = new ColorSensor(entity(0.1, 'robot'), {
      resolver: createSolidColorResolver({ red: 10, green: 20, blue: 30 }),
    });

    const mountedRuntime = {
      ...runtime(raycast),
      getBodyTransform: vi.fn().mockReturnValue({
        position: { x: 0, y: 0, z: 0 },
        rotation: Quaternion.identity,
      }),
    } as unknown as PhysicsRuntime;

    expect(sensor.tryUpdate(mountedRuntime, 0n)?.color).toEqual([10, 20, 30]);
    expect(raycast).toHaveBeenCalledTimes(10);
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

  it('reads printed acrylic paint from the hit point', () => {
    const plate = {
      id: 'track-base',
      type: 'model',
      material: { color: '#cccccc' },
      geometry: {
        type: 'acrylic',
        acrylic: {
          contour: { type: 'rect', width: 0.4, height: 0.6 },
          thickness: 0.003,
          paint: {
            base: '#f5f5f5',
            strokes: [{ axis: 'z', center: 0, width: 0.04, color: '#101010' }],
          },
        },
      },
    } as unknown as ModelEntity;
    const resolver = createMaterialColorResolver([plate]);

    // The stroke runs along Z at x = 0, so only hits inside ±20 mm read black.
    expect(resolver.resolve(hit('track-base', { x: 0, y: 0, z: 0.2 }))).toEqual({
      red: 16,
      green: 16,
      blue: 16,
    });
    expect(resolver.resolve(hit('track-base', { x: 0.03, y: 0, z: 0.2 }))).toEqual({
      red: 245,
      green: 245,
      blue: 245,
    });
    // `sampleRadius` offsets in X still land on the printed base when they leave the stroke.
    expect(resolver.resolve(hit('track-base', { x: -0.05, y: 0, z: -0.1 }))).toEqual({
      red: 245,
      green: 245,
      blue: 245,
    });
  });

  it('falls back to the material colour when the paint has no base or matching stroke', () => {
    const plate = {
      id: 'plate',
      type: 'model',
      material: { color: '#123456' },
      geometry: {
        type: 'acrylic',
        acrylic: {
          contour: { type: 'rect', width: 0.1, height: 0.1 },
          thickness: 0.003,
          paint: { strokes: [{ axis: 'x', center: 10, width: 1, color: '#000000' }] },
        },
      },
    } as unknown as ModelEntity;

    expect(createMaterialColorResolver([plate]).resolve(hit('plate'))).toEqual({
      red: 0x12,
      green: 0x34,
      blue: 0x56,
    });
  });
});
