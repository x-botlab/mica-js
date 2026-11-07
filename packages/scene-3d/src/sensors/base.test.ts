import { describe, expect, it, vi } from 'vitest';

import type { SensorEntity } from '../entities';
import { Quaternion, type Vec3d } from '../math';
import type { PhysicsRuntime } from '../physics';
import { MockSensor, Sensor } from './base';
import type { DistanceSensorData, SensorData } from './types';

const CHASSIS: Vec3d = { x: 1, y: 2, z: 3 };
const LOCAL_OFFSET: Vec3d = { x: 0.1, y: 0, z: 0 };

function distanceEntity(updateRate = 10, mountedOn?: string): SensorEntity {
  return {
    id: 'sensor-1',
    type: 'sensor',
    position: LOCAL_OFFSET,
    rotation: Quaternion.identity,
    sensorType: 'distance',
    config: { type: 'distance', maxRange: 2, fov: 15, updateRate },
    ...(mountedOn === undefined ? {} : { mountedOn }),
  };
}

function distanceReading(): DistanceSensorData {
  return { type: 'distance', distance: 1.5, timestamp: 0n };
}

/** Exposes the protected transform helper without making it part of the public API. */
class ExposedMockSensor extends MockSensor {
  public worldTransform(physics: PhysicsRuntime) {
    return this.getWorldTransform(physics);
  }
}

/** Sensor whose update always fails, used to check that the clock is not consumed. */
class FailingSensor extends Sensor {
  protected update(): SensorData {
    throw new Error('sensor hardware exploded');
  }
}

describe('Sensor update rate', () => {
  it('reads immediately and then respects the configured interval', () => {
    const sensor = new MockSensor(distanceEntity(10), distanceReading());
    const physics = {} as PhysicsRuntime;

    const first = sensor.tryUpdate(physics, 0n);
    expect(first).toMatchObject({ type: 'distance', distance: 1.5, timestamp: 0n });
    expect(sensor.lastUpdatedAt).toBe(0n);

    // 10 Hz means one reading every 100 ms; 50 ms and 99.999 ms are still inside the window.
    expect(sensor.tryUpdate(physics, 50_000_000_000n)).toBeNull();
    expect(sensor.tryUpdate(physics, 99_999_999_999n)).toBeNull();

    const third = sensor.tryUpdate(physics, 100_000_000_000n);
    expect(third).not.toBeNull();
    expect(third?.timestamp).toBe(100_000_000_000n);
    expect(sensor.lastUpdatedAt).toBe(100_000_000_000n);
  });

  it('defaults to 30 Hz when the configuration omits updateRate', () => {
    const entity: SensorEntity = {
      id: 'default-rate',
      type: 'sensor',
      position: { x: 0, y: 0, z: 0 },
      rotation: Quaternion.identity,
      sensorType: 'light',
      config: { type: 'light' } as SensorEntity['config'],
    };
    const sensor = new MockSensor(entity, {
      type: 'light',
      intensity: 500,
      timestamp: 0n,
    });
    const physics = {} as PhysicsRuntime;

    expect(sensor.tryUpdate(physics, 0n)).not.toBeNull();
    // 1e12 ps / 30 Hz = 33_333_333_333.33 ps, rounded to the nearest picosecond.
    expect(sensor.tryUpdate(physics, 33_333_333_332n)).toBeNull();
    expect(sensor.tryUpdate(physics, 33_333_333_333n)).not.toBeNull();
  });

  it('rejects a non-positive or non-finite update rate', () => {
    expect(() => new MockSensor(distanceEntity(0), distanceReading())).toThrow(RangeError);
    expect(() => new MockSensor(distanceEntity(-5), distanceReading())).toThrow(RangeError);
    expect(() => new MockSensor(distanceEntity(Number.NaN), distanceReading())).toThrow(TypeError);
  });

  it('does not consume the interval when an update fails', () => {
    const sensor = new FailingSensor(distanceEntity(10));
    const physics = {} as PhysicsRuntime;

    expect(() => sensor.tryUpdate(physics, 0n)).toThrow('sensor hardware exploded');
    expect(sensor.lastUpdatedAt).toBeNull();

    // The next call is still due, because the failed reading did not advance the clock.
    expect(() => sensor.tryUpdate(physics, 1n)).toThrow('sensor hardware exploded');
  });
});

describe('Sensor mounting', () => {
  it('composes the parent pose with the local offset for a mounted sensor', () => {
    const physics = {
      getBodyTransform: vi.fn().mockReturnValue({
        position: CHASSIS,
        rotation: Quaternion.identity,
      }),
    } as unknown as PhysicsRuntime;
    const sensor = new ExposedMockSensor(distanceEntity(10, 'chassis'), distanceReading());

    const transform = sensor.worldTransform(physics);

    expect(physics.getBodyTransform).toHaveBeenCalledWith('chassis');
    expect(transform.position).toEqual({ x: 1.1, y: 2, z: 3 });
    expect(transform.rotation).toEqual(Quaternion.identity);
  });

  it('rotates the local offset into world space', () => {
    const parentRotation = Quaternion.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const physics = {
      getBodyTransform: vi.fn().mockReturnValue({
        position: CHASSIS,
        rotation: parentRotation,
      }),
    } as unknown as PhysicsRuntime;
    const sensor = new ExposedMockSensor(distanceEntity(10, 'chassis'), distanceReading());

    const transform = sensor.worldTransform(physics);

    // +X rotated by +90° about Y points along -Z, so the 0.1 m offset lands at z = 3 - 0.1.
    expect(transform.position.x).toBeCloseTo(1);
    expect(transform.position.y).toBeCloseTo(2);
    expect(transform.position.z).toBeCloseTo(2.9);
    expect(transform.rotation).toEqual(parentRotation);
  });

  it('keeps the entity pose and skips physics for a world-fixed sensor', () => {
    const physics = {
      getBodyTransform: vi.fn(),
    } as unknown as PhysicsRuntime;
    const entity = distanceEntity(10);
    const sensor = new ExposedMockSensor(entity, distanceReading());

    const transform = sensor.worldTransform(physics);

    expect(physics.getBodyTransform).not.toHaveBeenCalled();
    expect(transform.position).toEqual(entity.position);
    expect(transform.rotation).toEqual(entity.rotation);
  });
});
