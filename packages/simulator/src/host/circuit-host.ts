import type { SchematicDocument } from '@mica-js/core/schematic';
import type { CanvasBindingTarget } from '@mica-js/core/canvas';
import { toDisposable } from '@mica-js/core/lifecycle';
import type { Circuit } from '../unified-ir/runtime';
import type { DeviceSimulationHost, DeviceSimTickReport, DeviceTopic } from './types';

/** Picoseconds per circuit step used when mapping `Circuit.virtualTime` to simulation time. */
const DEFAULT_STEP_PS = 10_000;

export interface CircuitDeviceSimulationHostOptions {
  /** Circuit the caller already created. */
  readonly circuit: Circuit;
  /** Whether `dispose()` also disposes the circuit. Defaults to `true`. */
  readonly ownsCircuit?: boolean;
  /** Schematic the circuit was built from, reported through `getSchematic`. */
  readonly schematic?: SchematicDocument;
  /** Endpoints the running devices expose. */
  readonly topics?: readonly DeviceTopic[];
  /** Picoseconds per circuit step. Defaults to 10 ns. */
  readonly stepPs?: number;
  /** Routes one widget payload into the caller's device layer. */
  readonly deliver: (symbol: string, port: string, payload: unknown) => void;
}

/**
 * Adapts one already-loaded unified-IR circuit to the RFC 0018 device host.
 *
 * This is the same-thread adapter for an owner that keeps `Circuit` accessors for itself (a
 * diagnostics bench, for example). Application/canvas integration uses
 * `createDeviceSimulationHostFromSandbox` from `@mica-js/simulator/sandbox` and never holds a circuit.
 */
export function createCircuitDeviceSimulationHost({
  circuit,
  ownsCircuit = true,
  schematic,
  topics = [],
  stepPs = DEFAULT_STEP_PS,
  deliver,
}: CircuitDeviceSimulationHostOptions): DeviceSimulationHost {
  if (!Number.isSafeInteger(stepPs) || stepPs <= 0)
    throw new TypeError('stepPs must be a positive safe integer');
  const simTime = (): number => Number(circuit.tickCount) * stepPs;

  return {
    async loadSchematic() {
      // The caller built the circuit before constructing this adapter.
    },
    async reset() {
      circuit.reset();
    },
    async tick(dt: number): Promise<DeviceSimTickReport> {
      if (!Number.isSafeInteger(dt) || dt <= 0) {
        throw new TypeError(
          `DeviceSimulationHost.tick expects a positive integer dt, received ${dt}`,
        );
      }
      const before = circuit.tickCount;
      circuit.runBatch(1, stepPs);
      return { simTime: simTime(), executed: Number(circuit.tickCount - before) };
    },
    async deliver(target: CanvasBindingTarget, payload: unknown) {
      deliver(target.symbol, target.port, payload);
    },
    onDidPublish: () =>
      toDisposable(() => {
        // The owner drives publishing through its own device layer.
      }),
    async getTopics() {
      return topics;
    },
    async getSimTime() {
      return simTime();
    },
    async getSchematic() {
      return schematic;
    },
    async dispose() {
      if (ownsCircuit) circuit.dispose();
    },
  };
}
