import { describe, expect, it, vi } from 'vitest';

import type { SensorEntity } from '../entities';
import { Quaternion } from '../math';
import type { PhysicsRuntime } from '../physics';
import { IMUSensor } from './imu';

function entity(mountedOn?: string): SensorEntity {
  return {
    id: 'imu-1',
    type: 'sensor',
    position: { x: 0, y: 0, z: 0 },
    rotation: Quaternion.identity,
    sensorType: 'imu',
    config: { type: 'imu', updateRate: 10 },
    ...(mountedOn === undefined ? {} : { mountedOn }),
  };
}

function runtime(motion?: PhysicsRuntime['getBodyMotion']): PhysicsRuntime {
  return {
    getBodyTransform: vi
      .fn()
      .mockReturnValue({ position: { x: 0, y: 0, z: 0 }, rotation: Quaternion.identity }),
    ...(motion === undefined ? {} : { getBodyMotion: motion }),
  } as unknown as PhysicsRuntime;
}

describe('IMUSensor', () => {
  it('returns zero acceleration on the first sample, then computes acceleration minus gravity', () => {
    const getBodyMotion = vi
      .fn<NonNullable<PhysicsRuntime['getBodyMotion']>>()
      .mockReturnValueOnce({
        linearVelocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
      })
      .mockReturnValue({
        linearVelocity: { x: 1, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 2, z: 0 },
      });
    const sensor = new IMUSensor(entity('body'), { gravity: { x: 0, y: -9.81, z: 0 } });
    const physics = runtime(getBodyMotion);

    expect(sensor.tryUpdate(physics, 0n)?.linearAcceleration).toEqual([0, 0, 0]);
    expect(sensor.tryUpdate(physics, 1_000_000_000_000n)?.linearAcceleration).toEqual([1, 9.81, 0]);
    expect(sensor.tryUpdate(physics, 2_000_000_000_000n)?.angularVelocity).toEqual([0, 2, 0]);
  });

  it('degrades to zero motion without getBodyMotion and reports mounted orientation', () => {
    const rotation = Quaternion.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    const physics = {
      getBodyTransform: vi.fn().mockReturnValue({ position: { x: 0, y: 0, z: 0 }, rotation }),
    } as unknown as PhysicsRuntime;
    const sensor = new IMUSensor(entity('body'));

    expect(sensor.tryUpdate(physics, 0n)).toMatchObject({
      angularVelocity: [0, 0, 0],
      linearAcceleration: [0, 0, 0],
      orientation: [rotation.x, rotation.y, rotation.z, rotation.w],
    });
  });

  it('reports readings in the sensor frame, so a pitched IMU rotates them back to world', () => {
    // 90° about +X turns world Y into local -Z (and world Z into local Y).
    const rotation = Quaternion.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    const physics = {
      getBodyTransform: vi.fn().mockReturnValue({ position: { x: 0, y: 0, z: 0 }, rotation }),
      getBodyMotion: vi.fn<NonNullable<PhysicsRuntime['getBodyMotion']>>().mockReturnValue({
        linearVelocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 3, z: 0 },
      }),
    } as unknown as PhysicsRuntime;
    const sensor = new IMUSensor(entity('body'), { gravity: { x: 0, y: -9.81, z: 0 } });

    sensor.tryUpdate(physics, 0n); // Primes the velocity baseline; the first reading has no delta.
    const reading = sensor.tryUpdate(physics, 1_000_000_000_000n);

    expect(reading?.angularVelocity.map(round)).toEqual([0, 0, -3]);
    // Static sensor: the measured specific force is the reaction to gravity, along local -Z.
    expect(reading?.linearAcceleration.map(round)).toEqual([0, 0, -9.81]);
  });
});

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
