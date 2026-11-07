import { describe, expect, it } from 'vitest';

import type { SensorEntity } from '../entities';
import { Quaternion } from '../math';
import type { PhysicsRuntime } from '../physics';
import { GPSSensor } from './gps';

function entity(id = 'gps-1', position = { x: 0, y: 0, z: 0 }, accuracy = 0): SensorEntity {
  return {
    id,
    type: 'sensor',
    position,
    rotation: Quaternion.identity,
    sensorType: 'gps',
    config: { type: 'gps', updateRate: 1, accuracy },
  };
}

function runtime(): PhysicsRuntime {
  return {} as PhysicsRuntime;
}

describe('GPSSensor', () => {
  it('maps the origin and local metre offsets to latitude, longitude and altitude', () => {
    const sensor = new GPSSensor(entity('origin', { x: 0, y: 10, z: 111_320 }));
    expect(sensor.tryUpdate(runtime(), 0n)).toMatchObject({
      latitude: 1,
      longitude: 0,
      altitude: 10,
      accuracy: 0,
    });
  });

  it('scales longitude by the cosine of latitude', () => {
    const sensor = new GPSSensor(entity('lon', { x: 111_320, y: 0, z: 0 }));
    const reading = sensor.tryUpdate(runtime(), 0n);
    expect(reading?.longitude).toBeCloseTo(1);
  });

  it('keeps deterministic noise reproducible for the same id and within accuracy per axis', () => {
    const first = new GPSSensor(entity('same', { x: 0, y: 0, z: 0 }, 2));
    const second = new GPSSensor(entity('same', { x: 0, y: 0, z: 0 }, 2));
    const a = first.tryUpdate(runtime(), 0n);
    const b = second.tryUpdate(runtime(), 0n);
    expect(a).toEqual(b);
    expect(Math.abs(a?.altitude ?? 0)).toBeLessThanOrEqual(2);
  });
});
