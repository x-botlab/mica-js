import { MAX_TIME_PS, timePs } from '@mica-js/core';
import type { TimePs, TopologyDefinition } from '@mica-js/core';
import type { SchematicDocument } from '@mica-js/core/schematic';
import type { TopicPayload, TopicPayloadType } from '@mica-js/device';
import { compileBoardTopology, compileSchematicToCircuit } from '../compiler';
import type {
  CircuitCompilationInput,
  CompiledSchematicDevice,
  CompilationDiagnostic,
  SchematicCompilationOptions,
} from '../compiler';
import { SimulatorError } from '../../errors';
import type {
  AdvanceReport,
  DevicePublish,
  DeviceSimExecutor,
  DeviceSimExecutorOptions,
  DeviceTopic,
  DeviceTopicTarget,
  SimulationDiagnostic,
  SimulationState,
} from '../../types';
import { Circuit } from './circuit';

/**
 * `DeviceSimExecutor` over the unified-IR `Circuit` runtime (U06).
 *
 * ```ts
 * const executor = createCircuitExecutor({ devices: provider });
 * await executor.loadSchematic(sheet);
 * executor.deliver({ symbol: 'S1', port: 'pressed' }, true);
 * const report = executor.advance(16_000_000);      // 16 µs
 * ```
 *
 * The adapter exists so a host that already speaks `DeviceSimExecutor` — the
 * playground, the widget host, the device e2e tests — can run the compiled
 * engine without touching its own code: the schematic is compiled into one IR
 * module per load, `advance` becomes one `runBatch` call, and topics become
 * `deliverTopic` / `onPublish`.
 *
 * ### Time
 *
 * The circuit advances one **tick per microsecond** (`TICK_PS`), because the
 * compiled main loop has no notion of picoseconds. A host may still ask for
 * finer slices: `advance(delta)` runs `floor((carry + delta) / TICK_PS)` ticks
 * and keeps the rest as a carry, so the reported clock is always the sum of the
 * requested deltas while device state only moves on whole ticks. The playground
 * steps 10 ns, which runs one tick every hundred steps.
 *
 * ### Topics
 *
 * `deliver` queues, exactly like the scheduler path: the payload is handed to
 * the device entry at the start of the next `advance`, so several events for the
 * same instant are observed in call order.
 */

/** Picoseconds per circuit tick: the compiled loop advances 1 µs per tick. */
export const TICK_PS = 1_000_000;

const EMPTY_SCHEMATIC: SchematicDocument = Object.freeze({
  version: 1,
  sheet: Object.freeze({
    symbols: Object.freeze([]),
    wires: Object.freeze([]),
    junctions: Object.freeze([]),
  }),
});

const EMPTY_TOPICS: readonly DeviceTopic[] = Object.freeze([]);
const EMPTY_ALIASES: ReadonlyMap<string, string> = new Map();

interface PendingDelivery {
  readonly target: DeviceTopicTarget;
  readonly payload: unknown;
}

/**
 * Options of {@link createCircuitExecutor}.
 *
 * A `DeviceSimExecutorOptions` is accepted as-is; `resolveDevice` is the extra
 * seam that binds a schematic device package to an IR type with real logic,
 * because a package description only carries pins, ports and properties.
 */
export interface CircuitExecutorOptions extends DeviceSimExecutorOptions {
  /** Binds a device reference to its IR type, description and config. */
  readonly resolveDevice?: SchematicCompilationOptions['resolveDevice'];
  /**
   * Host-owned board wiring the sheet does not draw.
   *
   * A schematic carries symbols; a board fixture carries the wires between them,
   * the supply rails and the board pins a probe names. The executor folds it in
   * with `compileBoardTopology`, so `board.SENSE` becomes a real net and a probe
   * can sample it through the device pin it shares a wire with.
   */
  readonly topology?: TopologyDefinition;
}

/**
 * Creates a `DeviceSimExecutor` backed by the unified-IR runtime.
 *
 * `options.host` and `options.scheduler` are scheduler-path concepts and are
 * ignored: the compiled circuit owns its own electrical solve, so no host
 * wiring factory is needed.
 */
export function createCircuitExecutor(options: CircuitExecutorOptions): DeviceSimExecutor {
  return new CircuitExecutor(options);
}

class CircuitExecutor implements DeviceSimExecutor {
  readonly #options: CircuitExecutorOptions;
  readonly #publishListeners = new Set<(publish: DevicePublish) => void>();
  readonly #pending: PendingDelivery[] = [];
  #circuit: Circuit | undefined;
  #unsubscribe: (() => void) | undefined;
  #schematic: SchematicDocument = EMPTY_SCHEMATIC;
  #state: SimulationState = 'idle';
  #symbolByDevice = new Map<string, string>();
  /** Compiled endpoints per symbol, which is what `deliver` validates against. */
  #deviceBySymbol = new Map<
    string,
    {
      readonly deviceId: string;
      readonly type: string;
      readonly ports: readonly {
        readonly port: string;
        readonly direction: 'input' | 'output';
        readonly type: TopicPayloadType;
        readonly title?: string;
      }[];
    }
  >();
  #topics: readonly DeviceTopic[] = EMPTY_TOPICS;
  /** Board pin (`instanceId.pinName`) -> device pin that shares its wire. */
  #probeAliases: ReadonlyMap<string, string> = new Map();
  /** Ticks executed while the sheet declares no device to compile. */
  #idleTicks = 0;
  /**
   * Picoseconds requested but not yet a whole tick.
   *
   * The compiled loop advances 1 µs per tick, while a host may ask for finer
   * slices (the playground steps 10 ns). The remainder keeps the reported clock
   * equal to the sum of every `delta` and turns into a tick once a full
   * microsecond has accumulated.
   */
  #remainderPs = 0;

  constructor(options: CircuitExecutorOptions) {
    this.#options = options;
  }

  getState(): SimulationState {
    return this.#state;
  }

  getSimTime(): TimePs {
    const ticks = this.#circuit === undefined ? this.#idleTicks : Number(this.#circuit.tickCount);
    return toTime(ticks * TICK_PS + this.#remainderPs);
  }

  getSchematic(): SchematicDocument {
    return this.#schematic;
  }

  getTopics(): readonly DeviceTopic[] {
    return this.#topics;
  }

  async loadSchematic(document: SchematicDocument): Promise<void> {
    this.#assertNotDisposed();
    const compilation = await compileSchematicToCircuit(document, this.#options.devices, {
      ...(this.#options.resolveDevice === undefined
        ? {}
        : { resolveDevice: this.#options.resolveDevice }),
    });
    for (const diagnostic of compilation.diagnostics) this.#reportCompilation(diagnostic);
    const errors = compilation.diagnostics.filter((entry) => entry.severity === 'error');
    if (errors.length > 0) {
      throw new SimulatorError(
        'simulator/schematic-compile-failed',
        `The schematic could not be compiled: ${errors.map((entry) => entry.message).join(' ')}`,
      );
    }

    // The sheet only carries symbols when the host owns the wiring; fold the
    // board fixture in before building so both describe the same netlist.
    const board =
      this.#options.topology === undefined
        ? undefined
        : compileBoardTopology(this.#options.topology, compilation.devices);
    const input =
      board === undefined || board.connections.length === 0
        ? compilation.input
        : Object.freeze({
            ...compilation.input,
            connections: Object.freeze([...compilation.input.connections, ...board.connections]),
          });
    const rails =
      board === undefined
        ? compilation.rails
        : Object.freeze({ ...compilation.rails, ...board.rails });
    // Build first: a rejected load must leave the running simulation untouched.
    const circuit =
      input.devices.length === 0 ? undefined : await this.#createCircuit(document, input, rails);
    const topics = this.#collectTopics(compilation.devices, circuit);

    this.#teardown();
    this.#circuit = circuit;
    this.#unsubscribe = circuit?.onPublish((publish) => this.#forward(publish));
    this.#symbolByDevice = new Map(
      compilation.devices.map((device) => [device.deviceId, device.symbolId] as const),
    );
    // `deliver` validates against the compiled endpoints, not the package
    // description: a `resolveDevice` binding may add or replace ports.
    const portsBySymbol = new Map<string, DeviceTopic[]>();
    for (const topic of topics) {
      const list = portsBySymbol.get(topic.symbol);
      if (list === undefined) portsBySymbol.set(topic.symbol, [topic]);
      else list.push(topic);
    }
    this.#deviceBySymbol = new Map(
      compilation.devices.map((device) => {
        const ports = (portsBySymbol.get(device.symbolId) ?? []).map((topic) =>
          Object.freeze({
            port: topic.port,
            direction: topic.direction,
            type: topic.type,
            ...(topic.title === undefined ? {} : { title: topic.title }),
          }),
        );
        return [
          device.symbolId,
          { deviceId: device.deviceId, type: device.type, ports: Object.freeze(ports) },
        ] as const;
      }),
    );
    this.#topics = Object.freeze(topics);
    this.#probeAliases = board?.aliases ?? EMPTY_ALIASES;
    this.#schematic = document;
    this.#state = 'ready';
  }

  advance(delta: TimePs): AdvanceReport {
    this.#assertNotDisposed();
    const circuit = this.#requireReady();
    if (!Number.isSafeInteger(delta) || delta <= 0) {
      throw new SimulatorError(
        'simulator/invalid-delta',
        `advance expects a positive whole number of picoseconds, received ${String(delta)}.`,
      );
    }
    const from = this.getSimTime();
    // Deliveries run at the start of the slice, before any tick; a rejected
    // payload throws from here, which leaves the clock and the state untouched
    // exactly like the scheduler path did.
    this.#flush(circuit);
    const total = this.#remainderPs + delta;
    const ticks = Math.floor(total / TICK_PS);
    this.#remainderPs = total - ticks * TICK_PS;
    try {
      if (circuit === undefined) {
        this.#idleTicks += ticks;
      } else {
        circuit.runBatch(ticks);
      }
    } catch (cause) {
      this.#state = 'faulted';
      this.#report({
        code: 'simulator/advance-failed',
        message: `Advancing ${delta} ps failed.`,
        cause,
      });
      throw cause;
    }
    return Object.freeze({
      from,
      to: this.getSimTime(),
      executed: ticks,
      reason: 'until',
    });
  }

  onPublish(listener: (publish: DevicePublish) => void): () => void {
    if (this.#state === 'disposed') {
      return () => {};
    }
    this.#publishListeners.add(listener);
    return () => {
      this.#publishListeners.delete(listener);
    };
  }

  deliver(target: DeviceTopicTarget, payload: unknown): void {
    this.#assertNotDisposed();
    this.#requireReady();
    const device = this.#deviceBySymbol.get(target.symbol);
    if (device === undefined) {
      throw new SimulatorError(
        'simulator/unknown-target',
        `The schematic has no device symbol "${target.symbol}".`,
        { symbol: target.symbol },
      );
    }
    const port = device.ports.find((candidate) => candidate.port === target.port);
    if (port === undefined) {
      throw new SimulatorError(
        'simulator/unknown-port',
        `Device ${JSON.stringify(device.type)} has no port "${target.port}".`,
        { symbol: target.symbol },
      );
    }
    if (port.direction !== 'input') {
      throw new SimulatorError(
        'simulator/unknown-port',
        `Port "${target.port}" of symbol "${target.symbol}" is an output, not an input.`,
        { symbol: target.symbol },
      );
    }
    this.#pending.push(Object.freeze({ target: Object.freeze({ ...target }), payload }));
  }

  /**
   * Samples the digital level of one device pin.
   *
   * `symbol` is the schematic symbol id a probe stores; the device id the
   * circuit keys its pins by (the designator) is resolved first, so both forms
   * work. The level is the one {@link Circuit.samplePin} reports for the last
   * tick: sensing pins read the solved net, driver pins read their latch.
   *
   * @throws {SimulatorError} when no schematic is loaded, `CircuitError` when
   *   the symbol or pin does not exist.
   */
  samplePin(symbol: string, pin: string): { value: 0 | 1; ready: boolean } {
    const circuit = this.#probeCircuit();
    const target = this.#probeTarget(symbol, pin);
    return circuit.samplePin(target.deviceId, target.pin);
  }

  /**
   * Samples the solved voltage of one device pin, in volts (RFC 0002 §5).
   *
   * `symbol` and `pin` are resolved exactly like {@link samplePin}, including
   * board-level probe aliases. The reading is the node voltage of the last
   * tick, so a host can plot an analog signal next to the digital trace.
   *
   * @throws {SimulatorError} when no schematic is loaded, `CircuitError` when
   *   the symbol or pin does not exist.
   */
  samplePinVoltage(symbol: string, pin: string): { value: number; ready: boolean } {
    const circuit = this.#probeCircuit();
    const target = this.#probeTarget(symbol, pin);
    return { value: circuit.samplePinVoltage(target.deviceId, target.pin), ready: true };
  }

  /**
   * Samples the switch state of one declared device connection.
   *
   * Reads the `connection_states` slot the running circuit keeps for the
   * device, so a contact a device just switched reports its new state.
   *
   * @throws {SimulatorError} when no schematic is loaded, `CircuitError` when
   *   the symbol or connection does not exist.
   */
  sampleConnection(
    symbol: string,
    connection: string,
  ): { state: 'open' | 'closed'; ready: boolean } {
    return this.#probeCircuit().sampleConnection(this.#deviceIdOf(symbol), connection);
  }

  reset(): void {
    this.#assertNotDisposed();
    this.#pending.length = 0;
    this.#remainderPs = 0;
    if (this.#circuit === undefined) {
      this.#idleTicks = 0;
      return;
    }
    this.#circuit.reset();
  }

  dispose(): void {
    if (this.#state === 'disposed') {
      return;
    }
    this.#state = 'disposed';
    this.#publishListeners.clear();
    this.#pending.length = 0;
    this.#teardown();
  }

  /** Compiles and mounts one circuit; the caller swaps it in only on success. */
  async #createCircuit(
    document: SchematicDocument,
    input: CircuitCompilationInput,
    rails: Readonly<Record<string, boolean>>,
  ): Promise<Circuit> {
    try {
      return await Circuit.create(input, {
        engine: 'jit',
        electrical: { rails, allowMultiDriver: false },
      });
    } catch (cause) {
      throw new SimulatorError(
        'simulator/schematic-compile-failed',
        `The schematic "${schematicName(document)}" could not be compiled into a circuit.`,
        { cause },
      );
    }
  }

  /** Endpoints of the running instances, in sheet order. */
  #collectTopics(
    devices: readonly CompiledSchematicDevice[],
    circuit: Circuit | undefined,
  ): readonly DeviceTopic[] {
    if (circuit === undefined) {
      return Object.freeze(
        devices.flatMap((device) =>
          device.ports.map((port) =>
            Object.freeze({
              symbol: device.symbolId,
              designator: device.designator,
              port: port.port,
              direction: port.direction,
              type: port.type,
              ...(port.title === undefined ? {} : { title: port.title }),
            }),
          ),
        ),
      );
    }
    const designators = new Map(devices.map((device) => [device.deviceId, device] as const));
    return Object.freeze(
      circuit.topics.map((topic) => {
        const device = designators.get(topic.deviceId);
        return Object.freeze({
          symbol: device?.symbolId ?? topic.deviceId,
          designator: device?.designator ?? topic.deviceId,
          port: topic.port,
          direction: topic.direction,
          type: topic.type,
          ...(topic.title === undefined ? {} : { title: topic.title }),
        });
      }),
    );
  }

  /**
   * Hands the queued payloads to their devices at the slice's start time.
   *
   * @throws {CircuitError} with code `invalid-topic-payload` when a queued value
   *   does not match its port type. The caller propagates it without faulting
   *   the executor, so a host can report the rejection and keep simulating —
   *   the same contract the scheduler path had.
   */
  #flush(circuit: Circuit | undefined): void {
    if (this.#pending.length === 0) return;
    const deliveries = this.#pending.splice(0);
    if (circuit === undefined) return;
    for (const delivery of deliveries) {
      // Bindings store the symbol id; the circuit keys its endpoints by the
      // device id derived from the designator.
      const deviceId = this.#deviceBySymbol.get(delivery.target.symbol)?.deviceId;
      if (deviceId === undefined) continue; // Validated when queued; a reload dropped it.
      circuit.deliverTopic(deviceId, delivery.target.port, delivery.payload as TopicPayload);
    }
  }

  /** Re-emits one circuit publish with schematic identity and picosecond time. */
  #forward(publish: DevicePublish): void {
    const symbol = this.#symbolByDevice.get(publish.target.symbol) ?? publish.target.symbol;
    const forwarded: DevicePublish = Object.freeze({
      target: Object.freeze({ symbol, port: publish.target.port }),
      payload: publish.payload,
      // The circuit counts ticks; the executor contract counts picoseconds.
      simTime: toTime(Number(publish.simTime) * TICK_PS),
    });
    for (const listener of [...this.#publishListeners]) {
      try {
        listener(forwarded);
      } catch (cause) {
        this.#report({
          code: 'simulator/publish-failed',
          message: 'A publish listener threw.',
          symbol,
          cause,
        });
      }
    }
  }

  #teardown(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#circuit?.dispose();
    this.#circuit = undefined;
    this.#pending.length = 0;
    this.#idleTicks = 0;
    this.#remainderPs = 0;
    this.#symbolByDevice = new Map();
    this.#deviceBySymbol = new Map();
    this.#topics = EMPTY_TOPICS;
    this.#probeAliases = EMPTY_ALIASES;
  }

  #requireReady(): Circuit | undefined {
    if (this.#state !== 'ready') {
      throw new SimulatorError(
        'simulator/not-ready',
        'Load a schematic before advancing the simulation.',
      );
    }
    return this.#circuit;
  }

  /** The running circuit, for probe sampling; a sheet with no devices has no state. */
  #probeCircuit(): Circuit {
    const circuit = this.#requireReady();
    if (circuit === undefined) {
      throw new SimulatorError(
        'simulator/not-ready',
        'The schematic declares no devices, so it has no pin or connection state to sample.',
      );
    }
    return circuit;
  }

  /** Symbol id -> device id; a designator already is the device id, so it passes through. */
  #deviceIdOf(symbol: string): string {
    return this.#deviceBySymbol.get(symbol)?.deviceId ?? symbol;
  }

  /** Maps a probe target to the device pin that carries the same net. */
  #probeTarget(symbol: string, pin: string): { readonly deviceId: string; readonly pin: string } {
    const alias = this.#probeAliases.get(`${symbol}.${pin}`);
    const dot = alias === undefined ? -1 : alias.indexOf('.');
    if (alias === undefined || dot <= 0) return { deviceId: this.#deviceIdOf(symbol), pin };
    return { deviceId: alias.slice(0, dot), pin: alias.slice(dot + 1) };
  }

  #assertNotDisposed(): void {
    if (this.#state === 'disposed') {
      throw new SimulatorError('simulator/disposed', 'The executor is disposed.');
    }
  }

  #reportCompilation(diagnostic: CompilationDiagnostic): void {
    this.#report({
      code: 'simulator/schematic-diagnostic',
      message: `[${diagnostic.code}] ${diagnostic.message}`,
      ...(diagnostic.symbol === undefined ? {} : { symbol: diagnostic.symbol }),
    });
  }

  #report(diagnostic: SimulationDiagnostic): void {
    try {
      this.#options.onDiagnostic?.(diagnostic);
    } catch {
      // A throwing diagnostic sink must not take the simulation down.
    }
  }
}

/** Clamps a raw picosecond value into the scheduler's `TimePs` range. */
function toTime(value: number): TimePs {
  const clamped = value < 0 ? 0 : value > MAX_TIME_PS ? MAX_TIME_PS : value;
  return timePs(clamped);
}

/** Human-readable name of a sheet; `.sch` files carry no name, so the first symbols index them. */
function schematicName(document: SchematicDocument): string {
  return `sheet(${document.sheet.symbols.length} symbol(s))`;
}
