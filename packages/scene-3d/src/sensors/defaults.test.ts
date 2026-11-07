import { describe, expect, it } from 'vitest';

import type { SensorEntity } from '../entities';
import { Quaternion } from '../math';
import { createSolidColorResolver } from './color';
import { createDefaultSensorRegistry, registerDefaultSensors } from './defaults';
import { SensorRegistry } from './registry';

const entity = (sensorType: SensorEntity['sensorType']): SensorEntity => ({
  id: `sensor-${sensorType}`,
  type: 'sensor',
  position: { x: 0, y: 0, z: 0 },
  rotation: Quaternion.identity,
  sensorType,
  config: {
    type: sensorType,
    updateRate: 1,
    maxRange: 1,
    fov: 0,
    accuracy: 0,
    sampleRadius: 0,
  } as SensorEntity['config'],
});

describe('default sensor registry', () => {
  it('registers distance, IMU and GPS, but not color without a resolver', () => {
    const registry = registerDefaultSensors(new SensorRegistry());
    expect(registry.types()).toEqual(['distance', 'imu', 'gps']);
    expect(registry.has('color')).toBe(false);
  });

  it('registers color only when a resolver is supplied and skips existing factories', () => {
    const registry = new SensorRegistry();
    const marker = {};
    const factory = () => marker as never;
    registry.register('distance', factory);
    registerDefaultSensors(registry, {
      color: { resolver: createSolidColorResolver({ red: 1, green: 2, blue: 3 }) },
    });

    expect(registry.create(entity('distance'))).toBe(marker);
    expect(registry.has('color')).toBe(true);
  });

  it('creates a new registry per scene and auto-wires a document material resolver', () => {
    const document = {
      entities: [{ id: 'track', type: 'model', material: { color: '#123456' } }],
    } as never;
    const first = createDefaultSensorRegistry({ document });
    const second = createDefaultSensorRegistry({ document });
    expect(first).not.toBe(second);
    expect(first.has('color')).toBe(true);
  });
});
