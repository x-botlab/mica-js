import { describe, expect, it, vi } from 'vitest';

import type { SensorEntity } from '../entities';
import { Quaternion } from '../math';
import type { PhysicsRuntime } from '../physics';
import { DistanceSensor } from './distance';

function entity(overrides: Partial<SensorEntity['config']> = {}, mountedOn?: string): SensorEntity {
  return {
    id: 'distance-1',
    type: 'sensor',
    position: { x: 0, y: 0, z: 0 },
    rotation: Quaternion.identity,
    sensorType: 'distance',
    config: {
      type: 'distance',
      maxRange: 5,
      fov: 0,
      updateRate: 10,
      ...overrides,
    } as SensorEntity['config'],
    ...(mountedOn === undefined ? {} : { mountedOn }),
  };
}

function physics(raycast: PhysicsRuntime['raycast']): PhysicsRuntime {
  return { getBodyTransform: vi.fn(), raycast } as unknown as PhysicsRuntime;
}

describe('DistanceSensor', () => {
  it('reports hits and turns misses or over-range hits into null', () => {
    const raycast = vi
      .fn<PhysicsRuntime['raycast']>()
      .mockReturnValueOnce({
        distance: 2,
        bodyId: 'b',
        point: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
      })
      .mockReturnValueOnce({
        distance: 8,
        bodyId: 'b',
        point: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
      });
    const sensor = new DistanceSensor(entity());
    const runtime = physics(raycast);

    expect(sensor.tryUpdate(runtime, 0n)?.distance).toBe(2);
    expect(sensor.tryUpdate(runtime, 100_000_000_000n)?.distance).toBeNull();
  });

  it('samples a fixed cone pattern and keeps the nearest hit', () => {
    const raycast = vi.fn<PhysicsRuntime['raycast']>().mockImplementation(() => ({
      distance: raycast.mock.calls.length === 2 ? 1 : 3,
      bodyId: 'b',
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
    }));
    const sensor = new DistanceSensor(entity({ fov: 60 }));

    expect(sensor.tryUpdate(physics(raycast), 0n)?.distance).toBe(1);
    expect(raycast).toHaveBeenCalledTimes(5);
  });

  it('rotates the forward ray with a mounted parent and throttles updates', () => {
    const raycast = vi.fn<PhysicsRuntime['raycast']>().mockReturnValue(null);
    const parentRotation = Quaternion.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const runtime = {
      getBodyTransform: vi
        .fn()
        .mockReturnValue({ position: { x: 0, y: 0, z: 0 }, rotation: parentRotation }),
      raycast,
    } as unknown as PhysicsRuntime;
    const sensor = new DistanceSensor(entity({ fov: 0 }, 'body'));

    expect(sensor.tryUpdate(runtime, 0n)).not.toBeNull();
    expect(raycast.mock.calls[0]?.[1]?.x).toBeCloseTo(-1);
    expect(raycast.mock.calls[0]?.[1]?.y).toBeCloseTo(0);
    expect(raycast.mock.calls[0]?.[1]?.z).toBeCloseTo(0);
    expect(sensor.tryUpdate(runtime, 50_000_000_000n)).toBeNull();
    expect(raycast).toHaveBeenCalledTimes(1);
  });
});
