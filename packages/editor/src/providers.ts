import type { DeviceMetadata } from '@mica-js/sdk/metadata';
import type { HostFs, WidgetModule } from '@mica-js/widget';

export type { DeviceFactory } from '@mica-js/simulator';

/** Absolute resource URIs; providers remain owned by the caller. */
export type IFileSystemProvider = HostFs;

/** SDK device JSON consumed without executing its paired module. */
export type IDeviceDefinition = DeviceMetadata;

export interface IDeviceDescription {
  readonly definition: IDeviceDefinition;
  /** Self-contained SDK ESM with named model and synchronous create exports. */
  readonly code: string;
}

/** Existing widget definition and self-contained ESM source default-exporting WidgetFactory. */
export type IWidgetDescription = WidgetModule;

export interface IDeviceLibrary {
  /** Full document ID, e.g. demo:button. Unknown IDs resolve to undefined; failures reject. */
  resolve(id: string): Promise<IDeviceDescription | undefined>;
}

export interface IWidgetLibrary {
  /** Full document ID, e.g. demo:indicator. Unknown IDs resolve to undefined; failures reject. */
  resolve(id: string): Promise<IWidgetDescription | undefined>;
}
