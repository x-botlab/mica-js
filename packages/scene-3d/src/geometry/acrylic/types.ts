import type { MaterialLibrary, MaterialPreset } from '../../format/materials';
import type { Vec2d, Vec3d } from '../../math';

export type AcrylicContour =
  | {
      readonly type: 'rect';
      readonly width: number;
      readonly height: number;
      readonly radius?: number;
    }
  | { readonly type: 'circle'; readonly radius: number }
  | { readonly type: 'polygon'; readonly points: readonly Vec2d[] }
  | { readonly type: 'svg'; readonly path: string }
  | {
      readonly type: 'compound';
      readonly outer: AcrylicContour;
      readonly holes: readonly AcrylicContour[];
    };

export interface AcrylicMaterialOverride {
  readonly preset?: string;
  readonly density?: number;
  readonly friction?: number;
  readonly restitution?: number;
  readonly color?: string;
  readonly texture?: string;
  readonly metalness?: number;
  readonly roughness?: number;
  readonly opacity?: number;
}

/**
 * One printed stroke on a plate surface.
 *
 * A stroke runs parallel to `axis` and is centred at `center` on the other in-plane axis, which is
 * what a line-following track is: a black band printed down the middle of the plate.
 */
export interface AcrylicPaintStroke {
  /** Axis the stroke runs along, in contour coordinates. */
  readonly axis: 'x' | 'z';
  /** Offset of the stroke centre on the perpendicular axis, in metres. */
  readonly center: number;
  /** Full width of the stroke in metres. */
  readonly width: number;
  /** CSS colour of the stroke. */
  readonly color: string;
}

/**
 * Printed artwork on one face of a plate.
 *
 * The host turns this into sensor samplers, so a colour sensor reads the painted surface without
 * shipping a bitmap across the sandbox boundary.
 */
export interface AcrylicPaint {
  /** Base colour of the surface; falls back to the material colour. */
  readonly base?: string;
  /** Strokes drawn over the base colour, in declaration order. */
  readonly strokes?: readonly AcrylicPaintStroke[];
}

/** A laser-cut plate. Lengths are metres, matching the scene document convention. */
export interface AcrylicDefinition {
  readonly contour: AcrylicContour;
  readonly thickness: number;
  /** Preset name, or a preset plus local rendering/physics overrides. */
  readonly material?: string | AcrylicMaterialOverride;
  /** Legacy/convenient top-level local overrides; material object overrides take precedence. */
  readonly density?: number;
  readonly friction?: number;
  readonly restitution?: number;
  readonly color?: string;
  readonly texture?: string;
  readonly metalness?: number;
  readonly roughness?: number;
  readonly opacity?: number;
  /** Alignment of the contour origin. The default is the bounding-box centre. */
  readonly origin?: 'center' | 'min' | 'max' | Vec2d;
  /** Printed artwork on the top face, read by surface sensors such as the colour sensor. */
  readonly paint?: AcrylicPaint;
}

export type AcrylicRing = readonly Vec2d[];

export interface AcrylicBounds {
  readonly min: Vec2d;
  readonly max: Vec2d;
}

export interface ParsedAcrylicContour {
  readonly rings: readonly AcrylicRing[];
  readonly area: number;
  readonly bounds: AcrylicBounds;
}

export interface AcrylicContourOptions {
  readonly segmentCount?: number;
  readonly curveSegments?: number;
}

/** Extruded mesh with vertices separated by face group; normals are directly renderable. */
export interface AcrylicMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly bounds: { readonly min: Vec3d; readonly max: Vec3d };
  readonly volume: number;
}

export interface AcrylicPhysics {
  readonly mass: number;
  readonly inertia: { readonly x: number; readonly y: number; readonly z: number };
  readonly collider: { readonly type: 'convex-hull' | 'trimesh'; readonly source: 'geometry' };
  readonly boundingRadius: number;
  /** Local-space AABB of the extruded plate, for raycasts and broad-phase shapes. */
  readonly bounds: { readonly min: Vec3d; readonly max: Vec3d };
  readonly friction: number;
  readonly restitution: number;
}

export type AcrylicLibrary = MaterialLibrary;
export type AcrylicPreset = MaterialPreset;
