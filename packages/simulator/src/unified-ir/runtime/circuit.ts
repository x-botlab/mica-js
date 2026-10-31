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
import { electricalCompilationOf } from '../compiler/electrical-compilation';
import { createDeviceBoundary } from './bridge';
import type { DeviceBoundary } from './bridge';
import { CircuitError, type CircuitEngine, type CircuitRuntimeOptions } from './types';

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
  readonly sources: CircuitCompilationOptions['sources'];
  readonly interpretation: CircuitCompilationOptions['interpretation'];
  readonly floatingSeed: CircuitCompilationOptions['floatingSeed'];
  readonly instanceId: string;
}

/**
 * Host-facing runtime of one compiled unified circuit (U02).
 *
 * ```ts
 * const circuit = await Circuit.create({
 *   devices: [
 *     { id: 'drive1', type: 'push-pull-driver', description: driverDescription() },
 *     { id: 'sink1', type: 'lamp-sink', description: sinkDescription() },
 *   ],
 *   connections: [
 *     { from: 'drive1.PA0', to: 'sink1.anode' },
 *     { from: 'sink1.cathode', to: 'GND' },
 *   ],
 * });
 *
 * circuit.runBatch(1_000_000);                        // one engine call
 * expect(circuit.tickCount).toBe(1_000_000n);
 * circuit.reset();
 * circuit.step();
 * ```
 *
 * `Circuit` owns the engine instance, the tick counter and the private
 * step-boundary hook plumbing. RFC 0017 traffic belongs to the
 * `DeviceSimulationHost`: it delivers topic inputs before a step and publishes
 * the topic outputs the device hooks report afterwards. `Circuit` itself
 * exposes no device state, pin or electrical readback.
 *
 * The compiled module keeps every device, net and the main loop in one
 * `@mica-js/ir` module, so a batch is one interpreter/JIT call for the whole
 * circuit.
 */
export class Circuit {
  readonly #compiled: CompiledCircuit;
  readonly #jit: IRInterpreter;
  readonly #context: RuntimeContext;
  readonly #seeds: readonly ResetSeed[];
  #tickCount = 0n;
  #virtualTime = 0;
  #disposed = false;

  private constructor(
    compiled: CompiledCircuit,
    jit: IRInterpreter,
    instanceId: string,
    boundary: DeviceBoundary,
    seeds: readonly ResetSeed[],
  ) {
    this.#compiled = compiled;
    this.#jit = jit;
    this.#context = { instanceId, virtualTime: 0 };
    this.#seeds = seeds;
    boundaries.set(this, boundary);
  }

  /**
   * Compiles `input`, builds the engine instance and runs the generated
   * `initialize` entry once.
   *
   * @throws {UnifiedIRCompilerError} when the circuit cannot be compiled.
   * @throws {CircuitError} for invalid options.
   */
  static async create(
    input: CircuitCompilationInput,
    options: CircuitRuntimeOptions = {},
  ): Promise<Circuit> {
    const resolved = resolveOptions(options);
    const compiled = compileCircuit(input, compileOptionsOf(resolved));
    const jit = createEngine(compiled, resolved);
    const boundary = createDeviceBoundary({
      compiled,
      jit,
      execute: (entry, args) => {
        circuit.#context.virtualTime = circuit.#virtualTime;
        jit.execute(entry, args, circuit.#context);
      },
      assertActive: () => {
        circuit.#assertActive();
      },
    });
    const circuit = new Circuit(
      compiled,
      jit,
      resolved.instanceId,
      boundary,
      resetSeedsOf(compiled),
    );
    // `initialize` runs once at creation; `reset()` replays the same sequence
    // after restoring every memory to its declared initial value.
    jit.execute(compiled.entryPoints.refs.initialize, NO_ARGS, circuit.#context);
    return circuit;
  }

  /**
   * Runs `count` ticks inside one generated loop — the throughput path.
   *
   * The whole batch is one engine call. The clock advances by completed ticks,
   * including the completed prefix of a failed batch.
   *
   * @throws {CircuitError} with code `invalid-count` unless `count` is a u32.
   */
  runBatch(count: number, dt = 1): void {
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
    this.#setTimeStep(dt);
    if (count === 0) return;
    this.#context.virtualTime = this.#virtualTime;
    this.#jit.storage.storeState(this.#compiled.progress, 0);
    try {
      this.#jit.execute(this.#compiled.entryPoints.refs.batch, [count], this.#context);
    } finally {
      this.#advance(this.#jit.storage.loadState(this.#compiled.progress), dt);
    }
  }

  /**
   * Advances exactly one tick — the debugging path.
   *
   * Every call is one engine entry, so prefer `runBatch` for throughput.
   */
  step(dt = 1): void {
    this.#assertActive();
    this.#setTimeStep(dt);
    this.#context.virtualTime = this.#virtualTime;
    try {
      this.#jit.execute(this.#compiled.entryPoints.refs.tick, NO_ARGS, this.#context);
    } finally {
      this.#advance(this.#jit.storage.loadState(this.#compiled.progress), dt);
    }
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

  /** Number of ticks completed since creation or the last `reset()`. */
  get tickCount(): bigint {
    this.#assertActive();
    return this.#tickCount;
  }

  /** Virtual tick time completed since creation or the last `reset()`. */
  get virtualTime(): number {
    this.#assertActive();
    return this.#virtualTime;
  }

  /** Whether `dispose()` already ran. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Releases the runtime. Idempotent; every later call throws a `CircuitError`
   * with code `disposed`.
   */
  dispose(): void {
    this.#disposed = true;
    this.#tickCount = 0n;
    this.#virtualTime = 0;
  }

  /** @internal Shared guard of the circuit and its boundary hooks. */
  #assertActive(): void {
    if (this.#disposed) {
      throw new CircuitError(
        'disposed',
        'Circuit has been disposed; create a new circuit to keep simulating',
      );
    }
  }

  #setTimeStep(dt: number): void {
    if (!Number.isSafeInteger(dt) || dt <= 0)
      throw new CircuitError(
        'invalid-options',
        'Tick duration must be a positive safe integer in picoseconds',
      );
    const electrical = electricalCompilationOf(this.#compiled);
    if (electrical !== undefined) {
      this.#jit.storage.storeArray(electrical.operations.timeStep, 0, dt >>> 0);
      this.#jit.storage.storeArray(electrical.operations.timeStep, 1, Math.floor(dt / 0x100000000));
    }
  }

  #advance(count: number, dt: number): void {
    this.#tickCount += BigInt(count);
    const elapsed = count * dt;
    const next = this.#virtualTime + elapsed;
    this.#virtualTime = Number.isSafeInteger(next)
      ? next
      : Number(
          (BigInt(this.#virtualTime) + BigInt(count) * BigInt(dt)) %
            (BigInt(MAX_VIRTUAL_TIME) + 1n),
        );
  }
}

const boundaries = new WeakMap<Circuit, DeviceBoundary>();

/**
 * Step-boundary hooks of one circuit.
 *
 * The device simulation host is the only package-level caller: RFC 0017 traffic
 * enters through `applyInputs` and leaves through `flushOutputs`, never through
 * a device accessor. This function is deliberately absent from the package
 * entry points.
 */
export function deviceBoundaryOf(circuit: Circuit): DeviceBoundary {
  const boundary = boundaries.get(circuit);
  if (boundary === undefined)
    throw new CircuitError(
      'invalid-options',
      'Argument must be a Circuit created by Circuit.create',
    );
  return boundary;
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
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    ...(options.interpretation === undefined ? {} : { interpretation: options.interpretation }),
    ...(options.floatingSeed === undefined ? {} : { floatingSeed: options.floatingSeed }),
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

  if (candidate.electrical !== undefined) {
    const electrical = candidate.electrical;
    if (electrical === null || typeof electrical !== 'object' || Array.isArray(electrical)) {
      throw new CircuitError('invalid-options', 'electrical must be a plain object');
    }
    if ('rails' in electrical)
      throw new CircuitError(
        'invalid-options',
        'Boolean rails are unsupported; declare explicit voltage sources',
      );
  }

  return Object.freeze({
    engine,
    jit: candidate.jit,
    validateIR: candidate.validateIR ?? true,
    sources: candidate.electrical?.sources,
    interpretation: candidate.electrical?.interpretation,
    floatingSeed: candidate.electrical?.floatingSeed,
    instanceId: candidate.instanceId ?? DEFAULT_INSTANCE_ID,
  });
}
