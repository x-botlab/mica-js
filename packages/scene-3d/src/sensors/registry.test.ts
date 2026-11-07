import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SensorEntity } from '../entities';
import { Quaternion } from '../math';
import { MockSensor } from './base';
import { SensorRegistry } from './registry';

function entity(
  id = 'sensor-1',
  sensorType: SensorEntity['sensorType'] = 'distance',
): SensorEntity {
  return {
    id,
    type: 'sensor',
    position: { x: 0, y: 0, z: 0 },
    rotation: Quaternion.identity,
    sensorType,
    config: { type: 'distance', maxRange: 2, fov: 15, updateRate: 10 },
  };
}

function distanceFactory(target: SensorEntity) {
  return new MockSensor(target, { type: 'distance', distance: 1, timestamp: 0n });
}

describe('SensorRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a sensor through its registered factory', () => {
    const registry = new SensorRegistry();
    const factory = vi.fn((target: SensorEntity) => distanceFactory(target));
    registry.register('distance', factory);

    const target = entity();
    const sensor = registry.create(target);

    expect(factory).toHaveBeenCalledWith(target);
    expect(sensor).toBeInstanceOf(MockSensor);
    expect(sensor.id).toBe('sensor-1');
    expect(registry.has('distance')).toBe(true);
    expect(registry.types()).toEqual(['distance']);
  });

  it('rejects a duplicate registration', () => {
    const registry = new SensorRegistry();
    registry.register('distance', distanceFactory);

    expect(() => registry.register('distance', distanceFactory)).toThrow(
      /Sensor type "distance" already registered/,
    );
  });

  it('rejects a sensor type without a factory', () => {
    const registry = new SensorRegistry();

    expect(() => registry.create(entity('sonar', 'magnetic'))).toThrow(
      /Sensor type "magnetic" not registered/,
    );
  });

  it('rejects an entity without a sensor type', () => {
    const registry = new SensorRegistry();
    const malformed = { ...entity(), sensorType: undefined } as unknown as SensorEntity;

    expect(() => registry.create(malformed)).toThrow(/has no sensorType/);
  });

  it('validates registration arguments', () => {
    const registry = new SensorRegistry();

    expect(() => registry.register('', distanceFactory)).toThrow(TypeError);
    expect(() =>
      registry.register('distance', null as unknown as (entity: SensorEntity) => never),
    ).toThrow(TypeError);
  });

  it('unregisters and clears factories', () => {
    const registry = new SensorRegistry();
    registry.register('distance', distanceFactory);
    registry.register(
      'light',
      (target) => new MockSensor(target, { type: 'light', intensity: 1, timestamp: 0n }),
    );

    expect(registry.unregister('distance')).toBe(true);
    expect(registry.unregister('distance')).toBe(false);
    expect(registry.has('distance')).toBe(false);

    registry.clear();
    expect(registry.types()).toEqual([]);
  });
});
