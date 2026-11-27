import { Emitter, type Event, type Disposable } from '@mica-js/core/lifecycle';
import { BuildError, validateDeviceIR, type DeviceIR } from '@mica-js/device-model';
import { RESUMABLE_RECEIVE, RESUMABLE_TICKS, type ResumableProgram } from '@mica-js/compiler';
import {
  createElectricalNetwork,
  ElectricalError,
  type ElectricalPin,
  type ElectricalNetwork,
} from './electrical';
import { ActivationQueue, EventQueue, Fifo } from './queue';
import { compileObservation } from './observations';
import { Instance } from './runtime/instance';
import { registerPublishGate } from './runtime/publish-gate';
import {
  batchStats,
  type BatchDecline,
  type BatchKind,
  type BatchStage,
  type BatchStats,
  type BoundBatch,
  type PreparedBatch,
} from './runtime/batch';
import {
  cancelPollingReservation,
  readDirectCheckpointStats,
  runJit,
  syncJitCall,
  type BoundarySource,
} from './runtime/jit';
import { body, computation, frame, MAX_TIME, synchronousBody, time } from './runtime/execution';
import {
  acceptSync,
  AsyncHookError,
  ElectricalParameterError,
  modelLocation,
  standalone,
} from './runtime/errors';
import type {
  Entry,
  Jit,
  Observation,
  ObservationChain,
  Process,
  Reaction,
  Receiver,
  ResourceSlot,
} from './runtime/state';
import { dataObject, finite, identity, integer, same, snapshot } from './values';
import {
  SimulationError,
  type Board,
  type BoardDescription,
  type BoardOptions,
  type BoardStatus,
  type DeviceAdapter,
  type DeviceLibrary,
  type DeviceLibraryEntry,
  type RuntimeDiagnostic,
  type RuntimeDiagnosticCode,
  type RuntimePhase,
  type TopicBridge,
  type TopicMessage,
} from './types';

const OBSERVATION_PROBE = Symbol.for('mica-js.simulator/observations');
const PROCESS_PROBE = Symbol.for('mica-js.simulator/processes');
const CHECKPOINT_PROBE = Symbol.for('mica-js.simulator/checkpoints');
/**
 * Internal diagnostics opt-in. It stays a `globalThis` symbol so the runtime remains
 * browser-compatible and the public SDK surface does not grow:
 *
 * `globalThis[Symbol.for('mica-js.simulator/checkpoint-experiment')]?.diagnostics`
 *
 * Counters default to off; they classify boundary sources without changing runtime behavior.
 */
const CHECKPOINT_EXPERIMENT = Symbol.for('mica-js.simulator/checkpoint-experiment');

const EMPTY_BOUNDARY_SOURCES: Readonly<Record<BoundarySource, number>> = Object.freeze({
  checkpointPublish: 0,
  checkpointFinish: 0,
  jitSignal: 0,
  runJit: 0,
  runDirect: 0,
  polling: 0,
  process: 0,
  other: 0,
});

interface BoundaryStats {
  /** Every boundary() entry. */
  calls: number;
  /** Calls that neither published an electrical change nor drained observations. */
  empty: number;
  /** Electrical publish passes driven by a boundary. */
  publishes: number;
  /** Observation batches drained by a boundary. */
  batches: number;
  /** Reaction bodies executed by boundaries. */
  reactions: number;
  /** Capture values frozen by the reaction capture barrier. */
  captures: number;
  /** Boundary entries grouped by the call site that requested the settlement. */
  sources: Record<BoundarySource, number>;
}

function createBoundaryStats(): BoundaryStats {
  return {
    calls: 0,
    empty: 0,
    publishes: 0,
    batches: 0,
    reactions: 0,
    captures: 0,
    sources: { ...EMPTY_BOUNDARY_SOURCES },
  };
}

function checkpointDiagnosticsEnabled(): boolean {
  const value = (globalThis as unknown as Record<PropertyKey, unknown>)[CHECKPOINT_EXPERIMENT];
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { diagnostics?: unknown }).diagnostics === true
  );
}

const EMPTY_QUEUE_ENTRY = Object.freeze({}) as unknown as Observation;
const libraries = new WeakMap<object, readonly Entry[]>();

export function createDeviceLibrary(entries: readonly DeviceLibraryEntry[]): DeviceLibrary {
  try {
    if (!Array.isArray(entries)) throw new TypeError('Expected device entries');
    const seen = new Set<string>();
    const captured = entries.map((entry) => {
      dataObject(entry, ['id', 'model', 'create']);
      const id = identity(entry.id);
      if (seen.has(id)) throw new TypeError(`Duplicate device type ${id}`);
      seen.add(id);
      if (typeof entry.create !== 'function') throw new TypeError('Expected device factory');
      let model: DeviceIR;
      try {
        model = validateDeviceIR(entry.model);
      } catch (cause) {
        const conflict =
          cause instanceof BuildError &&
          Object.getOwnPropertyDescriptor(cause, 'code')?.value === 'CHANNEL_CONSUMER_CONFLICT';
        throw standalone(
          conflict ? 'CHANNEL_CONSUMER_CONFLICT' : 'MODEL_VALIDATION_FAILED',
          cause,
          'library',
        );
      }
      return Object.freeze({ id, model, create: entry.create as DeviceLibraryEntry['create'] });
    });
    const library = Object.freeze({}) as DeviceLibrary;
    libraries.set(library, captured);
    return library;
  } catch (cause) {
    if (cause instanceof SimulationError) throw cause;
    throw standalone('INVALID_CONFIGURATION', cause, 'library');
  }
}
interface TopicListener {
  readonly owner?: Instance;
  readonly call: (message: TopicMessage) => unknown;
}

/** Mutable view of the compiler's readonly reaction frame, reused across boundaries. */
interface MutableReactionFrame {
  previous: unknown;
  current: unknown;
  captures: unknown[];
}

class BoardRuntime implements Board {
  time = 0;
  status: BoardStatus = 'ready';
  phase = 'assembly';
  current: Instance | undefined;
  /** -1: clean; -2: initial solve or multiple dirty slots; otherwise the only dirty slot. */
  private pendingElectricalSlot = -2;
  /** Flat dirty batch for the multi-slot publication path, stamped to drop repetitions. */
  private dirtyElectricalSlots = new Int32Array(0);
  private dirtyElectricalStamps = new Int32Array(0);
  private dirtyElectricalLength = 0;
  private dirtyElectricalEpoch = 1;
  private readonly observations = new ActivationQueue<Observation>();
  private readonly reactionBatch: Reaction[] = [];
  private readonly changeObservations: Receiver[] = [];
  private readonly changePrevious: unknown[] = [];
  private readonly changeCurrent: unknown[] = [];
  private readonly plans: ObservationChain[] = [];
  private readonly skippedPlans: { readonly key: string; readonly reason: string }[] = [];
  private readonly sampleSlots = new Map<ElectricalPin, ResourceSlot>();
  /** Electrical slot → published sample slot, bound once so publishing needs no lookup. */
  private readonly sampleSlotsBySlot: ResourceSlot[] = [];
  /** Electrical endpoint → its board slot, used to record dirty pins by slot. */
  private readonly electricalSlots = new Map<ElectricalPin, number>();
  private readonly byId = new Map<string, Instance>();
  private dispatchDepth = 0;
  private initialized = false;
  private readonly errors = new Emitter<RuntimeDiagnostic>();
  private readonly diagnostics = new Emitter<RuntimeDiagnostic>();
  private readonly listeners = new Set<TopicListener>();
  /** Owner-less listeners of the shared set: the host's direct subscriptions on `topics`. */
  private hostListeners = 0;
  private readonly models = new Fifo<Process>();
  readonly events = new EventQueue<() => void>();
  private readonly readyJits = new Fifo<Jit>();
  /**
   * Bumped on every resource-version mutation board wide. The value is bare arithmetic: a
   * difference proves *some* resource moved, never which one, so it only ever guards
   * "nothing changed at all" conclusions.
   *
   * Mutations cluster inside `publish()` while derived reads spread across the gaps
   * between publications, so a checkpoint compared against this counter hits far more
   * often than the raw mutation-to-read ratio suggests: `camera-mcu` sees 8514 bumps and
   * 5638 derived reads per frame, yet 99.93% of those reads find the epoch unchanged.
   */
  private versionEpoch = 0;
  readonly waitingJits = new Set<Jit>();
  /**
   * Advances whenever a parked JIT is flagged or parks. The global `versionEpoch` cannot
   * gate the scan: every electrical publish bumps it even when no JIT waits on the slot.
   */
  private waiterEpoch = 0;
  /** `waiterEpoch` at the last parked-JIT scan; equal means no parked JIT can have woken. */
  private waitingScanEpoch = 0;
  /** Automatic periodic polls whose time boundary needs recomputing each round. */
  private pollingWaiterCount = 0;
  readonly jits: Jit[] = [];
  readonly instances: Instance[] = [];
  /** Aggregate counters are disabled by default so formal runs avoid per-checkpoint writes. */
  readonly checkpointDiagnostics: boolean;
  private readonly batchPublications: Map<Instance, Record<BatchKind, number>> | undefined;
  private readonly batchStats: Readonly<Record<BatchKind, BatchStats>> | undefined;
  private readonly boundaryStats: BoundaryStats | undefined;
  private network!: ElectricalNetwork;
  private primary: SimulationError | undefined;
  readonly execution: 'throughput' | 'precise';
  /** Effective process/JIT batch admission; false in precise mode even if requested. */
  readonly batchExecution: boolean;
  /** CPU execution quantum in integer picoseconds, also used as a JIT batch ceiling. */
  readonly cpuQuantum: number;
  executionEnd = 0;
  readonly onDidError: Event<RuntimeDiagnostic> = (listener, thisArgs, disposables) =>
    this.errors.event(
      (diagnostic) => {
        try {
          listener.call(thisArgs, diagnostic);
        } catch (cause) {
          this.diagnostic('HOST_LISTENER_FAILED', cause);
        }
      },
      undefined,
      disposables,
    );
  readonly onDidDiagnostic: Event<RuntimeDiagnostic> = (listener, thisArgs, disposables) =>
    this.diagnostics.event(
      (diagnostic) => {
        try {
          listener.call(thisArgs, diagnostic);
        } catch (cause) {
          this.fallback(cause);
        }
      },
      undefined,
      disposables,
    );
  readonly topics: TopicBridge = this.topicBridge();
  constructor(entries: readonly Entry[], description: BoardDescription, options: BoardOptions) {
    try {
      dataObject(description, ['instances', 'nets']);
      dataObject(options, ['seed', 'execution', 'cpuQuantum', 'batchExecution']);
      this.checkpointDiagnostics = checkpointDiagnosticsEnabled();
      this.boundaryStats = this.checkpointDiagnostics ? createBoundaryStats() : undefined;
      const execution = Object.hasOwn(options, 'execution') ? options.execution : 'throughput';
      if (execution !== 'throughput' && execution !== 'precise')
        throw new TypeError('Invalid execution mode');
      this.execution = execution;
      const requestedBatchExecution = Object.hasOwn(options, 'batchExecution')
        ? options.batchExecution
        : false;
      if (typeof requestedBatchExecution !== 'boolean')
        throw new TypeError('batchExecution must be a boolean');
      this.batchExecution = requestedBatchExecution && execution === 'throughput';
      this.batchPublications = this.checkpointDiagnostics ? new Map() : undefined;
      this.batchStats = this.checkpointDiagnostics
        ? { process: batchStats(), jit: batchStats() }
        : undefined;
      const cpuQuantum = Object.hasOwn(options, 'cpuQuantum')
        ? integer(options.cpuQuantum, 'cpuQuantum')
        : 10_000_000;
      if (cpuQuantum < 1 || cpuQuantum > 10_000_000)
        throw new RangeError('cpuQuantum outside [1, 10000000]');
      this.cpuQuantum = cpuQuantum;
      if (!Array.isArray(description.instances) || !Array.isArray(description.nets))
        throw new TypeError('instances and nets are required arrays');
      const seed = Object.hasOwn(options, 'seed') ? integer(options.seed, 'seed') : 0;
      if (seed < 0 || seed > 0xffffffff) throw new RangeError('seed out of uint32 range');
      const library = new Map(entries.map((entry) => [entry.id, entry]));
      const ids = new Set<string>();
      for (const input of description.instances) {
        dataObject(input, ['id', 'type', 'props', 'randomState']);
        const id = identity(input.id),
          type = identity(input.type);
        if (ids.has(id)) throw new TypeError(`Duplicate instance ${id}`);
        ids.add(id);
        const entry = library.get(type);
        if (!entry) throw new TypeError(`Unknown device type ${type}`);
        const props = Object.hasOwn(input, 'props') ? input.props : {};
        if (Object.hasOwn(input, 'randomState') && input.randomState === undefined)
          throw new TypeError('Invalid randomState');
        this.instances.push(
          new Instance(
            this,
            entry,
            id,
            props,
            seed,
            input.randomState as readonly number[] | undefined,
          ),
        );
      }
      for (const instance of this.instances) this.byId.set(instance.id, instance);
      const byId = this.byId;
      const netIds = new Set<string>(),
        connected = new Set<string>();
      for (const net of description.nets) {
        dataObject(net, ['id', 'pins', 'voltage']);
        const id = identity(net.id);
        if (netIds.has(id)) throw new TypeError(`Duplicate network ${id}`);
        netIds.add(id);
        if (!Array.isArray(net.pins)) throw new TypeError('Network pins must be an array');
        if (Object.hasOwn(net, 'voltage')) finite(net.voltage, 'voltage');
        for (const endpoint of net.pins) {
          dataObject(endpoint, ['instance', 'pin']);
          const instanceName = identity(endpoint.instance),
            pinName = identity(endpoint.pin);
          const instance = byId.get(instanceName);
          if (instance?.declarations.get(pinName)?.kind !== 'pin')
            throw new TypeError('Unknown pin endpoint');
          const key = `${instanceName}\0${pinName}`;
          if (connected.has(key)) throw new TypeError('Duplicate connected endpoint');
          connected.add(key);
        }
      }
      try {
        for (const instance of this.instances) {
          this.current = instance;
          instance.prepare();
        }
        for (const instance of this.instances) {
          this.current = instance;
          instance.assertCreation();
        }
        for (const instance of this.instances) {
          this.current = instance;
          instance.allocate();
        }
      } catch (cause) {
        throw this.wrap(cause, 'MODEL_EXECUTION_FAILED', 'assembly', this.current);
      }
      const nets = description.nets.map((net) => ({
        id: net.id,
        pins: net.pins.map((p: import('./types').PinEndpoint) => byId.get(p.instance)!.pin(p.pin)),
        ...(Object.hasOwn(net, 'voltage') ? { voltage: net.voltage! } : {}),
      }));
      const pins: ElectricalPin[] = [];
      for (const instance of this.instances)
        for (const pin of instance.pins.values()) {
          // The electrical slot is the position in this board-ordered pin list, so the
          // publish plan resolves a changed slot without a map lookup.
          const slot = instance.sampleResources.get(pin.name)!;
          pins.push(pin);
          this.sampleSlots.set(pin, slot);
          this.electricalSlots.set(pin, this.sampleSlotsBySlot.length);
          this.sampleSlotsBySlot.push(slot);
        }
      this.network = createElectricalNetwork(pins, nets);
      // One dirty list and one stamp per board pin: publication never allocates.
      this.dirtyElectricalSlots = new Int32Array(pins.length);
      this.dirtyElectricalStamps = new Int32Array(pins.length);
      this.phase = 'initialize';
      for (const instance of this.instances) {
        this.current = instance;
        let adapter: unknown;
        try {
          adapter = instance.entry.create(instance.context);
          acceptSync(adapter);
          if (
            adapter === null ||
            typeof adapter !== 'object' ||
            typeof (adapter as DeviceAdapter).sync !== 'function' ||
            typeof (adapter as DeviceAdapter).dispose !== 'function'
          )
            throw new TypeError('Invalid device adapter');
        } catch (cause) {
          throw this.wrap(cause, 'DEVICE_CALLBACK_FAILED', 'initialize', instance);
        }
        instance.adapter = adapter as unknown as DeviceAdapter;
        if (this.isFaulted) throw this.primary!;
      }
      this.current = undefined;
      this.phase = 'idle';
      Object.defineProperty(this, OBSERVATION_PROBE, {
        value: () => this.observationReport(),
        enumerable: false,
      });
      Object.defineProperty(this, PROCESS_PROBE, {
        value: () => this.processReport(),
        enumerable: false,
      });
      Object.defineProperty(this, CHECKPOINT_PROBE, {
        value: () => this.checkpointReport(),
        enumerable: false,
      });
    } catch (cause) {
      const error =
        cause instanceof SimulationError
          ? cause
          : this.wrap(cause, 'INVALID_CONFIGURATION', 'assembly', this.current);
      this.primary = error;
      const cleanupErrors = this.cleanup();
      throw cleanupErrors.length ? this.aggregate(error, cleanupErrors) : error;
    }
  }
  private get isFaulted(): boolean {
    return this.status === 'faulted';
  }
  /**
   * Read-only diagnostic view of generated observation chains. It is reachable only via
   * `Symbol.for('mica-js.simulator/observations')` and is not part of the public SDK.
   */
  private observationReport(): unknown {
    return Object.freeze({
      plans: Object.freeze(
        this.plans.map((chain) =>
          Object.freeze({
            key: chain.plan.key,
            path: Object.freeze([...chain.plan.path]),
            receivers: chain.members.length,
            slots: chain.plan.slots.length,
            source: chain.plan.source,
            comparison: chain.plan.comparison,
          }),
        ),
      ),
      skipped: Object.freeze(this.skippedPlans.map((entry) => Object.freeze({ ...entry }))),
      reactions: Object.freeze(
        this.instances.flatMap((instance) =>
          instance.reactions.map((reaction) =>
            Object.freeze({
              instance: instance.id,
              name: reaction.declaration.name,
              mode:
                reaction.synchronousProgram === undefined
                  ? 'pending'
                  : reaction.synchronousProgram === null
                    ? 'generic'
                    : reaction.synchronous !== undefined && reaction.synchronous !== null
                      ? 'sync'
                      : 'ready',
              functions: reaction.synchronousProgram?.functions.length ?? 0,
            }),
          ),
        ),
      ),
    });
  }
  /**
   * Read-only diagnostic view of process execution: bodies admitted as resumable blocks
   * versus bodies kept on the generator path. Reachable only via
   * `Symbol.for('mica-js.simulator/processes')`; not part of the public SDK.
   */
  private processReport(): unknown {
    const resumable: string[] = [];
    const generic: string[] = [];
    const programs: { readonly key: string; readonly blocks: number }[] = [];
    for (const instance of this.instances)
      for (const process of instance.processes) {
        const key = `${instance.id}/${process.declaration.kind === 'on' ? process.declaration.name : 'start'}`;
        (process.resumable ? resumable : generic).push(key);
        // Blocks stay zero for generator bodies: they have no machine to measure.
        programs.push(Object.freeze({ key, blocks: process.resumable?.blocks ?? 0 }));
      }
    return Object.freeze({
      resumable: Object.freeze(resumable),
      generic: Object.freeze(generic),
      programs: Object.freeze(programs),
      bindings: Object.freeze(this.instances.map((instance) => instance.bindingReport())),
    });
  }
  /**
   * Read-only diagnostic view of boundary and Direct-checkpoint counters. Reachable only via
   * `Symbol.for('mica-js.simulator/checkpoints')`; zero counters mean diagnostics were off.
   */
  private checkpointReport(): unknown {
    const boundary = this.boundaryStats;
    return Object.freeze({
      diagnostics: this.checkpointDiagnostics,
      batchExecution:
        this.batchStats === undefined
          ? undefined
          : Object.freeze({
              process: Object.freeze({
                ...this.batchStats.process,
                declines: Object.freeze({ ...this.batchStats.process.declines }),
              }),
              jit: Object.freeze({
                ...this.batchStats.jit,
                declines: Object.freeze({ ...this.batchStats.jit.declines }),
              }),
            }),
      boundary: Object.freeze({
        calls: boundary?.calls ?? 0,
        empty: boundary?.empty ?? 0,
        publishes: boundary?.publishes ?? 0,
        batches: boundary?.batches ?? 0,
        reactions: boundary?.reactions ?? 0,
        captures: boundary?.captures ?? 0,
        sources: Object.freeze({ ...(boundary?.sources ?? EMPTY_BOUNDARY_SOURCES) }),
      }),
      checkpoints: Object.freeze(
        this.instances.flatMap((instance) =>
          instance.jits.map((jit) => {
            const stats = readDirectCheckpointStats(jit);
            return Object.freeze({
              instance: instance.id,
              publications: stats?.publications ?? 0,
              finishes: stats?.finishes ?? 0,
              emptySuffixes: stats?.emptySuffixes ?? 0,
              boundaryCalls: stats?.boundaryCalls ?? 0,
              continues: stats?.continues ?? 0,
              exits: stats?.exits ?? 0,
            });
          }),
        ),
      ),
    });
  }
  assertAlive(instance?: Instance): void {
    if (this.status === 'disposed' || (instance && !instance.valid))
      throw this.error('OBJECT_DISPOSED', 'Object is disposed', instance);
  }
  /** Admission for a call that may change board state or is visible to a device. */
  assertCallAllowed(instance?: Instance): void {
    this.admit(instance, false);
  }
  /** Admission for a read-only entry point: a faulted board stays inspectable. */
  assertReadAllowed(instance?: Instance): void {
    this.admit(instance, true);
  }
  private admit(instance: Instance | undefined, allowFaulted: boolean): void {
    this.assertAlive(instance);
    if (instance && ['execute', 'translate', 'dispose', 'assembly'].includes(this.phase))
      throw this.error('INVALID_CALL_STATE', 'Operation is not allowed in this phase', instance);
    if (!allowFaulted && this.status === 'faulted')
      throw this.error('BOARD_FAULTED', 'Board is faulted', instance);
  }
  error(
    code: RuntimeDiagnosticCode,
    message: string,
    instance?: Instance,
    cause?: unknown,
    phase?: RuntimePhase,
  ): SimulationError {
    const electrical = cause instanceof ElectricalError ? cause : undefined;
    return new SimulationError(
      Object.freeze({
        code,
        message,
        phase: phase ?? (this.phase === 'idle' ? 'host' : (this.phase as RuntimePhase)),
        time: this.time,
        ...(electrical?.instanceId !== undefined
          ? { instanceId: electrical.instanceId }
          : instance
            ? { instanceId: instance.id }
            : {}),
        ...(electrical?.resource !== undefined ? { resource: electrical.resource } : {}),
        ...modelLocation(cause),
        ...(cause === undefined ? {} : { cause }),
        related: Object.freeze([]),
      }),
    );
  }
  wrap(
    cause: unknown,
    code: RuntimeDiagnosticCode,
    phase: RuntimePhase,
    instance?: Instance,
  ): SimulationError {
    if (
      cause instanceof SimulationError &&
      !['DEVICE_CALLBACK_FAILED', 'JIT_FAILED', 'CLEANUP_FAILED'].includes(code)
    )
      return cause;
    const ownCode =
      cause instanceof ElectricalError ||
      cause instanceof ElectricalParameterError ||
      cause instanceof AsyncHookError
        ? cause.code
        : undefined;
    return this.error(
      phase !== 'dispose' && ownCode ? ownCode : code,
      cause instanceof Error ? cause.message : String(cause),
      instance,
      cause,
      phase,
    );
  }
  fault(error: SimulationError): void {
    if (this.status !== 'ready') return;
    this.status = 'faulted';
    this.primary = error;
    this.dispatchDepth++;
    try {
      this.errors.fire(error.diagnostic);
    } finally {
      this.dispatchDepth--;
    }
  }
  private diagnostic(code: RuntimeDiagnosticCode, cause: unknown, instance?: Instance): void {
    const diagnostic = this.error(
      code,
      cause instanceof Error ? cause.message : String(cause),
      instance,
      cause,
    ).diagnostic;
    this.dispatchDepth++;
    try {
      this.diagnostics.fire(diagnostic);
    } finally {
      this.dispatchDepth--;
    }
  }
  private fallback(cause: unknown): void {
    try {
      console.error(cause);
    } catch {
      /* Reporting cannot replace the primary failure. */
    }
  }
  report(instance: Instance, cause: unknown): void {
    if (this.status === 'disposed') {
      this.fallback(cause);
      return;
    }
    if (!instance.valid) {
      this.diagnostic('STALE_REPORT', cause, instance);
      return;
    }
    if (this.status === 'faulted') {
      this.diagnostic('REPORTED_ERROR', cause, instance);
      return;
    }
    this.fault(
      this.error(
        'REPORTED_ERROR',
        cause instanceof Error ? cause.message : String(cause),
        instance,
        cause,
        'report',
      ),
    );
  }
  topicBridge(owner?: Instance): TopicBridge {
    const facade = Object.freeze({
      onDidReceive: ((
        listener: (message: TopicMessage) => unknown,
        thisArgs?: unknown,
        disposables?: Disposable[],
      ) => {
        this.assertCallAllowed(owner);
        const entry: TopicListener = {
          ...(owner ? { owner } : {}),
          call: (message) => listener.call(thisArgs, message),
        };
        this.listeners.add(entry);
        if (!owner) this.hostListeners++;
        let active = true;
        const disposable = {
          dispose: () => {
            if (active) {
              active = false;
              // Deleting decides the decrement, so a cleared set cannot drive the count negative.
              if (this.listeners.delete(entry) && !owner) this.hostListeners--;
            }
          },
        };
        disposables?.push(disposable);
        owner?.resources.push(disposable);
        return disposable;
      }) as Event<TopicMessage>,
      publish: (topic: string, payload: unknown) => {
        this.assertCallAllowed(owner);
        if (typeof topic !== 'string') throw new TypeError('Topic must be a string');
        this.dispatchDepth++;
        try {
          const message = Object.freeze({ topic, payload });
          for (const entry of [...this.listeners]) {
            if (entry.owner && this.status !== 'ready') continue;
            try {
              const result = entry.call(message);
              if (entry.owner) acceptSync(result);
            } catch (cause) {
              if (entry.owner)
                this.fault(this.wrap(cause, 'DEVICE_CALLBACK_FAILED', 'topic', entry.owner));
              else this.diagnostic('HOST_LISTENER_FAILED', cause);
            }
          }
        } finally {
          this.dispatchDepth--;
        }
      },
    });
    // The admission check and the owner-less listener count stay off the public contract: they
    // exist for the adapter layer, which decides whether anyone would receive a message.
    registerPublishGate(facade, {
      assertPublishAllowed: () => this.assertCallAllowed(owner),
      hostListeners: () => this.hostListeners,
    });
    return facade;
  }
  private enqueue(process: Process): void {
    if (process.state === 'idle') {
      process.state = 'queued';
      this.models.push(process);
    } else if (process.state !== 'queued') process.pending = true;
  }
  queueJit(jit: Jit): void {
    if (jit.active && !jit.stopped && !jit.queued) {
      jit.queued = true;
      this.readyJits.push(jit);
    }
  }
  /**
   * Fail-closed admission for resuming generated code without a scheduler round trip.
   * The JIT must be the only direct owner, all same-time scheduler stages must be empty,
   * and no event may be due through the requested horizon. The target time is exclusive:
   * code must not resume at `executionEnd`.
   */
  canContinueDirect(jit: Jit, horizon: number): boolean {
    return (
      this.status === 'ready' &&
      this.phase === 'execute' &&
      !this.isFaulted &&
      this.execution === 'throughput' &&
      this.jits.length === 1 &&
      this.jits[0] === jit &&
      jit.active &&
      !jit.stopped &&
      !jit.queued &&
      this.readyJits.length === 0 &&
      this.models.length === 0 &&
      this.waitingJits.size === 0 &&
      this.time < this.executionEnd &&
      horizon >= this.time &&
      horizon < this.executionEnd &&
      this.events.time > horizon
    );
  }
  recordBatch(kind: BatchKind, stage: BatchStage): void {
    const stats = this.batchStats?.[kind];
    if (stats !== undefined) stats[stage]++;
  }
  stageBatchPublication(instance: Instance, kind: BatchKind): void {
    const publications = this.batchPublications;
    if (publications === undefined) return;
    let counts = publications.get(instance);
    if (counts === undefined) publications.set(instance, (counts = { process: 0, jit: 0 }));
    counts[kind]++;
  }
  declineBatch(kind: BatchKind, reason: BatchDecline): undefined {
    const counts = this.batchStats?.[kind].declines;
    if (counts !== undefined) counts[reason] = (counts[reason] ?? 0) + 1;
    return undefined;
  }
  /**
   * Scheduler admission for one already-bound batch. This is a pure gate: every check is
   * performed before the prepared commit may write, and any decline leaves the caller's
   * original position untouched.
   */
  prepareBatch(batch: BoundBatch, schedulerYieldAt?: number): PreparedBatch | undefined {
    const kind = batch.resumeBlock === undefined ? 'jit' : 'process';
    if (kind === 'process') this.recordBatch(kind, 'attempts');
    if (
      !this.batchExecution ||
      this.status !== 'ready' ||
      this.phase !== 'execute' ||
      this.dispatchDepth !== 0 ||
      this.current !== batch.instance ||
      !batch.instance.valid
    )
      return this.declineBatch(kind, 'scheduler');
    if (this.models.length !== 0 || this.readyJits.length !== 0)
      return this.declineBatch(kind, 'ready');
    // A sleeping JIT owns no dispatch before its next timer or dependency write. The
    // timer is part of events.time and the bound plan guards every written slot.
    // Automatically folded polls also have a scheduler-computed boundary.
    for (const waiter of this.waitingJits)
      if (
        (waiter.pollingWait && waiter.pollingPeriod > 0) ||
        !waiter.instance.dependenciesCurrent(waiter.dependencies)
      )
        return this.declineBatch(kind, 'waiter');
    if (this.pendingElectricalSlot !== -1 || this.observations.size !== 0)
      return this.declineBatch(kind, 'publication');
    const nextEventAt = this.events.time;
    if (!(nextEventAt > this.time)) return this.declineBatch(kind, 'window');
    const prepared = batch.prepare(this.time, this.executionEnd, nextEventAt, schedulerYieldAt);
    if (typeof prepared === 'string') return this.declineBatch(kind, prepared);
    this.recordBatch(kind, 'admitted');
    return prepared;
  }
  invalidate(slot: ResourceSlot): void {
    slot.version++;
    this.versionEpoch++;
    this.flagWaiters(slot);
    if (slot.subscribers.size === 0) return;
    for (const observation of slot.subscribers) this.observations.add(observation.order!);
  }
  /** Records a resource version bumped outside :func:`invalidate` (direct JIT writes). */
  noteResourceVersion(slot: ResourceSlot): void {
    this.versionEpoch++;
    this.flagWaiters(slot);
  }
  /** Flags every parked JIT that recorded `slot`, so the next round rescans it exactly once. */
  private flagWaiters(slot: ResourceSlot): void {
    const waiters = slot.waiters;
    if (waiters === undefined || waiters.size === 0) return;
    for (const jit of waiters) jit.dependencyDirty = true;
    this.waiterEpoch++;
  }
  /**
   * Registers a parked JIT on the slots its predicate recorded. A later version bump then
   * flags that JIT directly, so a scheduler round rescans dependencies only when the
   * evidence it would read has actually moved.
   */
  private watchWaiter(jit: Jit): void {
    const dependencies = jit.dependencies;
    if (jit.waiterSlots === dependencies) return;
    const previous = jit.waiterSlots;
    if (previous !== undefined) for (const slot of previous.keys()) slot.waiters?.delete(jit);
    if (dependencies !== undefined)
      for (const slot of dependencies.keys()) (slot.waiters ??= new Set()).add(jit);
    jit.waiterSlots = dependencies;
    // The recorded versions are only proven current by a scan after this registration, so
    // a write in the same round cannot be missed.
    jit.dependencyDirty = true;
  }
  /**
   * Parks a JIT on the versions it just recorded. Registering here instead of in the scan
   * makes `waiterEpoch` a complete wake source: the scan can then be skipped whenever no
   * parked JIT was flagged or registered since the last scan, and no poll is due.
   */
  parkWaiter(jit: Jit): void {
    if (!this.waitingJits.has(jit)) {
      this.waitingJits.add(jit);
      if (jit.pollingWait && jit.pollingPeriod > 0) this.pollingWaiterCount++;
    }
    this.watchWaiter(jit);
    jit.dependencyDirty = true;
    this.waiterEpoch++;
  }
  /** Wakes or drops a parked JIT and removes the registrations that would flag it later. */
  unparkWaiter(jit: Jit): void {
    if (this.waitingJits.delete(jit) && jit.pollingWait) {
      if (jit.pollingPeriod > 0) this.pollingWaiterCount--;
      jit.pollingWait = false;
    }
    const slots = jit.waiterSlots;
    if (slots !== undefined) {
      for (const slot of slots.keys()) slot.waiters?.delete(jit);
      jit.waiterSlots = undefined;
    }
  }
  /**
   * Checkpoint source for cached dependency evidence. An unchanged value since a previous
   * checkpoint proves no resource version moved in between, which is enough to reuse that
   * evidence without scanning it.
   */
  get resourceEpoch(): number {
    return this.versionEpoch;
  }
  /** Pin slot of an electrical endpoint; bound once because the board order is fixed. */
  electricalSlot(pin: ElectricalPin): number {
    return this.electricalSlots.get(pin)!;
  }
  markElectricalDirty(slot: number): void {
    const pending = this.pendingElectricalSlot;
    if (pending === slot) return;
    const stamps = this.dirtyElectricalStamps;
    if (slot >= stamps.length) throw new RangeError('Electrical slot is outside the board');
    const epoch = this.dirtyElectricalEpoch;
    if (stamps[slot] === epoch) return;
    stamps[slot] = epoch;
    if (pending >= 0) {
      // The promoted batch holds the single pending slot first, then this one.
      const list = this.dirtyElectricalSlots;
      list[0] = pending;
      list[1] = slot;
      stamps[pending] = epoch;
      this.dirtyElectricalLength = 2;
      this.pendingElectricalSlot = -2;
      return;
    }
    if (pending === -1) {
      this.pendingElectricalSlot = slot;
      return;
    }
    this.dirtyElectricalSlots[this.dirtyElectricalLength++] = slot;
  }
  /** Dirty slot count for diagnostics, not used by the publication path. */
  get dirtyElectricalCount(): number {
    return this.pendingElectricalSlot >= 0 ? 1 : this.dirtyElectricalLength;
  }
  private publish(): void {
    const pending = this.pendingElectricalSlot;
    if (pending === -1) return;
    // Fused publish: the solver hands every changed slot straight to `publishSlot`, which
    // resolves the pre-bound sample slot without any intermediate result array.
    if (pending >= 0) this.network.solveSlotInto(pending, this.publishSlot);
    else
      this.network.solveSlotBatchInto(
        this.dirtyElectricalSlots,
        this.dirtyElectricalLength,
        this.publishSlot,
      );
    if (pending === -2) this.dirtyElectricalLength = 0;
    // A new epoch retires every stamp, including the single pending slot's own mark.
    if (++this.dirtyElectricalEpoch === 0x7fffffff) {
      this.dirtyElectricalStamps.fill(0);
      this.dirtyElectricalEpoch = 1;
    }
    this.pendingElectricalSlot = -1;
  }
  /** Publication sink: enter the observation queue for one published board slot. */
  private readonly publishSlot = (slot: number): void => {
    this.invalidate(this.sampleSlotsBySlot[slot]!);
  };
  private bindObservation(observation: Receiver, path: readonly string[]): void {
    const instance = observation.instance;
    observation.previous = instance.observe(observation, path);
    observation.readSource = instance.observationReader(observation, path);
    observation.order = this.observations.register(observation);
  }
  /**
   * Static sources whose root is a derived declaration are grouped into one generated
   * chain per (instance, path): the reader, the stable comparator and the dependency
   * slots are bound once at baseline and shared by every receiver. Every other source
   * keeps the generic path.
   */
  private baseline(): void {
    this.publish();
    const entries: {
      observation: Receiver;
      path: readonly string[];
      key: string;
      instance: Instance;
    }[] = [];
    for (const instance of this.instances) {
      const prefix = `${instance.id}\0`;
      for (const process of instance.processes)
        if (
          process.source &&
          instance.declarations.get(process.source[0]!)?.kind !== 'notification'
        )
          entries.push({
            observation: process,
            path: process.source,
            key: prefix + process.source.join('\0'),
            instance,
          });
      for (const reaction of instance.reactions) {
        const path = reaction.declaration.sourcePath;
        entries.push({
          observation: reaction,
          path,
          key: prefix + path.join('\0'),
          instance,
        });
      }
    }
    const groups = new Map<string, ObservationChain | undefined>();
    for (const entry of entries) {
      if (groups.has(entry.key)) continue;
      const compilation = compileObservation(entry.instance, entry.key, entry.path);
      if (!compilation.ok) {
        this.skippedPlans.push({ key: entry.key, reason: compilation.reason });
        groups.set(entry.key, undefined);
        continue;
      }
      const plan = compilation.plan;
      const chain: ObservationChain = {
        plan,
        instance: entry.instance,
        members: [],
        dependencies: new Map(),
        entry: { dependencies: new Map<ResourceSlot, number>(), value: undefined, epoch: -1 },
        order: 0,
        previous: undefined,
        bound: false,
      };
      groups.set(entry.key, chain);
      this.plans.push(chain);
    }
    for (const entry of entries) {
      const chain = groups.get(entry.key);
      if (chain === undefined) {
        this.bindObservation(entry.observation, entry.path);
        continue;
      }
      if (chain.bound) {
        // One queue slot per collapsed receiver keeps unrelated observation indices and
        // the original relative order intact.
        entry.observation.order = this.observations.register(EMPTY_QUEUE_ENTRY);
      } else {
        chain.bound = true;
        chain.order = this.observations.register(chain);
        entry.observation.order = chain.order;
        this.bindChain(chain);
      }
      chain.members.push(entry.observation);
      entry.observation.previous = chain.previous;
    }
  }
  private bindChain(chain: ObservationChain): void {
    const instance = chain.instance;
    for (const slot of chain.plan.slots as readonly ResourceSlot[]) {
      if (!slot.subscribers.size) instance.observerRevision++;
      slot.subscribers.add(chain);
    }
    const value = chain.plan.evaluate();
    chain.previous = chain.plan.needsSnapshot ? snapshot(value) : value;
    this.commitChain(chain, value);
  }
  /** Keep the derived cache populated with the value the chain just computed. */
  private commitChain(chain: ObservationChain, value: unknown): void {
    const path = chain.plan.path;
    if (path.length !== 1) return;
    const slots = chain.plan.slots as readonly ResourceSlot[];
    const dependencies = chain.dependencies;
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      dependencies.set(slot, slot.version);
    }
    const entry = chain.entry;
    if (entry.value !== value) entry.value = value;
    entry.dependencies = dependencies;
    entry.epoch = this.versionEpoch;
    chain.instance.setDerived(path[0]!, entry);
  }
  private collectChain(chain: ObservationChain): void {
    const value = chain.plan.evaluate();
    const current = chain.plan.needsSnapshot ? snapshot(value) : value;
    this.commitChain(chain, value);
    if (chain.plan.equals(chain.previous, current)) return;
    const previous = chain.previous;
    chain.previous = current;
    const members = chain.members;
    const member = members[0]!;
    if (members.length === 1 && !this.changeObservations.length) {
      // A single receiver has the chain's own queue slot, so its order is already the
      // batch position and the effect can be applied without the reordering table.
      member.previous = current;
      this.applyChange(member, previous, current);
      return;
    }
    for (const entry of members) {
      entry.previous = current;
      this.recordChange(entry, previous, current);
    }
  }
  private applyChange(observation: Receiver, previous: unknown, current: unknown): void {
    if (observation.declaration.kind === 'reaction') {
      const reaction = observation as Reaction;
      const frame = reaction.frame as MutableReactionFrame | undefined;
      if (frame === undefined) reaction.frame = { previous, current, captures: [] };
      else {
        frame.previous = previous;
        frame.current = current;
        frame.captures.length = 0;
      }
      this.reactionBatch.push(reaction);
    } else this.enqueue(observation as Process);
  }
  private recordChange(observation: Receiver, previous: unknown, current: unknown): void {
    this.insertOrderedChange(
      this.changeObservations,
      this.changePrevious,
      this.changeCurrent,
      observation,
      previous,
      current,
    );
  }
  /** Shared stable insertion; receivers are few, so in-place insertion beats a sort. */
  private insertOrderedChange(
    receivers: Receiver[],
    previous: unknown[],
    current: unknown[],
    observation: Receiver,
    before: unknown,
    after: unknown,
  ): void {
    let at = receivers.length;
    const order = observation.order!;
    while (at > 0 && receivers[at - 1]!.order! > order) at--;
    if (at === receivers.length) {
      receivers.push(observation);
      previous.push(before);
      current.push(after);
    } else {
      receivers.splice(at, 0, observation);
      previous.splice(at, 0, before);
      current.splice(at, 0, after);
    }
  }
  boundary(source: BoundarySource = 'other'): void {
    const stats = this.boundaryStats;
    if (stats !== undefined) {
      stats.calls++;
      stats.sources[source]++;
    }
    let worked = false;
    for (;;) {
      if (this.pendingElectricalSlot !== -1) {
        if (stats !== undefined) stats.publishes++;
        this.publish();
        worked = true;
      }
      if (!this.observations.size) {
        if (stats !== undefined && !worked) stats.empty++;
        return;
      }
      if (stats !== undefined) stats.batches++;
      worked = true;
      // Truncating a non-empty array clears its elements; an already-empty buffer needs
      // no store at all, which is the common case for the ordering tables.
      const reactions = this.reactionBatch;
      if (reactions.length) reactions.length = 0;
      const changes = this.changeObservations;
      if (changes.length) changes.length = 0;
      if (this.changePrevious.length) this.changePrevious.length = 0;
      if (this.changeCurrent.length) this.changeCurrent.length = 0;
      this.observations.drain(this.consumeObservation);
      const count = changes.length;
      if (count) {
        for (let index = 0; index < count; index++)
          this.applyChange(changes[index]!, this.changePrevious[index], this.changeCurrent[index]);
        changes.length = 0;
        this.changePrevious.length = 0;
        this.changeCurrent.length = 0;
      }
      if (reactions.length) {
        if (stats !== undefined) stats.reactions += reactions.length;
        this.runBoundaryReactions(reactions);
      } else return;
    }
  }
  /** One due receiver: chains collapse their members, plain sources apply inline. */
  private readonly consumeObservation = (observation: Observation): void => {
    if ('plan' in observation) {
      this.collectChain(observation);
      return;
    }
    const current = observation.readSource!();
    if (same(observation.previous, current)) return;
    const previous = observation.previous;
    observation.previous = current;
    // Once a collapsed chain buffered its receivers, later effects must wait for the
    // ordered table; otherwise the original inline application is kept.
    if (this.changeObservations.length) this.recordChange(observation, previous, current);
    else this.applyChange(observation, previous, current);
  };
  /** Shared capture barrier and ordered body runner for generic and static boundaries. */
  private runBoundaryReactions(reactions: Reaction[]): void {
    try {
      const stats = this.boundaryStats;
      // Every instance completes observation and capture before any reaction body runs.
      for (const reaction of reactions)
        if (reaction.declaration.captures.length) {
          if (stats !== undefined) stats.captures += reaction.declaration.captures.length;
          const frame = reaction.frame as MutableReactionFrame;
          frame.captures = reaction.declaration.captures.map((capture) =>
            snapshot(computation(capture.value, reaction.instance.host)),
          );
        }
      for (const reaction of reactions) {
        this.current = reaction.instance;
        this.runReaction(reaction);
      }
    } finally {
      this.clearReactionFrames(reactions);
    }
  }
  private clearReactionFrames(reactions: Reaction[]): void {
    for (const reaction of reactions) {
      const frame = reaction.frame as MutableReactionFrame | undefined;
      if (frame === undefined) continue;
      frame.previous = undefined;
      frame.current = undefined;
      frame.captures.length = 0;
    }
  }
  /**
   * Execute one synchronous boundary reaction. The capture barrier already froze every
   * frame before this method runs. Admission is whole-body: a compiler decline selects
   * the generator path before any effect, while bind/execution errors propagate without
   * a catch-and-replay fallback.
   */
  private runReaction(reaction: Reaction): void {
    const instance = reaction.instance;
    let program = reaction.synchronousProgram;
    if (program === undefined) {
      program = synchronousBody(instance, reaction.declaration.body) ?? null;
      reaction.synchronousProgram = program;
    }
    if (program !== null) {
      let runner = reaction.synchronous;
      if (runner === undefined || runner === null) {
        runner = program.bind(instance.host);
        reaction.synchronous = runner;
      }
      runner(undefined, reaction.frame);
      return;
    }
    reaction.execute ??= body(reaction.declaration.body);
    const step = reaction.execute(instance.host, [], reaction.frame).next();
    if (!step.done) throw new TypeError('Reaction cannot suspend');
  }
  private drive(process: Process, value?: unknown): void {
    const program = process.resumable;
    if (program) {
      const batch = process.batch;
      if (batch !== undefined) {
        // Set the current instance at the same point the ordinary resumable path does,
        // so a decline can fall through without restoring any scheduler state.
        this.current = process.instance;
        if (this.tryProcessBatch(process, program, batch)) return;
      }
      this.driveResumable(process, program, value);
      return;
    }
    this.current = process.instance;
    process.state = 'running';
    process.execution ??= body(process.declaration.body)(process.instance.host);
    for (;;) {
      const step = process.execution.next(value);
      if (step.done) {
        this.boundary('process');
        process.execution = undefined;
        process.state = 'idle';
        if (process.pending) {
          process.pending = false;
          this.enqueue(process);
        }
        return;
      }
      const signal = step.value;
      if (signal.kind === 'receive') {
        const channel = process.instance.channels.get(signal.channel)!;
        if (channel.incoming.length) {
          value = channel.incoming.shift().value;
          continue;
        }
        process.state = 'waiting';
        channel.receiver = process;
        this.boundary('process');
        return;
      }
      if (signal.kind !== 'ticks') throw new TypeError('Invalid process suspension');
      const duration = time(signal.duration),
        due = time(this.time + duration);
      process.state = 'waiting';
      this.boundary('process');
      if (duration === 0) {
        process.state = 'queued';
        this.models.push(process);
      } else {
        // The continuation is bound once per process: only one timed wake can be pending.
        process.wake ??= () => {
          process.state = 'queued';
          this.models.push(process);
        };
        this.events.push(due, process.wake);
      }
      return;
    }
  }
  /**
   * Try the optional per-process binding before running the machine. A process without a
   * registration only pays one missing-property check; a decline never touches its frame,
   * pc, time or queues.
   */
  private tryProcessBatch(
    process: Process,
    program: ResumableProgram,
    bindings: readonly BoundBatch[],
  ): boolean {
    const frame = process.frame;
    if (frame === undefined || frame.pc === program.start || frame.kind !== RESUMABLE_TICKS)
      return false;
    let prepared: PreparedBatch | undefined;
    for (const batch of bindings) {
      if (batch.resumeBlock !== frame.pc) continue;
      prepared = this.prepareBatch(batch);
      if (prepared !== undefined) break;
    }
    if (prepared === undefined) return false;
    // Allocate the one wake closure before any write, then commit bytes and the counter.
    const wake = (process.wake ??= () => {
      process.state = 'queued';
      this.models.push(process);
    });
    this.time = prepared.lastAt;
    this.recordBatch('process', 'executed');
    prepared.apply();
    this.recordBatch('process', 'committed');
    // A folded ticks resume behaves like the ordinary path's transient frame state; live
    // slots stay exact because the resume block reloads them itself.
    frame.value = undefined;
    process.state = 'waiting';
    this.boundary('process');
    this.stageBatchPublication(process.instance, 'process');
    this.events.push(prepared.due, wake);
    return true;
  }
  /**
   * Same suspension contract as `drive`, driven by the body's own pc and reused frame:
   * the body reports ticks/receive through the frame and returns whether it suspended.
   */
  private driveResumable(process: Process, program: ResumableProgram, value?: unknown): void {
    const instance = process.instance;
    this.current = instance;
    process.state = 'running';
    const state = (process.frame ??= frame(program));
    const host = instance.host;
    let input = value;
    for (;;) {
      state.value = input;
      if (!program.run(host, undefined, undefined, state)) {
        this.boundary('process');
        process.state = 'idle';
        if (process.pending) {
          process.pending = false;
          this.enqueue(process);
        }
        return;
      }
      if (state.kind === RESUMABLE_RECEIVE) {
        const channel = instance.channels.get(state.channel)!;
        if (channel.incoming.length) {
          input = channel.incoming.shift().value;
          continue;
        }
        process.state = 'waiting';
        channel.receiver = process;
        this.boundary('process');
        return;
      }
      // The body already validated the duration with H.checkDuration; only the sum needs
      // the shared range check.
      const duration = state.duration,
        due = time(this.time + duration);
      process.state = 'waiting';
      this.boundary('process');
      if (duration === 0) {
        process.state = 'queued';
        this.models.push(process);
      } else {
        process.wake ??= () => {
          process.state = 'queued';
          this.models.push(process);
        };
        this.events.push(due, process.wake);
      }
      return;
    }
  }
  runUntil(target: number): void {
    this.assertAlive();
    if (this.phase !== 'idle' || this.dispatchDepth)
      throw this.error('INVALID_CALL_STATE', 'Board is busy');
    if (this.status === 'faulted') throw this.error('BOARD_FAULTED', 'Board is faulted');
    const end = time(target);
    if (end < this.time) throw new RangeError('Cannot run backwards');
    const from = this.time;
    this.phase = 'execute';
    this.executionEnd = end;
    try {
      if (!this.initialized) {
        this.baseline();
        this.initialized = true;
        for (const instance of this.instances)
          for (const process of instance.processes)
            if (process.declaration.kind === 'start') this.enqueue(process);
        for (const jit of this.jits) this.queueJit(jit);
      }
      for (const instance of this.instances) {
        for (const channel of instance.channels.values()) {
          if (channel.pending.length)
            for (const message of channel.pending.drain()) channel.incoming.push(message);
          if (channel.receiver && channel.incoming.length) {
            const process = channel.receiver;
            channel.receiver = undefined;
            const received = channel.incoming.shift()!.value;
            this.events.push(this.time, () => {
              process.state = 'queued';
              process.resumeValue = received;
              this.models.push(process);
            });
          }
        }
        for (const notification of instance.notificationInputs)
          for (const process of instance.processes)
            if (process.source?.[0] === notification) this.enqueue(process);
        instance.notificationInputs.clear();
      }
      // A parked JIT records the versions it read, so it can only become runnable once one
      // of those slots is invalidated; the wait set binds exactly that dependency set, and a
      // periodic poll still needs its boundary recomputed on every round. Both facts are
      // counted in `waiterEpoch` / `pollingWaiterCount`, so a round where neither moved
      // skips the scan entirely with `pollingBoundary` left at Infinity.
      for (;;) {
        while (this.events.time === this.time) this.events.pop()();
        if (this.models.length) {
          const process = this.models.shift()!;
          const value = process.resumeValue;
          process.resumeValue = undefined;
          this.drive(process, value);
          if (this.isFaulted) throw this.primary!;
          continue;
        }
        let pollingBoundary = Infinity;
        if (
          this.waitingJits.size &&
          (this.waiterEpoch !== this.waitingScanEpoch || this.pollingWaiterCount !== 0)
        ) {
          this.waitingScanEpoch = this.waiterEpoch;
          for (let index = 0; index < this.jits.length; index++) {
            const jit = this.jits[index]!;
            if (!jit.active || jit.stopped || !this.waitingJits.has(jit)) continue;
            this.watchWaiter(jit);
            const periodic = jit.pollingWait && jit.pollingPeriod > 0;
            if (!jit.dependencyDirty && !periodic) continue;
            if (jit.instance.dependenciesCurrent(jit.dependencies)) {
              jit.dependencyDirty = false;
              if (periodic) {
                const lastStart = MAX_TIME - ((MAX_TIME - jit.pollingOrigin) % jit.pollingPeriod);
                if (lastStart < MAX_TIME && lastStart < end) {
                  if (lastStart === this.time) {
                    jit.pollingToken++;
                    delete jit.dependencies;
                    this.unparkWaiter(jit);
                    this.queueJit(jit);
                  } else pollingBoundary = Math.min(pollingBoundary, lastStart);
                }
              }
              continue;
            }
            jit.dependencyDirty = false;
            if (jit.pollingReservation !== undefined) {
              cancelPollingReservation(this, jit);
            } else if (jit.pollingWait) {
              jit.pollingToken++;
              delete jit.dependencies;
              this.unparkWaiter(jit);
              const remainder =
                jit.pollingPeriod > 0 ? (this.time - jit.pollingOrigin) % jit.pollingPeriod : 0;
              if (remainder)
                this.events.push(time(this.time + (jit.pollingPeriod - remainder)), () =>
                  this.queueJit(jit),
                );
              else this.queueJit(jit);
            } else if (jit.predicate) {
              const checked = jit.instance.evaluate(() => syncJitCall(jit, jit.predicate!));
              jit.dependencies = checked.dependencies;
              if (checked.value === true) {
                delete jit.predicate;
                delete jit.dependencies;
                this.unparkWaiter(jit);
                this.queueJit(jit);
              } else {
                // The replaced dependency set is re-registered and needs its own scan.
                this.watchWaiter(jit);
                this.waiterEpoch++;
              }
            }
          }
        }
        if (this.time < end && this.readyJits.length) {
          runJit(this, this.readyJits.shift());
          if (this.isFaulted) throw this.primary!;
          continue;
        }
        if (pollingBoundary < this.events.time && pollingBoundary <= end) {
          this.time = pollingBoundary;
          continue;
        }
        const next = this.events.time;
        if (next <= end) {
          this.time = next;
          // The next round would only drain these events at the top of the loop; doing it
          // here saves one scheduler round per due event and observes the same order
          // (callbacks still run before the model queue is served).
          while (this.events.time === this.time) this.events.pop()();
          continue;
        }
        this.time = end;
        break;
      }
      const batches = this.instances.map((instance) => instance.captureBatch(from, end));
      this.phase = 'sync';
      for (let i = 0; i < this.instances.length; i++) {
        const instance = this.instances[i]!;
        this.current = instance;
        try {
          acceptSync(instance.adapter!.sync(batches[i]!));
        } catch (cause) {
          throw this.wrap(cause, 'DEVICE_CALLBACK_FAILED', 'sync', instance);
        }
        if (this.isFaulted) throw this.primary!;
        const published = this.batchPublications?.get(instance);
        if (published !== undefined) {
          this.batchStats!.process.published += published.process;
          this.batchStats!.jit.published += published.jit;
          this.batchPublications!.delete(instance);
        }
      }
    } catch (cause) {
      const error = this.wrap(
        cause,
        'MODEL_EXECUTION_FAILED',
        this.phase === 'sync' ? 'sync' : 'execute',
        this.current,
      );
      this.fault(error);
      throw error;
    } finally {
      this.current = undefined;
      this.phase = 'idle';
    }
  }
  dispose(): void {
    if (this.status === 'disposed') return;
    if (this.phase !== 'idle' || this.dispatchDepth)
      throw this.error('INVALID_CALL_STATE', 'Board is busy');
    const errors = this.cleanup();
    if (errors.length)
      throw this.primary
        ? this.aggregate(this.primary, errors)
        : this.aggregate(errors[0]!, errors.slice(1));
  }
  private aggregate(primary: SimulationError, errors: readonly SimulationError[]): SimulationError {
    return new SimulationError(
      Object.freeze({
        ...primary.diagnostic,
        related: Object.freeze([...primary.related, ...errors.map((error) => error.diagnostic)]),
      }),
    );
  }
  private cleanup(): SimulationError[] {
    this.phase = 'dispose';
    for (const instance of this.instances) instance.valid = false;
    const errors: SimulationError[] = [];
    for (const instance of [...this.instances].reverse()) {
      if (instance.adapter) {
        try {
          acceptSync(instance.adapter.dispose());
        } catch (cause) {
          errors.push(this.wrap(cause, 'CLEANUP_FAILED', 'dispose', instance));
        }
      }
      for (const resource of [...instance.resources].reverse()) {
        try {
          resource.dispose();
        } catch (cause) {
          errors.push(this.wrap(cause, 'CLEANUP_FAILED', 'dispose', instance));
        }
      }
      instance.resources.length = 0;
    }
    this.events.clear();
    this.batchPublications?.clear();
    this.models.clear();
    this.readyJits.clear();
    this.observations.clear();
    this.reactionBatch.length = 0;
    this.plans.length = 0;
    this.skippedPlans.length = 0;
    this.changeObservations.length = 0;
    this.changePrevious.length = 0;
    this.changeCurrent.length = 0;
    this.sampleSlots.clear();
    this.listeners.clear();
    this.hostListeners = 0;
    this.errors.dispose();
    this.diagnostics.dispose();
    this.status = 'disposed';
    this.phase = 'idle';
    return errors;
  }
}
export function createBoard(
  library: DeviceLibrary,
  description: BoardDescription,
  options?: BoardOptions,
): Board {
  const entries = libraries.get(library);
  if (!entries)
    throw standalone('INVALID_CONFIGURATION', new TypeError('Unknown device library'), 'assembly');
  if (arguments.length >= 3 && options === undefined)
    throw standalone(
      'INVALID_CONFIGURATION',
      new TypeError('Explicit undefined options'),
      'assembly',
    );
  return new BoardRuntime(entries, description, options ?? {});
}
