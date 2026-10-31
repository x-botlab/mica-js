import { parseSchematic } from '@mica-js/core/schematic';
import type { DeviceReference, DeviceSymbolProvider } from '@mica-js/core/schematic';
import type { SchematicDocument } from '@mica-js/core/schematic';
import type { CanvasBindingTarget, PayloadType } from '@mica-js/core/canvas';
import { Emitter } from '@mica-js/core/lifecycle';
import { createSchematicCircuit } from '../unified-ir/runtime';
import { deviceBoundaryOf } from '../unified-ir/runtime/circuit';
import type { DeviceBoundary } from '../unified-ir/runtime/bridge';
import type {
  Circuit,
  CircuitElectricalOptions,
  SchematicDeviceBinding,
  SchematicDeviceTopic,
} from '../unified-ir/runtime';
import type {
  DeviceSimulationHost,
  DeviceSimTickReport,
  DeviceTopic,
  SimulationPublish,
} from './types';

/** Reads the bytes of one schematic URI; the caller resolves relative references. */
export interface SchematicDeviceSimulationHostOptions {
  /** Local startup configuration, not an RPC method or payload. */
  readonly electrical?: CircuitElectricalOptions;
  readonly read: (uri: string) => Promise<Uint8Array>;
  /**
   * Symbol geometry of the schematics this host loads. Pass the same provider the schematic was
   * authored with; without it the derived topology contains no pins. A factory is called when a
   * schematic loads, so a caller can read its device library first.
   */
  readonly devices?: DeviceSymbolProvider | (() => DeviceSymbolProvider);
  /**
   * Resolves one schematic device reference to its runtime description and endpoints.
   *
   * The host ships no device models: the package that owns the devices decides which references
   * exist, what they look like and which topics they expose.
   */
  readonly resolveDevice: (reference: DeviceReference) => SchematicDeviceBinding | undefined;
}

interface LoadedDevice {
  readonly symbol: string;
  readonly deviceId: string;
  readonly designator: string;
  readonly binding: SchematicDeviceBinding;
}

interface LoadedRuntime {
  readonly circuit: Circuit;
  readonly boundary: DeviceBoundary;
  readonly schematic: SchematicDocument;
  readonly devices: readonly LoadedDevice[];
  readonly topics: readonly DeviceTopic[];
  readonly inputs: ReadonlyMap<string, InputBinding>;
}

interface InputBinding {
  readonly device: LoadedDevice;
  readonly topic: SchematicDeviceTopic;
}

interface PendingDelivery {
  readonly device: LoadedDevice;
  readonly port: string;
  readonly payload: unknown;
}

const INSTANCE_ID = 'device-simulation-host';

function targetKey(deviceId: string, port: string): string {
  return `${deviceId}\u0000${port}`;
}

/**
 * Value equality of two topic payloads.
 *
 * A canvas topic is a `level` unless it carries text or bytes (RFC 0017), so re-sending the value a
 * device already published only costs a widget repaint. Byte payloads compare by content because a
 * device may hand out a fresh buffer per step.
 */
function samePayload(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (previous instanceof Uint8Array && next instanceof Uint8Array) {
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index] !== next[index]) return false;
    }
    return true;
  }
  if (typeof previous !== 'object' || previous === null) return false;
  if (typeof next !== 'object' || next === null) return false;
  const a = previous as { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown };
  const b = next as { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown };
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function isVec2d(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as { readonly x?: unknown; readonly y?: unknown };
  return typeof point.x === 'number' && typeof point.y === 'number';
}

function payloadMatches(type: PayloadType, payload: unknown): boolean {
  switch (type) {
    case 'boolean':
      return typeof payload === 'boolean';
    case 'number':
      return typeof payload === 'number';
    case 'string':
      return typeof payload === 'string';
    case 'bytes':
    case 'bytes<rgb565>':
    case 'bytes<segments>':
      return payload instanceof Uint8Array;
    case 'vec2d':
      return isVec2d(payload);
    case 'vec3d':
      return isVec2d(payload) && typeof (payload as { readonly z?: unknown }).z === 'number';
  }
}

function decodeSchematic(bytes: Uint8Array): SchematicDocument {
  return parseSchematic(new TextDecoder().decode(bytes));
}

function buildRuntime(
  circuit: Circuit,
  schematic: SchematicDocument,
  bindings: Awaited<ReturnType<typeof createSchematicCircuit>>['bindings'],
  resolveDevice: SchematicDeviceSimulationHostOptions['resolveDevice'],
): LoadedRuntime {
  const symbols = new Map(schematic.sheet.symbols.map((symbol) => [symbol.id, symbol]));
  const devices: LoadedDevice[] = [];
  const topics: DeviceTopic[] = [];
  const inputs = new Map<string, InputBinding>();

  for (const binding of bindings) {
    const deviceBinding = resolveDevice(binding.reference);
    if (deviceBinding === undefined) continue;
    const symbol = symbols.get(binding.symbolId);
    const designator = symbol?.designator ?? binding.symbolId;
    const device: LoadedDevice = {
      symbol: binding.symbolId,
      deviceId: binding.deviceId,
      designator,
      binding: deviceBinding,
    };
    devices.push(device);
    for (const topic of deviceBinding.topics ?? []) {
      topics.push({
        symbol: binding.symbolId,
        designator,
        port: topic.port,
        direction: topic.direction,
        type: topic.type,
        ...(topic.title === undefined ? {} : { title: topic.title }),
      });
      if (topic.direction === 'input')
        inputs.set(targetKey(binding.symbolId, topic.port), { device, topic });
    }
  }

  return {
    circuit,
    boundary: deviceBoundaryOf(circuit),
    schematic,
    devices,
    topics: Object.freeze(topics),
    inputs,
  };
}

/**
 * Same-thread `DeviceSimulationHost` over a schematic compiled by the unified-IR runtime.
 *
 * The host owns the circuit: `loadSchematic` reads, parses and compiles it, `tick` advances one
 * circuit step and publishes the output topics that changed, and `deliver` queues widget payloads
 * for the next step. Device models and their endpoints come from `resolveDevice`, so the host stays
 * generic. Nothing here touches the DOM, so the sandbox guest and a Node test use the same
 * implementation.
 */
export function createSchematicDeviceSimulationHost(
  options: SchematicDeviceSimulationHostOptions,
): DeviceSimulationHost {
  if (typeof options?.resolveDevice !== 'function') {
    throw new TypeError('createSchematicDeviceSimulationHost needs a resolveDevice function');
  }
  const { read, devices: symbols, resolveDevice } = options;
  const publishes = new Emitter<SimulationPublish>();
  const pending: PendingDelivery[] = [];
  /** Last payload published per endpoint, so an unchanged level topic stays silent. */
  const published = new Map<string, unknown>();
  let runtime: LoadedRuntime | undefined;
  let simTimePs = 0;
  let disposed = false;

  const publishOutput = (device: LoadedDevice, port: string, payload: unknown): void => {
    const topic = device.binding.topics?.find(
      (value) => value.port === port && value.direction === 'output',
    );
    if (topic === undefined)
      throw new TypeError(`Unknown output topic ${device.designator}.${port}`);
    if (!payloadMatches(topic.type, payload))
      throw new TypeError(`Invalid output payload for ${device.designator}.${port}`);
    if (!publishes.hasListeners) return;
    const key = targetKey(device.symbol, port);
    if (published.has(key) && samePayload(published.get(key), payload)) return;
    published.set(key, payload);
    publishes.fire({ target: { symbol: device.symbol, port }, payload, simTime: simTimePs });
  };
  const publishOutputs = (
    active: LoadedRuntime,
    diagnostics: NonNullable<DeviceSimTickReport['diagnostics']>[number][],
  ): void => {
    for (const device of active.devices) {
      try {
        active.boundary.publishOutputs(device.deviceId, (port, payload) =>
          publishOutput(device, port, payload),
        );
      } catch (cause) {
        diagnostics.push({
          code: 'device/output-failed',
          deviceId: device.symbol,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  };

  const clearRuntime = (): void => {
    runtime?.circuit.dispose();
    runtime = undefined;
    pending.length = 0;
    published.clear();
    simTimePs = 0;
  };

  return {
    async loadSchematic(uri: string | undefined): Promise<void> {
      if (disposed) return;
      if (uri === undefined) {
        clearRuntime();
        return;
      }
      const bytes = await read(uri);
      const schematic = decodeSchematic(bytes);
      const symbolProvider = typeof symbols === 'function' ? symbols() : symbols;
      const compiled = await createSchematicCircuit(schematic, {
        ...(symbolProvider === undefined ? {} : { devices: symbolProvider }),
        resolveDevice,
        ...(options.electrical === undefined ? {} : { electrical: options.electrical }),
        instanceId: INSTANCE_ID,
      });
      const next = buildRuntime(compiled.circuit, schematic, compiled.bindings, resolveDevice);
      runtime?.circuit.dispose();
      pending.length = 0;
      // A fresh runtime starts from its initial state, so the first step after it publishes again.
      published.clear();
      simTimePs = 0;
      runtime = next;
    },

    async reset(): Promise<void> {
      if (disposed) return;
      pending.length = 0;
      published.clear();
      simTimePs = 0;
      runtime?.circuit.reset();
    },

    async tick(dt: number): Promise<DeviceSimTickReport> {
      if (!Number.isSafeInteger(dt) || dt <= 0) {
        throw new TypeError(
          `DeviceSimulationHost.tick expects a positive integer dt, received ${dt}`,
        );
      }
      if (disposed) {
        return { simTime: simTimePs, executed: 0 };
      }
      const active = runtime;
      if (active === undefined) {
        simTimePs += dt;
        return { simTime: simTimePs, executed: 0 };
      }
      const queued = pending.splice(0, pending.length);
      const deliveries = new Map<LoadedDevice, { port: string; payload: unknown }[]>();
      for (const delivery of queued) {
        const values = deliveries.get(delivery.device) ?? [];
        values.push({ port: delivery.port, payload: delivery.payload });
        deliveries.set(delivery.device, values);
      }
      const diagnostics: NonNullable<DeviceSimTickReport['diagnostics']>[number][] = [];
      for (const device of active.devices) {
        const inputs = deliveries.get(device);
        if (inputs === undefined && !active.boundary.hasInputHook(device.deviceId)) continue;
        try {
          active.boundary.deliverInputs(device.deviceId, inputs ?? []);
        } catch (cause) {
          diagnostics.push({
            code: 'device/input-failed',
            deviceId: device.symbol,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      const before = active.circuit.tickCount;
      try {
        active.circuit.runBatch(1, dt);
      } finally {
        simTimePs += dt * Number(active.circuit.tickCount - before);
      }
      publishOutputs(active, diagnostics);
      return {
        simTime: simTimePs,
        executed: Number(active.circuit.tickCount - before),
        ...(diagnostics.length === 0 ? {} : { diagnostics: Object.freeze(diagnostics) }),
      };
    },

    async deliver(target: CanvasBindingTarget, payload: unknown): Promise<void> {
      if (disposed) return;
      const active = runtime;
      if (active === undefined) {
        throw new Error('DeviceSimulationHost has no loaded schematic');
      }
      const binding = active.inputs.get(targetKey(target.symbol, target.port));
      if (binding === undefined) {
        throw new Error(`Unknown device input ${target.symbol}.${target.port}`);
      }
      if (!payloadMatches(binding.topic.type, payload)) {
        throw new TypeError(
          `${target.symbol}.${target.port} expects a ${binding.topic.type} payload`,
        );
      }
      const device = binding.device;
      pending.push({ device, port: target.port, payload });
    },

    onDidPublish: publishes.event,

    async getTopics(): Promise<readonly DeviceTopic[]> {
      return runtime?.topics ?? [];
    },

    async getSimTime(): Promise<number> {
      return simTimePs;
    },

    async getSchematic(): Promise<SchematicDocument | undefined> {
      return runtime?.schematic;
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      publishes.dispose();
      clearRuntime();
    },
  };
}
