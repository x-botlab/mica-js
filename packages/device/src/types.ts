import type { PropertyDescriptor, PropertyValue } from '@mica-js/core/schematic';

/** Payload types of logical topic ports (#10). */
export const TOPIC_PAYLOAD_TYPES = [
  'boolean',
  'number',
  'string',
  'vec2d',
  'vec3d',
  'bytes',
  'bytes<rgb565>',
  'bytes<segments>',
] as const;

export type TopicPayloadType = (typeof TOPIC_PAYLOAD_TYPES)[number];

/** One logical topic port declared by a device description (#10). */
export interface DevicePortDescriptor {
  readonly key: string;
  readonly title?: string;
  readonly description?: string;
  readonly direction: 'input' | 'output';
  readonly type: TopicPayloadType;
}

/** Metadata supplied by the package index or provider for a device description (#11). */
export interface DeviceDescriptionMetadata {
  /** Stable device identity, normally the provider's device id. */
  readonly name: string;
  /** Human-readable name; falls back to `name` when omitted. */
  readonly displayName?: string;
  /** Optional display description. */
  readonly description?: string;
}

/**
 * Parsed device description. Instance configuration is fixed at creation time (#7 / #8);
 * this object is the declaration, not a mutable runtime property store.
 */
export interface DeviceDescription {
  readonly name: string;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly properties: ReadonlyMap<string, PropertyDescriptor>;
  readonly ports: ReadonlyMap<string, DevicePortDescriptor>;
  readonly designatorPrefix: string | undefined;
}

/** Already-parsed definition plus implementation source returned by an {@link IDeviceProvider}. */
export interface DeviceDefinition {
  readonly definition: DeviceDescription;
  /** ES module source text of the device factory. */
  readonly code: string;
}

/**
 * Host-side source of device modules. The provider owns device id resolution, file location,
 * reading and missing-file diagnostics; the device package never scans or locates files.
 */
export interface IDeviceProvider {
  /** @returns `undefined` when `deviceId` is unknown. */
  resolve(deviceId: string): DeviceDefinition | undefined | Promise<DeviceDefinition | undefined>;
}

/**
 * Synchronous device factory. Its context contract is authored by #53; until then the parameter
 * is intentionally `never` so this package does not invent an instance API.
 */
export type DeviceFactory = (api: never) => unknown;

export interface LoadedDeviceModule {
  readonly deviceId: string;
  readonly description: DeviceDescription;
  readonly factory: DeviceFactory;
}

/** Independent, recursively frozen property snapshot for one device instance (#7 / #8). */
export type DevicePropertySnapshot = Readonly<Record<string, PropertyValue>>;
