import {
  createIRInterpreter,
  createIRJIT,
  toNumber,
  type FloatBits,
  type IRInterpreter,
  type IRStorage,
  type RuntimeScalar,
} from '@mica-js/ir';
import { compileCircuit } from '../unified-ir/compiler';
import { TEST_ELECTRICAL } from '../unified-ir/compiler/test-helpers';
import type {
  CircuitCompilationInput,
  CircuitCompilationOptions,
  CompiledCircuit,
} from '../unified-ir/compiler';
import { electricalCompilationOf } from '../unified-ir/compiler/electrical-compilation';
import {
  electricalCurrent,
  electricalDiagnostics,
  electricalDigitalSample,
  electricalVoltage,
  type ElectricalCurrentTarget,
  type ElectricalDiagnostic,
  type ElectricalReading,
} from './electrical-observation';
import { CircuitError } from '../unified-ir/runtime/types';
import { createDeviceBoundary, type DeviceBoundary } from '../unified-ir/runtime/bridge';

/**
 * Test-only numerical probe over a compiled circuit.
 *
 * The public `Circuit` exposes no pin, voltage, current, diagnostics or device
 * state readback after RFC 0017. Low-level solver suites still need the raw
 * snapshot, so they compile the netlist themselves and read it through the
 * compiler-owned refs. This module is not part of any package entry point.
 */

export interface TestProbeOptions {
  readonly engine?: 'jit' | 'reference';
  readonly electrical?: CircuitCompilationOptions;
}

export interface TestProbe {
  readonly compiled: CompiledCircuit;
  readonly storage: IRStorage;
  readonly boundary: DeviceBoundary;
  readonly tickCount: bigint;
  readonly virtualTime: number;
  step(dt?: number): void;
  runBatch(count: number, dt?: number): void;
  reset(): void;
  /** Declared device state as a JS scalar (`f32`/`f64` become numbers). */
  readState(deviceId: string, name: string): number | boolean;
  /** Direct storage write, used to seed inputs the IR reads. */
  writeState(deviceId: string, name: string, value: RuntimeScalar): void;
  /** Solved digital input level, as the removed `Circuit.getPin` reported it. */
  digital(pinName: string): boolean;
  /** Digital drive intent of one pin, as the removed accessor's `readPin` reported it. */
  driven(pinName: string): boolean;
  voltage(pinName: string): ElectricalReading;
  current(resource: string | ElectricalCurrentTarget): ElectricalReading;
  diagnostics(): readonly ElectricalDiagnostic[];
}

/** Engine instances stay isolated, so `reset()` can start from declared memory values. */
function createEngine(compiled: CompiledCircuit, engine: 'jit' | 'reference'): IRInterpreter {
  const options = { validation: compiled.validation, maxSteps: Number.MAX_SAFE_INTEGER };
  return engine === 'reference'
    ? createIRInterpreter(compiled.module, options)
    : createIRJIT(compiled.module, { ...options, jit: { tierUpThreshold: 0 } });
}

export function createTestProbe(
  input: CircuitCompilationInput,
  options: TestProbeOptions = {},
): TestProbe {
  const compiled = compileCircuit(input, { ...TEST_ELECTRICAL, ...options.electrical });
  const engine = options.engine ?? 'jit';
  const context = { instanceId: 'test-probe', virtualTime: 0 };
  let jit = createEngine(compiled, engine);
  const boundaryFor = (engineInstance: IRInterpreter): DeviceBoundary =>
    createDeviceBoundary({
      compiled,
      jit: engineInstance,
      execute: (entry, args) => engineInstance.execute(entry, args, context),
      assertActive: () => undefined,
    });
  let boundary = boundaryFor(jit);
  let tickCount = 0n;
  let virtualTime = 0;

  const setTimeStep = (dt: number): void => {
    if (!Number.isSafeInteger(dt) || dt <= 0)
      throw new CircuitError(
        'invalid-options',
        'Tick duration must be a positive safe integer in picoseconds',
      );
    const electrical = electricalCompilationOf(compiled);
    if (electrical === undefined) return;
    jit.storage.storeArray(electrical.operations.timeStep, 0, dt >>> 0);
    jit.storage.storeArray(electrical.operations.timeStep, 1, Math.floor(dt / 0x100000000));
  };

  const advance = (count: number, dt: number): void => {
    tickCount += BigInt(count);
    const elapsed = count * dt;
    const next = virtualTime + elapsed;
    virtualTime = Number.isSafeInteger(next)
      ? next
      : Number(
          (BigInt(virtualTime) + BigInt(count) * BigInt(dt)) %
            (BigInt(Number.MAX_SAFE_INTEGER) + 1n),
        );
  };

  const ensure = () => {
    const electrical = electricalCompilationOf(compiled);
    if (electrical === undefined)
      throw new CircuitError(
        'unsupported-operation',
        'This circuit has no resistive electrical model',
      );
    context.virtualTime = virtualTime;
    jit.execute(electrical.operations.ensure, [], context);
    return electrical;
  };

  jit.execute(compiled.entryPoints.refs.initialize, [], context);

  return {
    compiled,
    get storage() {
      return jit.storage;
    },
    get boundary() {
      return boundary;
    },
    get tickCount() {
      return tickCount;
    },
    get virtualTime() {
      return virtualTime;
    },
    step(dt = 1) {
      setTimeStep(dt);
      context.virtualTime = virtualTime;
      try {
        jit.execute(compiled.entryPoints.refs.tick, [], context);
      } finally {
        advance(Number(jit.storage.loadState(compiled.progress)), dt);
      }
    },
    runBatch(count, dt = 1) {
      setTimeStep(dt);
      if (count === 0) return;
      context.virtualTime = virtualTime;
      jit.storage.storeState(compiled.progress, 0);
      try {
        jit.execute(compiled.entryPoints.refs.batch, [count], context);
      } finally {
        advance(Number(jit.storage.loadState(compiled.progress)), dt);
      }
    },
    reset() {
      jit = createEngine(compiled, engine);
      boundary = boundaryFor(jit);
      tickCount = 0n;
      virtualTime = 0;
      context.virtualTime = 0;
      jit.execute(compiled.entryPoints.refs.initialize, [], context);
    },
    readState(deviceId, name) {
      const slot = compiled.states.devices.get(deviceId)?.get(name);
      if (slot === undefined) throw new Error(`Unknown state ${deviceId}.${name}`);
      const value = jit.storage.loadArray(slot.array, slot.index);
      if (value !== null && typeof value === 'object') return toNumber(value as FloatBits);
      return value as number | boolean;
    },
    writeState(deviceId, name, value) {
      const slot = compiled.states.devices.get(deviceId)?.get(name);
      if (slot === undefined) throw new Error(`Unknown state ${deviceId}.${name}`);
      jit.storage.storeArray(slot.array, slot.index, value);
    },
    digital(pinName) {
      const electrical = ensure();
      return electricalDigitalSample(
        electrical.allocation,
        electrical.operations,
        jit.storage,
        pinName,
      );
    },
    driven(pinName) {
      const electrical = ensure();
      const index = electrical.operations.pinIndices.get(pinName);
      if (index === undefined) throw new Error(`Unknown pin ${pinName}`);
      return jit.storage.loadArray(electrical.operations.digitalIntent, index) === true;
    },
    voltage(pinName) {
      const electrical = ensure();
      return electricalVoltage(
        electrical.allocation,
        electrical.operations.solver,
        jit.storage,
        pinName,
      );
    },
    current(resource) {
      const electrical = ensure();
      return electricalCurrent(
        electrical.allocation,
        electrical.operations.solver,
        jit.storage,
        resource,
      );
    },
    diagnostics() {
      const electrical = ensure();
      return electricalDiagnostics(
        electrical.allocation,
        electrical.operations.solver,
        jit.storage,
      );
    },
  };
}
