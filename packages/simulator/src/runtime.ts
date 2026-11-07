import { Emitter, type Event, type Disposable } from '@mica-js/core/lifecycle';
import { BuildError, validateDeviceIR, type DeviceIR } from '@mica-js/device-model';
import { RESUMABLE_RECEIVE, type ResumableProgram } from '@mica-js/compiler';
import {
  createElectricalNetwork,
  ElectricalError,
  type ElectricalPin,
  type ElectricalNetwork,
} from './electrical';
import { ActivationQueue, EventQueue, Fifo } from './queue';
import { compileObservation } from './observations';
import { Instance } from './runtime/instance';
import { runJit } from './runtime/jit';
import { body, computation, frame, MAX_TIME, time } from './runtime/execution';
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

class BoardRuntime implements Board {
  time = 0;
  status: BoardStatus = 'ready';
  phase = 'assembly';
  current: Instance | undefined;
  electricalDirty = true;
  /** Dirty electrical slots: the publish plan maps them straight onto sample slots. */
  readonly dirtyElectricalSlots = new Set<number>();
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
  private readonly models = new Fifo<Process>();
  readonly events = new EventQueue<() => void>();
  private readonly readyJits = new Fifo<Jit>();
  readonly waitingJits = new Set<Jit>();
  readonly jits: Jit[] = [];
  readonly instances: Instance[] = [];
  private network!: ElectricalNetwork;
  private primary: SimulationError | undefined;
  readonly execution: 'throughput' | 'precise';
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
      dataObject(options, ['seed', 'execution', 'cpuQuantum']);
      const execution = Object.hasOwn(options, 'execution') ? options.execution : 'throughput';
      if (execution !== 'throughput' && execution !== 'precise')
        throw new TypeError('Invalid execution mode');
      this.execution = execution;
      const cpuQuantum = Object.hasOwn(options, 'cpuQuantum')
        ? integer(options.cpuQuantum, 'cpuQuantum')
        : 10_000_000;
      if (cpuQuantum < 1 || cpuQuantum > 10_000_000)
        throw new RangeError('cpuQuantum outside [1, 10000000]');
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
    for (const instance of this.instances)
      for (const process of instance.processes) {
        const key = `${instance.id}/${process.declaration.kind === 'on' ? process.declaration.name : 'start'}`;
        (process.resumable ? resumable : generic).push(key);
      }
    return Object.freeze({
      resumable: Object.freeze(resumable),
      generic: Object.freeze(generic),
      bindings: Object.freeze(this.instances.map((instance) => instance.bindingReport())),
    });
  }
  validity(instance?: Instance): void {
    if (this.status === 'disposed' || (instance && !instance.valid))
      throw this.error('OBJECT_DISPOSED', 'Object is disposed', instance);
  }
  guard(instance?: Instance, readOnly = false): void {
    this.validity(instance);
    if (instance && ['execute', 'translate', 'dispose', 'assembly'].includes(this.phase))
      throw this.error('INVALID_CALL_STATE', 'Operation is not allowed in this phase', instance);
    if (!readOnly && this.status === 'faulted')
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
    return Object.freeze({
      onDidReceive: ((
        listener: (message: TopicMessage) => unknown,
        thisArgs?: unknown,
        disposables?: Disposable[],
      ) => {
        this.guard(owner);
        const entry: TopicListener = {
          ...(owner ? { owner } : {}),
          call: (message) => listener.call(thisArgs, message),
        };
        this.listeners.add(entry);
        let active = true;
        const disposable = {
          dispose: () => {
            if (active) {
              active = false;
              this.listeners.delete(entry);
            }
          },
        };
        disposables?.push(disposable);
        owner?.resources.push(disposable);
        return disposable;
      }) as Event<TopicMessage>,
      publish: (topic: string, payload: unknown) => {
        this.guard(owner);
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
  invalidate(slot: ResourceSlot): void {
    slot.version++;
    if (slot.subscribers.size === 0) return;
    for (const observation of slot.subscribers) this.observations.add(observation.order!);
  }
  /** Pin slot of an electrical endpoint; bound once because the board order is fixed. */
  electricalSlot(pin: ElectricalPin): number {
    return this.electricalSlots.get(pin)!;
  }
  private publish(): void {
    if (!this.electricalDirty) return;
    // Fused publish: dirty slots go straight into the local solve and the changed slots
    // resolve their pre-bound sample slot, so no pin object or map hop is involved.
    const changed = this.network.solveSlots(this.dirtyElectricalSlots);
    this.dirtyElectricalSlots.clear();
    this.electricalDirty = false;
    for (let index = 0; index < changed.length; index++)
      this.invalidate(this.sampleSlotsBySlot[changed[index]!]!);
  }
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
        entry: { dependencies: new Map<ResourceSlot, number>(), value: undefined },
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
    for (const slot of chain.plan.slots as readonly ResourceSlot[])
      chain.dependencies.set(slot, slot.version);
    const entry = chain.entry;
    if (entry.value !== value) entry.value = value;
    entry.dependencies = chain.dependencies;
    const cached = chain.instance.derived.get(path[0]!);
    if (cached !== entry) chain.instance.derived.set(path[0]!, entry);
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
      reaction.frame = { previous, current, captures: [] };
      this.reactionBatch.push(reaction);
    } else this.enqueue(observation as Process);
  }
  private recordChange(observation: Receiver, previous: unknown, current: unknown): void {
    const list = this.changeObservations;
    let at = list.length;
    const order = observation.order!;
    while (at > 0 && list[at - 1]!.order! > order) at--;
    if (at === list.length) {
      list.push(observation);
      this.changePrevious.push(previous);
      this.changeCurrent.push(current);
    } else {
      list.splice(at, 0, observation);
      this.changePrevious.splice(at, 0, previous);
      this.changeCurrent.splice(at, 0, current);
    }
  }
  boundary(): void {
    for (;;) {
      this.publish();
      if (!this.observations.size) return;
      const reactions = this.reactionBatch;
      reactions.length = 0;
      const changes = this.changeObservations;
      changes.length = 0;
      this.changePrevious.length = 0;
      this.changeCurrent.length = 0;
      try {
        const batch = this.observations.take();
        for (let index = 0; index < batch.length; index++) {
          const observation = batch[index]!;
          if ('plan' in observation) {
            this.collectChain(observation);
            continue;
          }
          const current = observation.readSource!();
          if (same(observation.previous, current)) continue;
          const previous = observation.previous;
          observation.previous = current;
          // Once a collapsed chain buffered its receivers, later effects must wait for
          // the ordered table; otherwise the original inline application is kept.
          if (changes.length) this.recordChange(observation, previous, current);
          else this.applyChange(observation, previous, current);
        }
        const count = changes.length;
        if (count) {
          for (let index = 0; index < count; index++)
            this.applyChange(
              changes[index]!,
              this.changePrevious[index],
              this.changeCurrent[index],
            );
          changes.length = 0;
          this.changePrevious.length = 0;
          this.changeCurrent.length = 0;
        }
        if (!reactions.length) return;
        // Every instance completes observation and capture before any reaction body runs.
        for (const reaction of reactions)
          if (reaction.declaration.captures.length)
            reaction.frame = {
              ...reaction.frame!,
              captures: reaction.declaration.captures.map((capture) =>
                snapshot(computation(capture.value, reaction.instance.host)),
              ),
            };
        for (const reaction of reactions) {
          this.current = reaction.instance;
          reaction.execute ??= body(reaction.declaration.body);
          const step = reaction.execute(reaction.instance.host, [], reaction.frame).next();
          if (!step.done) throw new TypeError('Reaction cannot suspend');
        }
      } finally {
        for (const reaction of reactions) reaction.frame = undefined;
      }
    }
  }
  private drive(process: Process, value?: unknown): void {
    const program = process.resumable;
    if (program) {
      this.driveResumable(process, program, value);
      return;
    }
    this.current = process.instance;
    process.state = 'running';
    process.execution ??= body(process.declaration.body)(process.instance.host);
    for (;;) {
      const step = process.execution.next(value);
      if (step.done) {
        this.boundary();
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
        this.boundary();
        return;
      }
      if (signal.kind !== 'ticks') throw new TypeError('Invalid process suspension');
      const duration = time(signal.duration),
        due = time(this.time + duration);
      process.state = 'waiting';
      this.boundary();
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
   * Same suspension contract as `drive`, driven by the body's own pc and reused frame:
   * the body reports ticks/receive through the frame and returns whether it suspended.
   */
  private driveResumable(process: Process, program: ResumableProgram, value?: unknown): void {
    this.current = process.instance;
    process.state = 'running';
    const state = (process.frame ??= frame(program));
    let input = value;
    for (;;) {
      state.value = input;
      if (!program.run(process.instance.host, undefined, undefined, state)) {
        this.boundary();
        process.state = 'idle';
        if (process.pending) {
          process.pending = false;
          this.enqueue(process);
        }
        return;
      }
      if (state.kind === RESUMABLE_RECEIVE) {
        const channel = process.instance.channels.get(state.channel)!;
        if (channel.incoming.length) {
          input = channel.incoming.shift().value;
          continue;
        }
        process.state = 'waiting';
        channel.receiver = process;
        this.boundary();
        return;
      }
      // The body already validated the duration with H.checkDuration; only the sum needs
      // the shared range check.
      const duration = state.duration,
        due = time(this.time + duration);
      process.state = 'waiting';
      this.boundary();
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
    this.validity();
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
        if (this.waitingJits.size)
          for (let index = 0; index < this.jits.length; index++) {
            const jit = this.jits[index]!;
            if (!jit.active || jit.stopped || !this.waitingJits.has(jit)) continue;
            if (jit.instance.dependenciesCurrent(jit.dependencies)) {
              if (jit.pollingWait && jit.pollingPeriod > 0) {
                const lastStart = MAX_TIME - ((MAX_TIME - jit.pollingOrigin) % jit.pollingPeriod);
                if (lastStart < MAX_TIME && lastStart < end) {
                  if (lastStart === this.time) {
                    jit.pollingWait = false;
                    delete jit.dependencies;
                    this.waitingJits.delete(jit);
                    this.queueJit(jit);
                  } else pollingBoundary = Math.min(pollingBoundary, lastStart);
                }
              }
              continue;
            }
            if (jit.pollingWait) {
              jit.pollingWait = false;
              delete jit.dependencies;
              this.waitingJits.delete(jit);
              const remainder =
                jit.pollingPeriod > 0 ? (this.time - jit.pollingOrigin) % jit.pollingPeriod : 0;
              if (remainder)
                this.events.push(time(this.time + (jit.pollingPeriod - remainder)), () =>
                  this.queueJit(jit),
                );
              else this.queueJit(jit);
            } else if (jit.predicate) {
              const checked = jit.instance.evaluate(() => jit.instance.syncCall(jit.predicate!));
              jit.dependencies = checked.dependencies;
              if (checked.value === true) {
                delete jit.predicate;
                delete jit.dependencies;
                this.waitingJits.delete(jit);
                this.queueJit(jit);
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
        if (this.events.time <= end) {
          this.time = this.events.time;
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
