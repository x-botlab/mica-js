import { MAX_TIME_PS, timePs as brandedTimePs } from '@mica-js/core';
import type { TimePs } from '@mica-js/core';
import { createIRInterpreter, createIRJIT } from '@mica-js/ir';
import type {
  ArrayRef,
  BytesRef,
  EntryRef,
  IRInterpreter,
  IRJITTuning,
  OutputRef,
  RuntimeScalar,
  StateRef,
} from '@mica-js/ir';
import type { TopicPayload } from '@mica-js/device';
import type { DevicePublish } from '../../types';
import { compileCircuit } from '../compiler';
import type {
  CircuitCompilationInput,
  CircuitCompilationOptions,
  CompiledCircuit,
  DevicePowerDomainSlot,
  DeviceMetadata,
} from '../compiler';
import { ELECTRICAL_FAULT, PIN_MODE } from '../pin-space';
import { buildDeviceAccessors } from './accessors';
import { fromIRArgs, scalarToNumber, toIRArgs } from './topic-payload';
import {
  CircuitError,
  type CircuitEngine,
  type CircuitRuntimeOptions,
  type CircuitTopic,
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

/**
 * Mutable sink the engine's captured bridge host forwards to.
 *
 * The engine records its host callbacks once, at creation, before the circuit
 * exists; assigning `emit` after construction keeps both sides stable.
 */
interface BridgeSink {
  emit:
    | ((output: OutputRef, payload: readonly (boolean | number)[], timePs: number) => void)
    | undefined;
}

/** One pin of the global address space, resolved at construction time. */
interface PinRuntime {
  readonly globalPinId: number;
  readonly role: 'driver' | 'load';
  /** Whether the device reads the solved level of this pin. */
  readonly senses: boolean;
  /** Index of the power domain gating this pin, or `undefined` when unbound. */
  readonly domain: number | undefined;
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
  readonly supplyVoltage: number | undefined;
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

  /** Topic endpoints of the compiled devices, in declaration order. */
  readonly topics: readonly CircuitTopic[];

  /**
   * RFC 0002 §4.5 topology seed of the floating sampler.
   *
   * Two circuits with the same netlist share the seed — and therefore the same
   * floating sequence — while a different topology gets a different one.
   * `reset()` keeps it, so replaying a circuit reproduces its run exactly.
   */
  readonly floatingSeed: number;

  readonly #compiled: CompiledCircuit;
  readonly #jit: IRInterpreter;
  readonly #context: RuntimeContext;
  readonly #pins: ReadonlyMap<string, PinRuntime>;
  readonly #pinNames: readonly string[];
  readonly #seeds: readonly ResetSeed[];
  readonly #topicInputs: ReadonlyMap<string, EntryRef>;
  readonly #topicOutputs: ReadonlyMap<string, OutputRef>;
  readonly #topicByOutput: ReadonlyMap<OutputRef, CircuitTopic>;
  readonly #topicByKey: ReadonlyMap<string, CircuitTopic>;
  /** Declared power domains per device; empty when the circuit declares none. */
  readonly #powerDomains: ReadonlyMap<string, ReadonlyMap<string, DevicePowerDomainSlot>>;
  /** `power_ready` array; `undefined` when the circuit declares no domains. */
  readonly #powerReady: ArrayRef<'bool'> | undefined;
  /** `electrical_fault` slot (RFC 0002 §4.4); `undefined` on legacy memories. */
  readonly #faults: ArrayRef<'u8'> | undefined;
  /** Bridge sink; the engine holds the same object for its whole lifetime. */
  readonly #bridge: BridgeSink;
  readonly #publishListeners = new Set<(publish: DevicePublish) => void>();
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
    bridge: BridgeSink,
  ) {
    this.#compiled = compiled;
    this.#jit = jit;
    this.#bridge = bridge;
    this.#context = { instanceId, virtualTime: 0 };
    this.devices = accessors;
    this.#pins = pins;
    this.#pinNames = Object.freeze([...pins.keys()]);
    this.#seeds = seeds;
    this.#powerDomains = compiled.powerDomains.devices;
    this.#powerReady = compiled.memory.powerReady;
    this.#faults = compiled.memory.electricalFault;
    this.floatingSeed = compiled.floating.seed;
    const topicByKey = new Map<string, CircuitTopic>();
    for (const port of compiled.topics.ports) {
      topicByKey.set(
        port.key,
        Object.freeze({
          deviceId: port.deviceId,
          port: port.port,
          direction: port.direction,
          type: port.type,
          ...(port.title === undefined ? {} : { title: port.title }),
        }),
      );
    }
    this.#topicByKey = topicByKey;
    this.topics = Object.freeze([...topicByKey.values()]);
    const inputs = new Map<string, EntryRef>();
    const outputs = new Map<string, OutputRef>();
    const byOutput = new Map<OutputRef, CircuitTopic>();
    for (const port of compiled.topics.ports) {
      const topic = topicByKey.get(port.key);
      if (topic === undefined) continue;
      if (port.entry !== undefined) inputs.set(port.key, port.entry);
      if (port.output !== undefined) {
        outputs.set(port.key, port.output);
        byOutput.set(port.output, topic);
      }
    }
    this.#topicInputs = inputs;
    this.#topicOutputs = outputs;
    this.#topicByOutput = byOutput;
    // The engine captured its bridge host at construction; the sink keeps the
    // callbacks stable while the circuit (which they need) is still being built.
    this.#bridge.emit = (output, payload, timePs) => {
      this.#publish(output, payload, timePs);
    };
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
    // The engine captures its bridge host once; the sink lets the circuit fill
    // the callback after construction so publishes can reach its listeners.
    const bridge: BridgeSink = { emit: undefined };
    const jit = createEngine(compiled, resolved, bridge);
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
      bridge,
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
    this.#assertNoElectricalConflict();
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
    this.#assertNoElectricalConflict();
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
    // RFC 0007: an unpowered domain samples the determinate level 0, whatever
    // the net solves to and whatever the driver's latch still holds.
    if (pin.domain !== undefined && !this.#domainReady(pin.domain)) return false;
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

  /**
   * Powers one declared domain of a device (RFC 0007).
   *
   * The slot becomes `true` immediately, so {@link isPowered} and every gated
   * pin read see it at once. The electrical solve that turns the domain's
   * drivers back on runs on the next `step()`/`runBatch()`; a driver that was
   * released while the domain was off resumes driving with its retained latch,
   * and a device's `tick`/`update` phases resume with it.
   *
   * ```ts
   * circuit.turnOn('MCU1', 'vdd');
   * circuit.step();
   * expect(circuit.getPin('MCU1.PA0')).toBe(true);
   * ```
   *
   * @throws {CircuitError} with code `no-power-domains` when the device declares
   *   none, and `power-domain-not-found` when it declares no such domain.
   */
  turnOn(symbol: string, domain: string): void {
    this.#assertActive();
    this.#storePower(symbol, domain, true);
  }

  /**
   * Removes power from one declared domain of a device (RFC 0007).
   *
   * While the domain is off its pins are released (a driver stops holding its
   * net), gated sampling reads `0`, and the device's own `tick`/`update` phases
   * are skipped. Pin configuration and output latches are retained, so
   * {@link turnOn} restores the previous intent.
   *
   * @throws {CircuitError} with code `no-power-domains` when the device declares
   *   none, and `power-domain-not-found` when it declares no such domain.
   */
  turnOff(symbol: string, domain: string): void {
    this.#assertActive();
    this.#storePower(symbol, domain, false);
  }

  /**
   * Reports whether one declared domain of a device is powered (RFC 0007).
   *
   * A device that declares no power domain is always powered, so a circuit
   * without domains reports `true` for every device/domain pair.
   *
   * @throws {CircuitError} with code `power-domain-not-found` when the device
   *   declares domains but not the requested one.
   */
  isPowered(symbol: string, domain: string): boolean {
    this.#assertActive();
    const declared = this.#powerDomains.get(symbol);
    if (declared === undefined || declared.size === 0) return true;
    const slot = declared.get(domain);
    if (slot === undefined) {
      throw new CircuitError(
        'power-domain-not-found',
        `Power domain ${symbol}.${domain} not found. Available: ${describeNames(declared.keys())}`,
        { deviceId: symbol, domainName: domain },
      );
    }
    return this.#domainReady(slot.index);
  }

  /**
   * Samples the digital level of one declared pin — the probe surface a host
   * uses to build an oscilloscope-like table.
   *
   * The reading is the same one {@link getPin} returns (sensing pins report the
   * solved net level, driver pins report the level they actually drive), keyed
   * by device id and pin name instead of a `'device.pin'` endpoint. `ready` is
   * `true` for every successful read: the compiled circuit always owns an
   * electrical model, so a returned level is a real measurement rather than a
   * stale or defaulted value.
   *
   * ```ts
   * circuit.step();
   * expect(circuit.samplePin('led1', 'anode')).toEqual({ value: 1, ready: true });
   * ```
   *
   * @throws {CircuitError} with code `device-not-found` when `symbol` is not a
   *   compiled device, and `pin-not-found` when it declares no such pin.
   */
  samplePin(symbol: string, pin: string): { value: 0 | 1; ready: boolean } {
    this.#assertActive();
    const endpoint = this.#requirePin(symbol, pin);
    return { value: this.getPin(endpoint) ? 1 : 0, ready: true };
  }

  /**
   * Samples the solved voltage of one declared pin — the analog half of the
   * probe surface (RFC 0002 §5).
   *
   * The reading is the node voltage the last electrical solve arbitrated, in
   * volts: a push-pull pin reports its domain supply while high and 0 while
   * low, a pull-up reports the biased level, an analog driver its intent, and a
   * floating node 0 V. A pin of an unpowered domain reports 0 V, matching
   * {@link getPin}.
   *
   * ```ts
   * circuit.step();
   * expect(circuit.samplePinVoltage('sensor1', 'out')).toBeCloseTo(2.5);
   * ```
   *
   * @throws {CircuitError} with code `device-not-found` when `symbol` is not a
   *   compiled device, and `pin-not-found` when it declares no such pin.
   */
  samplePinVoltage(symbol: string, pin: string): number {
    this.#assertActive();
    const endpoint = this.#requirePin(symbol, pin);
    const runtime = this.#pinRuntime(endpoint);
    // RFC 0007: an unpowered domain samples 0 V, whatever the net solves to.
    if (runtime.domain !== undefined && !this.#domainReady(runtime.domain)) return 0;
    const voltage = this.#compiled.memory.voltage;
    if (voltage === undefined) return 0;
    return scalarToNumber(this.#jit.storage.loadArray(voltage, runtime.globalPinId));
  }

  /**
   * Whether the last electrical solve latched an RFC 0002 §4.4 conflict.
   *
   * A conflict means two strong drivers of one node disagree by more than
   * 0.001 V. The main loop pauses immediately after the solve, so no device
   * updates on a poisoned network; `step()`/`runBatch()` then throw a
   * `CircuitError` with code `electrical-conflict` until the fault is cleared.
   */
  get electricalFault(): boolean {
    this.#assertActive();
    const faults = this.#faults;
    return faults !== undefined && this.#jit.storage.loadArray(faults, 0) !== ELECTRICAL_FAULT.none;
  }

  /**
   * Clears a latched conflict so the next step runs again.
   *
   * The drivers themselves are unchanged, so a still-conflicting circuit
   * latches the fault again on the next solve; fix the drive levels or
   * `reset()` the circuit instead.
   */
  clearElectricalFault(): void {
    this.#assertActive();
    const faults = this.#faults;
    if (faults !== undefined) {
      this.#jit.storage.storeArray(faults, 0, ELECTRICAL_FAULT.none);
    }
  }

  /**
   * Samples the switch state of one declared device connection.
   *
   * Reads the `connection_states` slot the domain lowering writes whenever the
   * device applies a `connection.apply` patch, so the answer always matches the
   * electrical solve of the last tick rather than a host-side guess.
   *
   * ```ts
   * circuit.devices.sw1.press();
   * circuit.step();
   * expect(circuit.sampleConnection('sw1', 'contact')).toEqual({ state: 'closed', ready: true });
   * ```
   *
   * @throws {CircuitError} with code `device-not-found` when `symbol` is not a
   *   compiled device, and `connection-not-found` when it declares no such
   *   connection.
   */
  sampleConnection(
    symbol: string,
    connection: string,
  ): { state: 'open' | 'closed'; ready: boolean } {
    this.#assertActive();
    this.#requireDevice(symbol);
    const slot = this.#compiled.connections.devices.get(symbol)?.get(connection);
    const states = this.#compiled.memory.connectionStates;
    if (slot === undefined || states === undefined) {
      throw new CircuitError(
        'connection-not-found',
        `Connection ${symbol}.${connection} not found. Available: ${this.#connectionList(symbol)}`,
        { deviceId: symbol },
      );
    }
    const closed = this.#jit.storage.loadArray(states, slot.index) === true;
    return { state: closed ? 'closed' : 'open', ready: true };
  }

  /**
   * Delivers one payload to the input endpoint of `symbol`'s `port`.
   *
   * The entry runs immediately, inside this call, with the circuit's current
   * virtual time — the same synchronous hop the scheduler path gives a topic
   * message. `<symbol>.<port>` must name an `input` port of the compiled
   * circuit.
   *
   * @throws {CircuitError} with code `topic-not-found` for an unknown or output
   *   port, and `invalid-topic-payload` when the payload does not match the
   *   port's declared type.
   */
  deliverTopic(symbol: string, port: string, payload: TopicPayload): void {
    this.#assertActive();
    const key = `${symbol}.${port}`;
    const entry = this.#topicInputs.get(key);
    const topic = this.#topicByKey.get(key);
    if (entry === undefined || topic === undefined || topic.direction !== 'input') {
      const available = this.topics
        .filter((candidate) => candidate.direction === 'input')
        .map((candidate) => `${candidate.deviceId}.${candidate.port}`);
      const detail = this.#topicOutputs.has(key)
        ? 'is an output topic port, not an input'
        : 'is not an input topic port';
      throw new CircuitError(
        'topic-not-found',
        `"${key}" ${detail}. Available: [${available.join(', ')}]`,
        { deviceId: symbol },
      );
    }
    const args = toIRArgs(payload, topic.type);
    this.#context.virtualTime = this.#virtualTime;
    this.#jit.execute(entry, args, this.#context);
  }

  /**
   * Subscribes to the payloads devices publish; returns the unsubscribe
   * function.
   *
   * A listener runs synchronously inside the tick that emitted the payload, so
   * it must not throw: an exception is swallowed so one bad host callback
   * cannot fail a batch. The reported `simTime` is the virtual time the batch
   * started at — a batch is one engine call, so the bridge observes one time
   * stamp per batch, while `tickCount` stays exact after the call returns.
   */
  onPublish(listener: (publish: DevicePublish) => void): () => void {
    if (this.#disposed) return () => {};
    this.#publishListeners.add(listener);
    return () => {
      this.#publishListeners.delete(listener);
    };
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
    this.#bridge.emit = undefined;
    this.#publishListeners.clear();
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

  /**
   * Starts the tick clock only when the solve produced a consistent network.
   *
   * The generated main loop already returned before any device update, so this
   * only surfaces the pause to the host.
   */
  #assertNoElectricalConflict(): void {
    const faults = this.#faults;
    if (faults === undefined) return;
    if (this.#jit.storage.loadArray(faults, 0) === ELECTRICAL_FAULT.none) return;
    throw new CircuitError(
      'electrical-conflict',
      'electrical conflict: two drivers hold one net at voltages that differ by more than 0.001 V; the simulation is paused until clearElectricalFault() or reset()',
    );
  }

  #advance(count: number): void {
    this.#tickCount += BigInt(count);
    const next = this.#virtualTime + count;
    this.#virtualTime = next > MAX_VIRTUAL_TIME ? 0 : next;
  }

  /** Forwards one `bridge.send` to every publish listener. */
  #publish(output: OutputRef, payload: readonly (boolean | number)[], timePs: number): void {
    const topic = this.#topicByOutput.get(output);
    if (topic === undefined || this.#disposed) return;
    let decoded: TopicPayload;
    try {
      decoded = fromIRArgs(payload, topic.type);
    } catch {
      // A device wrote scalars that do not decode as its declared payload
      // type; dropping the publish keeps the tick (and the remaining
      // listeners) alive.
      return;
    }
    const publish: DevicePublish = Object.freeze({
      target: Object.freeze({ symbol: topic.deviceId, port: topic.port }),
      payload: decoded,
      simTime: toTimePs(timePs),
    });
    for (const listener of [...this.#publishListeners]) {
      try {
        listener(publish);
      } catch {
        // Host callbacks are isolated from the simulation loop.
      }
    }
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

  /** Reads one `power_ready` slot; unbound circuits are always powered. */
  #domainReady(index: number): boolean {
    const ready = this.#powerReady;
    return ready === undefined ? true : this.#jit.storage.loadArray(ready, index) === true;
  }

  /** Writes the `power_ready` slot of `symbol.domain`, or reports why not. */
  #storePower(symbol: string, domain: string, value: boolean): void {
    const declared = this.#powerDomains.get(symbol);
    if (declared === undefined || declared.size === 0) {
      throw new CircuitError(
        'no-power-domains',
        `Device ${symbol} declares no power domains; give its description a powerDomains list to control it`,
        { deviceId: symbol },
      );
    }
    const slot = declared.get(domain);
    if (slot === undefined) {
      throw new CircuitError(
        'power-domain-not-found',
        `Power domain ${symbol}.${domain} not found. Available: ${describeNames(declared.keys())}`,
        { deviceId: symbol, domainName: domain },
      );
    }
    const ready = this.#powerReady;
    if (ready === undefined) {
      throw new CircuitError(
        'no-power-domains',
        `Circuit has no power_ready memory; the compiled module declares no domains`,
        { deviceId: symbol, domainName: domain },
      );
    }
    this.#jit.storage.storeArray(ready, slot.index, value);
  }

  /** Validates a `symbol`/`pin` pair and returns its `'symbol.pin'` endpoint. */
  #requirePin(symbol: string, pin: string): string {
    const device = this.#requireDevice(symbol);
    if (!device.pins.has(pin)) {
      throw new CircuitError(
        'pin-not-found',
        `Pin ${symbol}.${pin} not found. Available: ${describeNames(device.pins.keys())}`,
        { deviceId: symbol, pinName: pin },
      );
    }
    return `${symbol}.${pin}`;
  }

  /** Validates that `symbol` names a compiled device. */
  #requireDevice(symbol: string): DeviceMetadata {
    const device = this.#compiled.deviceMap.get(symbol);
    if (device === undefined) {
      throw new CircuitError(
        'device-not-found',
        `Device ${symbol} not found. Available: ${describeNames(this.#compiled.deviceMap.keys())}`,
        { deviceId: symbol },
      );
    }
    return device;
  }

  /** Connection names of `symbol`, for `connection-not-found` messages. */
  #connectionList(symbol: string): string {
    const declared = this.#compiled.connections.devices.get(symbol);
    return describeNames(declared?.keys() ?? []);
  }
}

/** Renders a name list for an error message; `(none)` keeps it readable. */
function describeNames(names: Iterable<string>): string {
  const list = [...names];
  return list.length === 0 ? '(none)' : `[${list.join(', ')}]`;
}

/** Clamps a raw virtual time into the scheduler's `TimePs` range. */
function toTimePs(value: number): TimePs {
  const clamped = value < 0 ? 0 : value > MAX_TIME_PS ? MAX_TIME_PS : value;
  return brandedTimePs(clamped);
}

/** Resolves every pin of the global address space into its runtime view. */
function pinRuntimeOf(compiled: CompiledCircuit): ReadonlyMap<string, PinRuntime> {
  const pins = new Map<string, PinRuntime>();
  const pinDomains = compiled.powerDomains.pinDomains;
  for (const [deviceId, allocation] of compiled.pins.devices) {
    for (const [pinName, pin] of allocation.resolved) {
      pins.set(
        `${deviceId}.${pinName}`,
        Object.freeze({
          globalPinId: pin.globalPinId,
          role: pin.role,
          senses: pin.senses,
          domain: pinDomains.get(pin.globalPinId),
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

function createEngine(
  compiled: CompiledCircuit,
  options: ResolvedRuntimeOptions,
  bridge: BridgeSink,
): IRInterpreter {
  const base = {
    validation: compiled.validation,
    // One batch can execute hundreds of millions of instructions; the default
    // step budget is tuned for single entries, not for a loop in the IR.
    maxSteps: Number.MAX_SAFE_INTEGER,
    // Topic outputs are `bridge.send`; the host accepts every payload so a
    // device never sees a spurious back-pressure result.
    bridge: {
      send(output: OutputRef, payload: readonly (boolean | number)[], timePs: number): boolean {
        bridge.emit?.(output, payload, timePs);
        return true;
      },
      sendBytes(): boolean {
        // Byte endpoints are not generated yet; the compiler only declares
        // scalar outputs (`TopicEndpointRegistry`).
        return true;
      },
    },
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
    ...(options.supplyVoltage === undefined ? {} : { supplyVoltage: options.supplyVoltage }),
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
  let supplyVoltage: number | undefined;
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
    if (electrical.supplyVoltage !== undefined) {
      if (!Number.isFinite(electrical.supplyVoltage) || electrical.supplyVoltage <= 0) {
        throw new CircuitError(
          'invalid-options',
          `electrical.supplyVoltage must be a finite positive number, received ${String(electrical.supplyVoltage)}`,
        );
      }
      supplyVoltage = electrical.supplyVoltage;
    }
    rails = electrical.rails;
  }

  return Object.freeze({
    engine,
    jit: candidate.jit,
    validateIR: candidate.validateIR ?? true,
    allowMultiDriver,
    rails,
    supplyVoltage,
    instanceId: candidate.instanceId ?? DEFAULT_INSTANCE_ID,
  });
}
