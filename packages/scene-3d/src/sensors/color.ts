import type { ColorConfig, ModelEntity, SceneEntity, SensorEntity } from '../entities';
import type { AcrylicPaint } from '../geometry/acrylic';
import { Quaternion, Vec3d } from '../math';
import type { PhysicsRuntime, RaycastHit } from '../physics';
import { Sensor } from './base';
import type { ColorSensorData } from './types';

const DEFAULT_DIRECTION = { x: 0, y: -1, z: 0 } as const;

export interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/** Resolves the colour of one raycast surface hit. */
export interface SurfaceColorResolver {
  /** Returns a surface colour, or null when the hit has no usable colour. */
  resolve(hit: RaycastHit): Rgb | null;
}

/**
 * Resolves the painted colour of an acrylic plate at a world-space point.
 *
 * Strokes are tested in declaration order, so a later stroke paints over an earlier one. Returns
 * `null` when the painter defines neither a base colour nor a matching stroke, letting the caller
 * fall back to the material colour.
 */
export function resolveAcrylicPaint(
  paint: AcrylicPaint,
  point: { readonly x: number; readonly z: number },
): Rgb | null {
  for (const stroke of paint.strokes ?? []) {
    const offset = stroke.axis === 'x' ? point.z : point.x;
    if (Math.abs(offset - stroke.center) <= stroke.width / 2) {
      return parseCssColor(stroke.color);
    }
  }
  return paint.base === undefined ? null : parseCssColor(paint.base);
}

/** Resolves model material colours, with optional per-entity hit samplers taking precedence. */
export function createMaterialColorResolver(
  entities: readonly SceneEntity[],
  options: {
    readonly samplers?: Readonly<Record<string, (hit: RaycastHit) => Rgb | null>>;
  } = {},
): SurfaceColorResolver {
  const models = new Map<string, ModelEntity>();
  for (const entity of entities) {
    if (entity.type === 'model') models.set(entity.id, entity as ModelEntity);
  }

  return {
    resolve(hit: RaycastHit): Rgb | null {
      const model = models.get(hit.bodyId);
      if (model === undefined) return null;
      const sampler = options.samplers?.[hit.bodyId];
      if (sampler !== undefined) return sampler(hit);
      const geometry = model.geometry;
      if (geometry?.type === 'acrylic' && geometry.acrylic.paint !== undefined) {
        const painted = resolveAcrylicPaint(geometry.acrylic.paint, hit.point);
        if (painted !== null) return painted;
      }
      const color = model.material.color;
      return color === undefined ? null : parseCssColor(color);
    },
  };
}

/** Creates a resolver that returns one colour for every hit. */
export function createSolidColorResolver(color: Rgb): SurfaceColorResolver {
  const fixed = { red: color.red, green: color.green, blue: color.blue };
  return { resolve: () => fixed };
}

/** Raycast-based surface-colour sensor for line-following and material inspection. */
export class ColorSensor extends Sensor<ColorSensorData> {
  private readonly config: ColorConfig;
  private readonly resolver: SurfaceColorResolver;

  public constructor(entity: SensorEntity, options: { readonly resolver: SurfaceColorResolver }) {
    super(entity);
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.resolver?.resolve !== 'function'
    ) {
      throw new TypeError('ColorSensor: a surface color resolver is required');
    }
    this.config = entity.config as ColorConfig;
    this.resolver = options.resolver;
  }

  protected update(physics: PhysicsRuntime, currentTime: bigint): ColorSensorData {
    const transform = this.getWorldTransform(physics);
    const localDirection = this.config.direction ?? DEFAULT_DIRECTION;
    const direction = Quaternion.rotate(transform.rotation, localDirection);
    const maxRange = this.config.maxRange ?? 1;
    const radius = this.config.sampleRadius;
    const localOffsets =
      radius > 0
        ? [
            Vec3d.zero,
            { x: radius, y: 0, z: 0 },
            { x: -radius, y: 0, z: 0 },
            { x: 0, y: 0, z: radius },
            { x: 0, y: 0, z: -radius },
          ]
        : [Vec3d.zero];
    const colors: Rgb[] = [];

    for (const localOffset of localOffsets) {
      const origin = Vec3d.add(
        transform.position,
        Quaternion.rotate(transform.rotation, localOffset),
      );
      const hit = raycastIgnoringMountedBody(physics, origin, direction, maxRange, this.mountedOn);
      if (
        hit === null ||
        !Number.isFinite(hit.distance) ||
        hit.distance < 0 ||
        hit.distance > maxRange
      )
        continue;
      const color = this.resolver.resolve(hit);
      if (color !== null) colors.push(color);
    }

    const color: [number, number, number] =
      colors.length === 0
        ? [255, 255, 255]
        : [
            channelAverage(colors, 'red'),
            channelAverage(colors, 'green'),
            channelAverage(colors, 'blue'),
          ];

    return {
      type: 'color',
      color,
      grayscale: Math.round(0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]),
      timestamp: currentTime,
    };
  }
}

function channelAverage(colors: readonly Rgb[], channel: keyof Rgb): number {
  const total = colors.reduce((sum, color) => sum + color[channel], 0);
  return clampByte(Math.round(total / colors.length));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function parseCssColor(value: string): Rgb | null {
  const hex = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return {
      red: Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      green: Number.parseInt(`${hex[2]}${hex[2]}`, 16),
      blue: Number.parseInt(`${hex[3]}${hex[3]}`, 16),
    };
  }
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    return {
      red: Number.parseInt(hex.slice(1, 3), 16),
      green: Number.parseInt(hex.slice(3, 5), 16),
      blue: Number.parseInt(hex.slice(5, 7), 16),
    };
  }
  return null;
}

/** Ignores the mounted body; the physics engine may return it before the surface being sampled. */
function raycastIgnoringMountedBody(
  physics: PhysicsRuntime,
  origin: Vec3d,
  direction: Vec3d,
  maxDistance: number,
  mountedOn: string | undefined,
): RaycastHit | null {
  let hit = physics.raycast(origin, direction, maxDistance);
  if (mountedOn !== undefined && hit?.bodyId === mountedOn) {
    // The in-memory runtime returns null when the origin is inside a shape. A second query also
    // lets physics adapters that advance through filtered hits expose the next surface.
    hit = physics.raycast(origin, direction, maxDistance);
  }
  return hit?.bodyId === mountedOn ? null : hit;
}
