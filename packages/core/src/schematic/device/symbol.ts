import type { Rect } from '../format/types';
import type { DeviceReference } from './reference';

export interface PinAnchor {
  readonly x: number;
  readonly y: number;
}

export interface DeviceSymbolDefinition {
  /** Name rendered at the centre of the symbol. */
  readonly name: string;
  /** Pin id to pre-placement anchor coordinate in symbol space. */
  readonly pins: Readonly<Record<string, PinAnchor>>;
  /** Optional outline used by the editor to draw the symbol body. */
  readonly bounds?: Rect;
}

export interface DeviceSymbolGeometry {
  /** Placement-independent geometry, as provided by the device description. */
  readonly name?: string;
  readonly pins: Readonly<Record<string, PinAnchor>>;
  readonly bounds?: Rect;
}

export interface DeviceSymbolProvider {
  /** Symbol geometry; `undefined` when the device is unknown or has no geometry. */
  getDeviceSymbol(reference: DeviceReference): DeviceSymbolDefinition | undefined;
  /** Name rendered on the symbol: the symbol name, else the display name. `undefined` when unknown. */
  getDeviceName(reference: DeviceReference): string | undefined;
}
