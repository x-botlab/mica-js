import type { Scene3DDocument } from '../format';
import { ColorSensor, createMaterialColorResolver, type SurfaceColorResolver } from './color';
import { DistanceSensor } from './distance';
import { GPSSensor } from './gps';
import { IMUSensor } from './imu';
import { SensorRegistry } from './registry';

export interface DefaultSensorOptions {
  readonly color?: { readonly resolver: SurfaceColorResolver };
}

/** Registers the built-in concrete sensors that are available in this package. */
export function registerDefaultSensors(
  registry: SensorRegistry,
  options: DefaultSensorOptions = {},
): SensorRegistry {
  if (!(registry instanceof SensorRegistry)) {
    throw new TypeError('registerDefaultSensors: a SensorRegistry is required');
  }
  if (!registry.has('distance'))
    registry.register('distance', (entity) => new DistanceSensor(entity));
  if (!registry.has('imu')) registry.register('imu', (entity) => new IMUSensor(entity));
  if (!registry.has('gps')) registry.register('gps', (entity) => new GPSSensor(entity));
  if (options.color !== undefined && !registry.has('color')) {
    registry.register(
      'color',
      (entity) =>
        new ColorSensor(entity, options.color as { readonly resolver: SurfaceColorResolver }),
    );
  }
  return registry;
}

/** Creates a fresh built-in registry for one scene. */
export function createDefaultSensorRegistry(
  options: {
    readonly document?: Scene3DDocument;
    readonly color?: { readonly resolver: SurfaceColorResolver };
  } = {},
): SensorRegistry {
  const resolver =
    options.color?.resolver ??
    (options.document === undefined
      ? undefined
      : createMaterialColorResolver(options.document.entities));
  return registerDefaultSensors(
    new SensorRegistry(),
    resolver === undefined ? {} : { color: { resolver } },
  );
}

/** @deprecated Use {@link createDefaultSensorRegistry}; each scene needs its own registry. */
export function getDefaultSensorRegistry(): SensorRegistry {
  return createDefaultSensorRegistry();
}
