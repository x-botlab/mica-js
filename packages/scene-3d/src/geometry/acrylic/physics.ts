import { BUILTIN_MATERIAL_PRESETS } from '../../format/materials';
import type { MaterialLibrary, MaterialPreset } from '../../format/materials';
import { parseAcrylicContour, validateAcrylicDefinition } from './contour';
import { buildAcrylicMesh } from './mesh';
import type {
  AcrylicDefinition,
  AcrylicMaterialOverride,
  AcrylicPhysics,
  AcrylicContourOptions,
} from './types';

export interface AcrylicPhysicsOptions extends AcrylicContourOptions {
  readonly library?: MaterialLibrary;
  readonly materialLibrary?: MaterialLibrary;
  readonly convex?: boolean;
}

/** Material properties an acrylic plate resolves to, after presets and local overrides. */
export interface ResolvedAcrylicMaterial {
  readonly preset: string;
  readonly density: number;
  readonly friction: number;
  readonly restitution: number;
  readonly color?: string;
  readonly texture?: string;
  readonly metalness?: number;
  readonly roughness?: number;
  readonly opacity?: number;
}

function materialOverrides(definition: AcrylicDefinition): AcrylicMaterialOverride {
  return typeof definition.material === 'object' ? definition.material : {};
}

/**
 * Resolves the plate's material.
 *
 * A document library is **additive**: its presets override same-named built-ins and its `default`
 * replaces `'acrylic'`, but presets the document does not mention stay available.
 */
export function resolveAcrylicMaterial(
  definition: AcrylicDefinition,
  library?: MaterialLibrary,
): ResolvedAcrylicMaterial {
  const local = materialOverrides(definition);
  const presets: Readonly<Record<string, MaterialPreset>> = {
    ...BUILTIN_MATERIAL_PRESETS,
    ...(library?.presets ?? {}),
  };
  const presetName =
    local.preset ??
    (typeof definition.material === 'string' ? definition.material : undefined) ??
    library?.default ??
    'acrylic';
  const preset = presets[presetName];
  if (!preset) throw new RangeError(`Unknown acrylic material preset "${presetName}"`);

  const pick = <K extends keyof ResolvedAcrylicMaterial>(
    key: K,
    fallback: ResolvedAcrylicMaterial[K],
  ): ResolvedAcrylicMaterial[K] => {
    const localValue = (local as Record<string, unknown>)[key] as
      ResolvedAcrylicMaterial[K] | undefined;
    const topValue = (definition as unknown as Record<string, unknown>)[key] as
      ResolvedAcrylicMaterial[K] | undefined;
    const presetValue = (preset as unknown as Record<string, unknown>)[key] as
      ResolvedAcrylicMaterial[K] | undefined;
    return localValue ?? topValue ?? presetValue ?? fallback;
  };

  return {
    preset: presetName,
    density: pick('density', preset.density),
    friction: pick('friction', preset.friction),
    restitution: pick('restitution', preset.restitution),
    ...onlyDefined('color', pick('color', undefined)),
    ...onlyDefined('texture', pick('texture', undefined)),
    ...onlyDefined('metalness', pick('metalness', undefined)),
    ...onlyDefined('roughness', pick('roughness', undefined)),
    ...onlyDefined('opacity', pick('opacity', undefined)),
  };
}

function onlyDefined<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Compute mass and thin-plate principal inertias in kg and kg·m². */
export function computeAcrylicPhysics(
  definition: AcrylicDefinition,
  options: AcrylicPhysicsOptions = {},
): AcrylicPhysics {
  validateAcrylicDefinition(definition);
  const material = resolveAcrylicMaterial(definition, options.library ?? options.materialLibrary);
  if (!Number.isFinite(material.density) || material.density <= 0)
    throw new RangeError('Acrylic density must be a positive finite number');
  if (
    !Number.isFinite(material.friction) ||
    material.friction < 0 ||
    !Number.isFinite(material.restitution) ||
    material.restitution < 0
  )
    throw new RangeError('Acrylic friction and restitution must be finite non-negative numbers');
  const parsed = parseAcrylicContour(definition.contour, options);
  const mesh = buildAcrylicMesh(definition, options);
  const area = parsed.area;
  const volume = area * definition.thickness;
  const mass = volume * material.density * 1000;
  const width = parsed.bounds.max.x - parsed.bounds.min.x;
  const depth = parsed.bounds.max.y - parsed.bounds.min.y;
  const t = definition.thickness;
  const inertia = {
    x: (mass * (depth * depth + t * t)) / 12,
    y: (mass * (width * width + depth * depth)) / 12,
    z: (mass * (width * width + t * t)) / 12,
  };
  let boundingRadius = 0;
  for (let i = 0; i < mesh.positions.length; i += 3)
    boundingRadius = Math.max(
      boundingRadius,
      Math.hypot(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!),
    );
  return {
    mass,
    inertia,
    collider: { type: options.convex ? 'convex-hull' : 'trimesh', source: 'geometry' },
    boundingRadius,
    bounds: mesh.bounds,
    friction: material.friction,
    restitution: material.restitution,
  };
}
export function calculateAcrylicMass(
  definition: AcrylicDefinition,
  options: AcrylicPhysicsOptions = {},
): number {
  return computeAcrylicPhysics(definition, options).mass;
}
