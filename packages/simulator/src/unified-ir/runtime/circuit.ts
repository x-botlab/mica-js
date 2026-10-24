import { createIRInterpreter, createIRJIT } from '@mica-js/ir';
import type {
  ArrayRef,
  BytesRef,
  IRInterpreter,
  IRJITTuning,
  RuntimeScalar,
  StateRef,
} from '@mica-js/ir';
import { compileCircuit } from '../compiler';
import type {
  CircuitCompilationInput,
  CircuitCompilationOptions,
  CompiledCircuit,
} from '../compiler';
import { PIN_MODE } from '../pin-space';
import { buildDeviceAccessors } from './accessors';
import {
  CircuitError,
  type CircuitEngine,
  type CircuitRuntimeOptions,
  type DeviceAccessorsOf,
} from './types';

/** Every generated entry takes no arguments, so one frozen array is reused. */
const NO_ARGS: readonly RuntimeScalar[] = Object.freeze([]);

/** `unified_tick_batch` takes a u32 tick count. */
const MAX_BATCH_TICKS = 0xffff_ffff;

/** Virtual time is a JS number, so it wraps before losing integer precision. */
const MAX_VIRTUAL_TIME = Number.MAX_SAFE_INTEGER;

const DEFAULT_INSTANCE_ID = 'unified-circuit';

/**
 * Mutable execution context. `IRExecutionContext` is readonly for callers; the
 * runtime owns this object and updates `virtualTime` in place so that `step()`
 * allocates nothing on the hot path.
 */
interface RuntimeContext {
  instanceId: string;
  virtualTime: number;
}

/** One pin of the global address space, resolved at construction time. */
interface PinRuntime {
  readonly globalPinId: number;
  readonly role: 'driver' | 'load';
  /** Whether the device reads the solved level of this pin. */
  readonly senses: boolean;
}

/** Declared initial value of one memory resource, replayed by `reset()`. */
type ResetSeed =
  | { readonly kind: 'array'; readonly ref: ArrayRef; readonly values: readonly RuntimeScalar[] }
  | { readonly kind: 'state'; readonly ref: StateRef; readonly value: RuntimeScalar }
  | {
      readonly kind: 'bytes';
      readonly ref: BytesRef<false>;
      readonly values: readonly RuntimeScalar[];
    }
  | {
      readonly kind: 'readonly-bytes';
      readonly ref: BytesRef<true>;
      readonly values: Uint8Array;
    };

interface ResolvedRuntimeOptions {
  readonly engine: CircuitEngine;
  readonly jit: IRJITTuning | undefined;
  readonly validateIR: boolean;
  readonly allowMultiDriver: boolean;
  readonly rails: Readonly<Record<string, boolean>> | undefined;
  readonly instanceId: string;
}

/**
 * Host-facing runtime of one compiled unified circuit (U02).
 *
 * ```ts
 * const circuit = await Circuit.create({
 *   devices: [
 *     { id: 'mcu1', type: 'teaching-mcu', description: createMcuDescription() },
 *     { id: 'led1', type: 'ideal-led', description: createLedDescription() },
 *   ],
 *   connections: [
 *     { from: 'mcu1.PA0', to: 'led1.anode' },
 *     { from: 'led1.cathode', to: 'GND' },
 *   ],
 * });
 *
 * circuit.runBatch(1_000_000);                        // one engine call
 * expect(circuit.tickCount).toBe(1_000_000n);
 *
 * circuit.reset();
 * circuit.setPin('mcu1.PA0', true);                   // host drives the pin
 * circuit.step();
 * expect(circuit.devices.led1.isOn()).toBe(true);
 * ```
 *
 * `Circuit` owns the engine instance and the tick counter; the compiled module
 * keeps every device, net and the main loop in one `@mica-js/ir` module, so a
 * batch is one interpreter/JIT call for the whole circuit.
 */
export class Circuit<I extends CircuitCompilationInput = CircuitCompilationInput> {
  /** Typed per-device accessors, keyed by device id. */
  readonly devices: DeviceAccessorsOf<I>;

  readonly #compiled: CompiledCircuit;
  readonly #jit: IRInterpreter;
  readonly #context: RuntimeContext;
  readonly #pins: ReadonlyMap<string, PinRuntime>;
  readonly #pinNames: readonly string[];
  readonly #seeds: readonly ResetSeed[];
  #tickCount = 0n;
  #virtualTime = 0;
  #disposed = false;

  private constructor(
    compiled: CompiledCircuit,
    jit: IRInterpreter,
    instanceId: string,
    accessors: DeviceAccessorsOf<I>,
    pins: ReadonlyMap<string, PinRuntime>,
    seeds: readonly ResetSeed[],
  ) {
    this.#compiled = compiled;
    this.#jit = jit;
    this.#context = { instanceId, virtualTime: 0 };
    this.devices = accessors;
    this.#pins = pins;
    this.#pinNames = Object.freeze([...pins.keys()]);
    this.#seeds = seeds;
  }

  /**
   * Compiles `input`, builds the engine instance and runs the generated
   * `initialize` entry once.
   *
   * The input is inferred as a `const` type, so a literal device list keeps its
   * ids and types and `circuit.devices.<id>` exposes the matching accessor.
   *
   * @throws {UnifiedIRCompilerError} when the circuit cannot be compiled.
   * @throws {CircuitError} for invalid options.
   */
  static async create<const I extends CircuitCompilationInput>(
    input: I,
    options: CircuitRuntimeOptions = {},
  ): Promise<Circuit<I>> {
    const resolved = resolveOptions(options);
    const compiled = compileCircuit(input, compileOptionsOf(resolved));
    const jit = createEngine(compiled, resolved);
    // The accessor factories run inside `buildDeviceAccessors`, which happens
    // before `circuit` is assigned. They only close over this holder; the
    // callbacks are invoked after construction.
    const host: { circuit: Circuit<I> | undefined } = { circuit: undefined };
    const circuit = new Circuit<I>(
      compiled,
      jit,
      resolved.instanceId,
      buildDeviceAccessors({
        compiled,
        jit,
        assertActive: () => {
          circuit.#assertActive();
        },
        step: () => {
          host.circuit?.step();
        },
        runBatch: (count) => {
          host.circuit?.runBatch(count);
        },
      }) as DeviceAccessorsOf<I>,
      pinRuntimeOf(compiled),
      resetSeedsOf(compiled),
    );
    host.circuit = circuit;
    // `initialize` runs once at creation; `reset()` replays the same sequence
    // after restoring every memory to its declared initial value.
    jit.execute(compiled.entryPoints.refs.initialize, NO_ARGS, circuit.#context);
    return circuit;
  }

  /**
   * Runs `count` ticks inside one generated loop — the throughput path.
   *
   * The whole batch is one engine call; `tickCount` grows by `count` once the
   * call returns, so a failed batch never advances the clock.
   *
   * @throws {CircuitError} with code `invalid-count` unless `count` is a u32.
   */
  runBatch(count: number): void {
    this.#assertActive();
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > MAX_BATCH_TICKS
    ) {
      throw new CircuitError(
        'invalid-count',
        `runBatch(count) needs an integer in [0, ${MAX_BATCH_TICKS}], received ${String(count)}`,
      );
    }
    if (count === 0) return;
    this.#context.virtualTime = this.#virtualTime;
    this.#jit.execute(this.#compiled.entryPoints.refs.batch, [count], this.#context);
    this.#advance(count);
  }

  /**
   * Advances exactly one tick — the debugging path.
   *
   * Every call is one engine entry, so prefer `runBatch` for throughput.
   */
  step(): void {
    this.#assertActive();
    this.#context.virtualTime = this.#virtualTime;
    this.#jit.execute(this.#compiled.entryPoints.refs.tick, NO_ARGS, this.#context);
    this.#advance(1);
  }

  /**
   * Restores every memory to its declared initial value, re-runs `initialize`
   * and resets `tickCount` to `0n`.
   *
   * Device state written by earlier ticks is discarded, so the circuit behaves
   * exactly like a freshly created one.
   */
  reset(): void {
    this.#assertActive();
    for (const seed of this.#seeds) {
      if (seed.kind === 'state') {
        this.#jit.storage.storeState(seed.ref, seed.value);
        continue;
      }
      if (seed.kind === 'bytes') {
        for (let index = 0; index < seed.values.length; index += 1) {
          this.#jit.storage.storeBytes(
            'u8',
            'little',
            seed.ref,
            index,
            seed.values[index] as RuntimeScalar,
          );
        }
        continue;
      }
      if (seed.kind === 'readonly-bytes') {
        try {
          this.#jit.storage.updateBytesFromBytes(seed.ref, 0, seed.values);
        } catch {
          // Read-only memories are constants unless their device explicitly
          // grants host update access (for example MCU firmware patching).
        }
        continue;
      }
      for (let index = 0; index < seed.values.length; index += 1) {
        this.#jit.storage.storeArray(seed.ref, index, seed.values[index] as RuntimeScalar);
      }
    }
    this.#tickCount = 0n;
    this.#virtualTime = 0;
    this.#context.virtualTime = 0;
    this.#jit.execute(this.#compiled.entryPoints.refs.initialize, NO_ARGS, this.#context);
  }

  /**
   * Reads the level one pin observes.
   *
   * A sensing pin (input, passive or bidirectional) reports the solved net
   * level; a pure driver pin reports the level it actually drives, which is
   * `false` unless it is configured push-pull.
   *
   * @throws {CircuitError} with code `pin-not-found`.
   */
  getPin(pinName: string): boolean {
    this.#assertActive();
    const pin = this.#pinRuntime(pinName);
    const storage = this.#jit.storage;
    if (pin.senses) {
      return storage.loadArray(this.#compiled.memory.input, pin.globalPinId) === true;
    }
    const mode = Number(storage.loadArray(this.#compiled.memory.mode, pin.globalPinId));
    return (
      mode === PIN_MODE.pushPull &&
      storage.loadArray(this.#compiled.memory.output, pin.globalPinId) === true
    );
  }

  /**
   * Forces the level of one pin from the host.
   *
   * A driver pin gets its output latch written, so the level survives the next
   * electrical solve. A sensing pin gets the solved-value slot overridden, which
   * lasts until the next tick recomputes its net.
   *
   * @throws {CircuitError} with code `pin-not-found`.
   */
  setPin(pinName: string, value: boolean): void {
    this.#assertActive();
    const pin = this.#pinRuntime(pinName);
    if (typeof value !== 'boolean') {
      throw new CircuitError(
        'invalid-state-value',
        `Pin "${pinName}" needs a boolean level, received ${typeof value}`,
        { pinName },
      );
    }
    const target =
      pin.role === 'driver' ? this.#compiled.memory.output : this.#compiled.memory.input;
    this.#jit.storage.storeArray(target, pin.globalPinId, value);
  }

  /** Number of ticks completed since creation or the last `reset()`. */
  get tickCount(): bigint {
    this.#assertActive();
    return this.#tickCount;
  }

  /** Underlying engine instance, e.g. for diagnostics or custom entries. */
  get jit(): IRInterpreter {
    this.#assertActive();
    return this.#jit;
  }

  /** Whether `dispose()` already ran. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Releases the runtime. Idempotent; every later call throws a `CircuitError`
   * with code `disposed`, including stale device accessors.
   */
  dispose(): void {
    this.#disposed = true;
    this.#tickCount = 0n;
    this.#virtualTime = 0;
  }

  /** @internal Shared guard of the circuit and all of its accessors. */
  #assertActive(): void {
    if (this.#disposed) {
      throw new CircuitError(
        'disposed',
        'Circuit has been disposed; create a new circuit to keep simulating',
      );
    }
  }

  #advance(count: number): void {
    this.#tickCount += BigInt(count);
    const next = this.#virtualTime + count;
    this.#virtualTime = next > MAX_VIRTUAL_TIME ? 0 : next;
  }

  #pinRuntime(pinName: string): PinRuntime {
    const pin = this.#pins.get(pinName);
    if (pin === undefined) {
      throw new CircuitError(
        'pin-not-found',
        `Pin "${pinName}" not found. Available: ${this.#pinNames.length === 0 ? '(none)' : `[${this.#pinNames.join(', ')}]`}`,
        { pinName },
      );
    }
    return pin;
  }
}

/** Resolves every pin of the global address space into its runtime view. */
function pinRuntimeOf(compiled: CompiledCircuit): ReadonlyMap<string, PinRuntime> {
  const pins = new Map<string, PinRuntime>();
  for (const [deviceId, allocation] of compiled.pins.devices) {
    for (const [pinName, pin] of allocation.resolved) {
      pins.set(
        `${deviceId}.${pinName}`,
        Object.freeze({
          globalPinId: pin.globalPinId,
          role: pin.role,
          senses: pin.senses,
        }),
      );
    }
  }
  return pins;
}

/**
 * Captures the declared initial value of every scalar memory, which is what
 * `reset()` restores before the generated `initialize` runs again.
 */
function resetSeedsOf(compiled: CompiledCircuit): readonly ResetSeed[] {
  const seeds: ResetSeed[] = [];
  for (const memory of compiled.module.memories) {
    if (memory.kind === 'array') {
      seeds.push({
        kind: 'array',
        ref: memory.ref as ArrayRef,
        values: memory.initial as readonly RuntimeScalar[],
      });
    } else if (memory.kind === 'state') {
      seeds.push({
        kind: 'state',
        ref: memory.ref as StateRef,
        value: memory.initial[0] as RuntimeScalar,
      });
    } else if (memory.kind === 'bytes') {
      if (memory.writable) {
        seeds.push({
          kind: 'bytes',
          ref: memory.ref as BytesRef<false>,
          values: memory.initial as readonly RuntimeScalar[],
        });
      } else {
        seeds.push({
          kind: 'readonly-bytes',
          ref: memory.ref as BytesRef<true>,
          values: Uint8Array.from(memory.initial as readonly number[]),
        });
      }
    }
  }
  return Object.freeze(seeds);
}

function createEngine(compiled: CompiledCircuit, options: ResolvedRuntimeOptions): IRInterpreter {
  const base = {
    validation: compiled.validation,
    // One batch can execute hundreds of millions of instructions; the default
    // step budget is tuned for single entries, not for a loop in the IR.
    maxSteps: Number.MAX_SAFE_INTEGER,
  };
  if (options.engine === 'reference') {
    return createIRInterpreter(compiled.module, base);
  }
  return createIRJIT(compiled.module, {
    ...base,
    jit: { tierUpThreshold: 0, ...options.jit },
  });
}

function compileOptionsOf(options: ResolvedRuntimeOptions): CircuitCompilationOptions {
  return {
    validate: options.validateIR,
    allowMultiDriver: options.allowMultiDriver,
    ...(options.rails === undefined ? {} : { rails: options.rails }),
  };
}

function resolveOptions(options: unknown): ResolvedRuntimeOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new CircuitError('invalid-options', 'Circuit options must be a plain object');
  }
  const candidate = options as CircuitRuntimeOptions;

  const engine = candidate.engine ?? 'jit';
  if (engine !== 'jit' && engine !== 'reference') {
    throw new CircuitError(
      'invalid-options',
      `engine=${String(engine)} must be "jit" or "reference"`,
    );
  }

  if (candidate.validateIR !== undefined && typeof candidate.validateIR !== 'boolean') {
    throw new CircuitError('invalid-options', 'validateIR must be a boolean');
  }

  if (candidate.instanceId !== undefined && candidate.instanceId.length === 0) {
    throw new CircuitError('invalid-options', 'instanceId must be a non-empty string');
  }

  if (candidate.jit !== undefined) {
    if (
      candidate.jit === null ||
      typeof candidate.jit !== 'object' ||
      Array.isArray(candidate.jit)
    ) {
      throw new CircuitError('invalid-options', 'jit must be a JIT tuning object');
    }
  }

  let allowMultiDriver = false;
  let rails: Readonly<Record<string, boolean>> | undefined;
  if (candidate.electrical !== undefined) {
    const electrical = candidate.electrical;
    if (electrical === null || typeof electrical !== 'object' || Array.isArray(electrical)) {
      throw new CircuitError('invalid-options', 'electrical must be a plain object');
    }
    if (electrical.allowMultiDriver !== undefined) {
      if (typeof electrical.allowMultiDriver !== 'boolean') {
        throw new CircuitError('invalid-options', 'electrical.allowMultiDriver must be a boolean');
      }
      allowMultiDriver = electrical.allowMultiDriver;
    }
    rails = electrical.rails;
  }

  return Object.freeze({
    engine,
    jit: candidate.jit,
    validateIR: candidate.validateIR ?? true,
    allowMultiDriver,
    rails,
    instanceId: candidate.instanceId ?? DEFAULT_INSTANCE_ID,
  });
}
