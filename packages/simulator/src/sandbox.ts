/**
 * Browser entry of `@mica-js/simulator`.
 *
 * The sandbox adapter pulls in `@mica-js/sandbox` and embeds the packaged guest script, so it stays
 * out of the main entry: DOM-free consumers import `@mica-js/simulator`, browser assembly imports
 * `@mica-js/simulator/sandbox`.
 */
// The ambient module is declared in `virtual-runtime.d.ts`.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./virtual-runtime.d.ts" />
import { SandboxWorker } from '@mica-js/sandbox';
import type { SandboxWorkerOptions } from '@mica-js/sandbox';
import deviceGuestScript from './guest/device-simulation-host.ts?sandbox-worker-code';
import { createDeviceSimulationHostFromSandbox } from './host/sandbox-host';

/**
 * The default device simulation guest script, bundled and minified into this module while the
 * package is built.
 *
 * It is a classic script: every dependency is inlined, so the sandbox runs it without a module
 * loader. It resolves no devices — a package that owns devices passes its own guest script to the
 * sandbox instead.
 */
export const deviceSimulationHostGuestScript: string = deviceGuestScript;

/**
 * Creates the default device simulation guest worker.
 *
 * Pass the worker to `createDeviceSimulationHostFromSandbox` — or let
 * `@mica-js/canvas-editor`'s `SandboxHostProvider` start it, which is what it does by default.
 */
export function createDeviceSimulationHostGuestSandbox(
  options: SandboxWorkerOptions = {},
): SandboxWorker {
  return new SandboxWorker(deviceSimulationHostGuestScript, { name: 'device', ...options });
}

/**
 * The packaged guest as a worker class, kept for callers that construct it with `new`.
 *
 * @deprecated Prefer {@link createDeviceSimulationHostGuestSandbox}.
 */
export const DeviceSimulationHostGuestSandbox: new (
  options?: SandboxWorkerOptions,
) => SandboxWorker = class GeneratedDeviceSimulationHostSandbox extends SandboxWorker {
  constructor(options: SandboxWorkerOptions = {}) {
    super(deviceSimulationHostGuestScript, { name: 'device', ...options });
  }
};

export { createDeviceSimulationHostFromSandbox };
export type {
  DeviceSimulationHostFileSystem,
  SandboxDeviceSimulationHostOptions,
} from './host/sandbox-host';
export type {
  DeviceSimulationHost,
  DeviceSimTickReport,
  DeviceTopic,
  SimulationPublish,
} from './host/types';
