import { defineRpcService } from '@mica-js/core/rpc';
import type { CanvasBindingTarget } from '@mica-js/core/canvas';
import type { SchematicDocument } from '@mica-js/core/schematic';
import type { DeviceSimTickReport, DeviceTopic, SimulationPublish } from './types';

/** Host file system the sandbox guest reads schematics through. */
export interface DeviceSimulationHostFileSystemRpc {
  read(uri: string): Promise<Uint8Array>;
}

/** Methods the device simulation guest exposes over the sandbox RPC channel. */
export interface DeviceSimulationHostRpc {
  loadSchematic(uri: string | undefined): Promise<void>;
  reset(): Promise<void>;
  tick(dt: number): Promise<DeviceSimTickReport>;
  /**
   * `payload` is the one intentionally arbitrary value: widget/device payloads are plugin-defined
   * and validated against the target topic. Every other argument and result is a precise DTO.
   */
  deliver(target: CanvasBindingTarget, payload: unknown, simTime?: number): Promise<void>;
  onDidPublish(listener: (publish: SimulationPublish) => void): () => void;
  getTopics(): Promise<readonly DeviceTopic[]>;
  getSimTime(): Promise<number>;
  getSchematic(): Promise<SchematicDocument | undefined>;
  dispose(): Promise<void>;
}

/**
 * Wire names both sides of the sandbox agree on: the worker script registers the device simulation
 * contract as `guest`, and calls the host back through `host-capabilities` to read schematic bytes.
 */
export const deviceSimulationHostGuestService = defineRpcService<DeviceSimulationHostRpc>('guest');
export const deviceSimulationHostFileSystemService =
  defineRpcService<DeviceSimulationHostFileSystemRpc>('host-capabilities');
