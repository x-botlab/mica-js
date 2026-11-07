/**
 * Output of a sensor at one point in virtual time (#192).
 *
 * Every reading carries the {@link TimePs} at which it was taken, so a consumer can reason about
 * stale data without consulting the host clock: circuits advance on a virtual clock shared by
 * every subsystem, and a sensor that samples below the step rate simply skips frames.
 *
 * The types are plain readonly objects. Camera frames are the only large payload; every other
 * sensor returns a handful of numbers.
 */

/**
 * Picoseconds per millisecond.
 *
 * The simulation clock is expressed in picoseconds (`TimePs`), so one millisecond of virtual time
 * is `1_000_000_000n` ticks. Integer arithmetic keeps timestamps exact for any delta a circuit can
 * express.
 */
export const PS_PER_MILLISECOND = 1_000_000_000n;

/** Picoseconds per second, the unit sensor update rates are expressed against. */
export const PS_PER_SECOND = 1_000_000_000_000n;

/** Camera frame: RGBA pixels of an offscreen render. */
export interface CameraSensorData {
  readonly type: 'camera';
  /** RGBA pixels in row-major order; `length === width * height * 4`. */
  readonly image: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Capture time on the virtual clock, in picoseconds. */
  readonly timestamp: bigint;
}

/** Distance reading; `null` means nothing was within range. */
export interface DistanceSensorData {
  readonly type: 'distance';
  /** Measured distance in metres, or `null` when the range is exceeded. */
  readonly distance: number | null;
  readonly timestamp: bigint;
}

/** Colour reading used for line following. */
export interface ColorSensorData {
  readonly type: 'color';
  /** RGB colour channels, each in the `0..255` range. */
  readonly color: [number, number, number];
  /** Luminance in the `0..255` range. */
  readonly grayscale: number;
  readonly timestamp: bigint;
}

/** Inertial measurement: angular velocity, linear acceleration and orientation. */
export interface IMUSensorData {
  readonly type: 'imu';
  /** Angular velocity in rad/s, `[x, y, z]`. */
  readonly angularVelocity: [number, number, number];
  /** Linear acceleration in m/s², `[x, y, z]`. */
  readonly linearAcceleration: [number, number, number];
  /** Orientation quaternion, `[x, y, z, w]`. */
  readonly orientation: [number, number, number, number];
  readonly timestamp: bigint;
}

/** Global positioning reading. */
export interface GPSSensorData {
  readonly type: 'gps';
  /** Latitude in degrees. */
  readonly latitude: number;
  /** Longitude in degrees. */
  readonly longitude: number;
  /** Altitude in metres. */
  readonly altitude: number;
  /** Estimated positional accuracy in metres. */
  readonly accuracy: number;
  readonly timestamp: bigint;
}

/** Ambient light reading. */
export interface LightSensorData {
  readonly type: 'light';
  /** Illuminance in lux. */
  readonly intensity: number;
  readonly timestamp: bigint;
}

/** Sound pressure reading. */
export interface SoundSensorData {
  readonly type: 'sound';
  /** Sound pressure level in dB. */
  readonly level: number;
  readonly timestamp: bigint;
}

/** Magnetic field reading. */
export interface MagneticSensorData {
  readonly type: 'magnetic';
  /** Magnetic field strength in μT, `[x, y, z]`. */
  readonly field: [number, number, number];
  readonly timestamp: bigint;
}

/** Beam-break (photoelectric gate) reading. */
export interface OcclusionSensorData {
  readonly type: 'occlusion';
  /** Whether the beam is currently blocked. */
  readonly occluded: boolean;
  readonly timestamp: bigint;
}

/** Touch or collision reading. */
export interface TouchSensorData {
  readonly type: 'touch';
  /** Whether the sensor is pressed. */
  readonly pressed: boolean;
  /** Contact force in newtons, or `null` when nothing touches the sensor. */
  readonly force: number | null;
  readonly timestamp: bigint;
}

/**
 * Union of every sensor output, discriminated by `type`.
 *
 * Consumers narrow with `data.type`; the discriminant matches the sensor kind, not the concrete
 * implementation class.
 */
export type SensorData =
  | CameraSensorData
  | DistanceSensorData
  | ColorSensorData
  | IMUSensorData
  | GPSSensorData
  | LightSensorData
  | SoundSensorData
  | MagneticSensorData
  | OcclusionSensorData
  | TouchSensorData;

/** Maps a {@link SensorData} discriminant onto its concrete reading type. */
export interface SensorDataMap {
  readonly camera: CameraSensorData;
  readonly distance: DistanceSensorData;
  readonly color: ColorSensorData;
  readonly imu: IMUSensorData;
  readonly gps: GPSSensorData;
  readonly light: LightSensorData;
  readonly sound: SoundSensorData;
  readonly magnetic: MagneticSensorData;
  readonly occlusion: OcclusionSensorData;
  readonly touch: TouchSensorData;
}

/** Concrete reading type of the sensor kind `T`. */
export type SensorDataOf<T extends keyof SensorDataMap> = SensorDataMap[T];
