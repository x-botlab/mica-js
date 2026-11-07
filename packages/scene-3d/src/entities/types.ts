/**
 * Entity types of the `.scene3d` document (#179).
 *
 * Every descriptor is a plain readonly object so a document can be serialised, diffed and shared
 * with the physics runtime without defensive copies. Lengths are metres, angles are radians and
 * masses are kilograms, matching the rest of `@mica-js/scene-3d`.
 *
 * The entity hierarchy mirrors the design document: {@link SceneEntity} holds the pose and
 * identity shared by every entity, and a concrete interface narrows `type` and adds its own
 * payload.
 *
 * Entities no longer bind a schematic symbol as a whole. Instead, joints and sensors declare a
 * {@link JointEntity.bindings} or {@link SensorEntity.bindings} map keyed by port name (for
 * example, `"torque"` or `"position"`), mirroring the 2D Widget binding model.
 */

import type { Quaternion, Vec2d, Vec3d } from '../math';

/** Endpoint of an entity port: a port of one symbol instance in the bound schematic. */
export interface BindingTarget {
  readonly symbol: string;
  readonly port: string;
}

/** Every entity kind a document may contain. */
export const ENTITY_TYPES = ['model', 'assembly', 'joint', 'sensor'] as const;

/** Discriminant of a scene entity. */
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Fields shared by every entity in a scene.
 *
 * `position` and `rotation` are the initial pose used when the runtime creates the entity; after
 * that the runtime owns the live pose.
 */
export interface SceneEntity {
  /** Stable identity, unique within the document. */
  readonly id: string;
  /** Entity kind; consumers narrow a {@link SceneEntity} with this discriminant. */
  readonly type: EntityType;
  /** Human-readable name shown by the editor. */
  readonly name?: string;
  /** Initial position in world space, in metres. */
  readonly position: Vec3d;
  /** Initial rotation as a unit quaternion. */
  readonly rotation: Quaternion;
}

/**
 * Reference to an assembly definition placed in the scene.
 *
 * The definition itself (its entities and bound schematic) lives in a separate `.assembly.json`
 * file; an instance only names it, so the same template can be placed several times with different
 * poses and per-instance overrides.
 */
export interface AssemblyInstance extends SceneEntity {
  readonly type: 'assembly';
  /** Assembly definition to instantiate, formatted as `package:name`. */
  readonly assembly: string;
  /** Per-instance property overrides applied on top of the assembly definition. */
  readonly overrides?: Record<string, unknown>;
}

/** How the physics engine moves a rigid body. */
export const BODY_TYPES = ['static', 'dynamic', 'kinematic'] as const;

/** Rigid-body mode of a model. */
export type BodyType = (typeof BODY_TYPES)[number];

/** Per-axis lock used by {@link MotionConstraints}; an omitted axis stays free. */
export interface AxisConstraint {
  readonly x?: boolean;
  readonly y?: boolean;
  readonly z?: boolean;
}

/** Translational and rotational locks applied to a rigid body. */
export interface MotionConstraints {
  readonly freezePosition?: AxisConstraint;
  readonly freezeRotation?: AxisConstraint;
}

/**
 * Physics configuration of a {@link ModelEntity}.
 *
 * `mass` is required for a `dynamic` body unless the system can derive it (an acrylic plate, for
 * example, computes it from density and volume); static and kinematic bodies ignore it.
 */
export interface PhysicsConfig {
  /** Rigid-body mode. */
  readonly bodyType: BodyType;
  /** Mass in kilograms. */
  readonly mass?: number;
  /** Initial linear velocity in metres per second; only used by dynamic bodies. */
  readonly velocity?: Vec3d;
  /** Initial angular velocity in radians per second; only used by dynamic bodies. */
  readonly angularVelocity?: Vec3d;
  /** Motion locks, for example to keep a wheel on its axle. */
  readonly constraints?: MotionConstraints;
}

/** Primitive geometry kinds supported by {@link GeometryDescriptor}. */
export const GEOMETRY_TYPES = ['box', 'sphere', 'cylinder', 'capsule', 'plane'] as const;

/** A box; `size` is the full extent along each local axis, in metres. */
export interface BoxGeometry {
  readonly type: 'box';
  readonly size: Vec3d;
}

/** A sphere of `radius` metres. */
export interface SphereGeometry {
  readonly type: 'sphere';
  readonly radius: number;
}

/** A cylinder aligned with the local Y axis; `height` is its full height in metres. */
export interface CylinderGeometry {
  readonly type: 'cylinder';
  readonly radius: number;
  readonly height: number;
}

/**
 * A capsule aligned with the local Y axis: a cylinder capped by two hemispheres.
 *
 * `height` is the total height including the caps, so it must be at least `2 * radius`.
 */
export interface CapsuleGeometry {
  readonly type: 'capsule';
  readonly radius: number;
  readonly height: number;
}

/** A rectangle in the local XY plane; `size` is its width and height in metres. */
export interface PlaneGeometry {
  readonly type: 'plane';
  readonly size: Vec2d;
}

/**
 * Shape of a model, discriminated by `type`.
 *
 * Phase 1 covers the primitive solids; mesh, heightmap and acrylic shapes are added by the issues
 * that own their payloads.
 */
export type GeometryDescriptor =
  BoxGeometry | SphereGeometry | CylinderGeometry | CapsuleGeometry | PlaneGeometry;

/**
 * Collision shape of a model, discriminated by `type`.
 *
 * A collider is declared separately from {@link GeometryDescriptor}: a detailed mesh can render
 * with a simple box, convex hull or compound collider underneath it.
 */
export type ColliderDescriptor =
  | { readonly type: 'box'; readonly size: Vec3d }
  | { readonly type: 'sphere'; readonly radius: number }
  | { readonly type: 'cylinder'; readonly radius: number; readonly height: number }
  | { readonly type: 'capsule'; readonly radius: number; readonly height: number }
  /** Exact triangle mesh generated from the entity geometry. */
  | { readonly type: 'trimesh'; readonly source: 'geometry' }
  /** Convex hull generated from the entity geometry; cheaper than a trimesh. */
  | { readonly type: 'convex-hull'; readonly source: 'geometry' }
  /** Several colliders attached to the same body. */
  | { readonly type: 'compound'; readonly children: readonly ColliderDescriptor[] };

/**
 * Visual and physical surface properties of a model.
 *
 * Rendering fields are optional so an entity can inherit them from the document's material preset
 * library; `friction` and `restitution` are always explicit because the physics world needs them
 * for every collision.
 */
export interface MaterialDescriptor {
  /** Base colour in CSS notation, for example `#ff8800`. */
  readonly color?: string;
  /** Texture URL or project-relative path. */
  readonly texture?: string;
  /** Metalness in the `0..1` range. */
  readonly metalness?: number;
  /** Roughness in the `0..1` range. */
  readonly roughness?: number;
  /** Opacity in the `0..1` range; values below 1 make the model transparent. */
  readonly opacity?: number;
  /** Coulomb friction coefficient; 0 is frictionless. */
  readonly friction: number;
  /** Bounciness in the `0..1` range; 0 absorbs all impact energy. */
  readonly restitution: number;
}

/** A physical model: the entity kind that owns geometry, material and a rigid body. */
export interface ModelEntity extends SceneEntity {
  readonly type: 'model';
  readonly geometry: GeometryDescriptor;
  readonly material: MaterialDescriptor;
  readonly collider: ColliderDescriptor;
  readonly physics: PhysicsConfig;
}

/**
 * A joint between two bodies.
 *
 * Joints can expose multiple ports (for example, `"torque"` input and `"position"`/`"velocity"`
 * outputs). The joint payload (type, connected bodies, anchors, limits and motor) is introduced by
 * the joint system types.
 */
export interface JointEntity extends SceneEntity {
  readonly type: 'joint';
  /** Port key → endpoint; only bound ports take part in messaging. */
  readonly bindings?: Readonly<Record<string, BindingTarget>>;
}

/** Every sensor kind understood by the sensor system. */
export const SENSOR_TYPES = [
  'camera',
  'distance',
  'color',
  'imu',
  'gps',
  'light',
  'sound',
  'magnetic',
  'occlusion',
  'touch',
] as const;

/** Kind of a {@link SensorEntity}. */
export type SensorType = (typeof SENSOR_TYPES)[number];

/** Configuration of a camera sensor; a camera renders to an offscreen surface. */
export interface CameraConfig {
  readonly type: 'camera';
  /** Horizontal field of view in radians. */
  readonly fov: number;
  /** Frame width in pixels. */
  readonly width: number;
  /** Frame height in pixels. */
  readonly height: number;
  /** Near clipping plane in metres. */
  readonly near: number;
  /** Far clipping plane in metres. */
  readonly far: number;
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
}

/** Configuration of a distance sensor (ultrasonic or infrared). */
export interface DistanceConfig {
  readonly type: 'distance';
  /** Maximum measurable range in metres. */
  readonly maxRange: number;
  /** Detection cone angle in degrees. */
  readonly fov: number;
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
}

/** Configuration of a colour sensor used for line following. */
export interface ColorConfig {
  readonly type: 'color';
  /** Radius of the sampled patch in metres. */
  readonly sampleRadius: number;
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
}

/** Configuration of an inertial measurement unit. */
export interface IMUConfig {
  readonly type: 'imu';
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
  /** Standard deviation of the simulated gyroscope noise, in rad/s. */
  readonly gyroNoise?: number;
  /** Standard deviation of the simulated accelerometer noise, in m/s². */
  readonly accelNoise?: number;
}

/** Configuration of a GPS receiver. */
export interface GPSConfig {
  readonly type: 'gps';
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
  /** Positional accuracy in metres. */
  readonly accuracy: number;
  /** Scene-space origin mapped to the first reported coordinate. */
  readonly origin?: Vec3d;
}

/** Configuration of an ambient light sensor. */
export interface LightConfig {
  readonly type: 'light';
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
}

/** Configuration of a sound sensor. */
export interface SoundConfig {
  readonly type: 'sound';
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
  /** Input sensitivity, where 1 is nominal. */
  readonly sensitivity: number;
}

/** Configuration of a magnetic field sensor (hall effect or reed switch). */
export interface MagneticConfig {
  readonly type: 'magnetic';
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
  /** Field strength in μT above which a reed switch closes. */
  readonly threshold?: number;
}

/** Configuration of a beam-break (occlusion) sensor. */
export interface OcclusionConfig {
  readonly type: 'occlusion';
  /** Detection range in metres. */
  readonly range: number;
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
}

/** Configuration of a touch or collision sensor. */
export interface TouchConfig {
  readonly type: 'touch';
  /** Force in newtons above which the sensor reports a press. */
  readonly threshold: number;
  /** Sampling frequency in hertz. */
  readonly updateRate: number;
}

/**
 * Type-specific configuration of a sensor, discriminated by `type`.
 *
 * Every member carries an `updateRate`, so the runtime can throttle all sensors uniformly; the
 * value should match the owning entity's {@link SensorEntity.sensorType}.
 */
export type SensorConfig =
  | CameraConfig
  | DistanceConfig
  | ColorConfig
  | IMUConfig
  | GPSConfig
  | LightConfig
  | SoundConfig
  | MagneticConfig
  | OcclusionConfig
  | TouchConfig;

/**
 * A sensor mounted in the scene.
 *
 * Sensors can expose multiple output ports (for example, an IMU might publish `"acceleration"`,
 * `"gyro"` and `"magnetometer"` separately). `config` holds the type-specific payload while
 * `sensorType` lets a consumer narrow it without trusting the document; the two are expected to
 * describe the same kind of sensor.
 *
 * `position` and `rotation` are interpreted in the local frame of {@link SensorEntity.mountedOn}
 * when it is set, and in world space otherwise.
 */
export interface SensorEntity extends SceneEntity {
  readonly type: 'sensor';
  /** Kind of sensor; should match {@link SensorEntity.config}. */
  readonly sensorType: SensorType;
  /** Type-specific configuration, including the sampling frequency. */
  readonly config: SensorConfig;
  /** Port key → endpoint; only bound ports take part in messaging. */
  readonly bindings?: Readonly<Record<string, BindingTarget>>;
  /** Entity the sensor is rigidly attached to; omitted for a sensor fixed in world space. */
  readonly mountedOn?: string;
}
