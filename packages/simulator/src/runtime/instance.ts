import type { Disposable } from '@mica-js/core/lifecycle';
import type { DeclarationIR } from '@mica-js/device-model';
import type { ExecutionHost, ResourceHandle } from '@mica-js/compiler';
import type { ElectricalPin, ResistorBranch } from '../electrical';
import { Fifo } from '../queue';
import { body, computation, resumable } from './execution';
import { electricalNumber, ElectricalParameterError } from './errors';
import type {
  Channel,
  Decl,
  Dependencies,
  Entry,
  Execution,
  Jit,
  Observation,
  Process,
  Reaction,
  ResourceSlot,
} from './state';
import {
  bytesView,
  captureValue,
  dataObject,
  externalValue,
  finite,
  identity,
  integer,
  nonnegative,
  nextRandom,
  randomState,
  range,
  snapshot,
} from '../values';
import type {
  DeviceAdapter,
  DeviceBatch,
  DeviceContext,
  JitOptions,
  RuntimeDiagnosticCode,
  RuntimePhase,
  SimulationError,
  TopicBridge,
} from '../types';

/** Board capabilities used by an instance; the board owns scheduling and publication. */
export interface InstanceBoard {
  readonly time: number;
  readonly phase: string;
  readonly current: Instance | undefined;
  electricalDirty: boolean;
  readonly dirtyElectricalSlots: Set<number>;
  readonly jits: Jit[];
  readonly waitingJits: Set<Jit>;
  assertAlive(instance?: Instance): void;
  /** Admission for a call that may change board state or is visible to a device. */
  assertCallAllowed(instance?: Instance): void;
  /** Admission for a read-only entry point: a faulted board stays inspectable. */
  assertReadAllowed(instance?: Instance): void;
  error(
    code: RuntimeDiagnosticCode,
    message: string,
    instance?: Instance,
    cause?: unknown,
    phase?: RuntimePhase,
  ): SimulationError;
  fault(error: SimulationError): void;
  report(instance: Instance, cause: unknown): void;
  topicBridge(owner?: Instance): TopicBridge;
  electricalSlot(pin: ElectricalPin): number;
  invalidate(slot: ResourceSlot): void;
}

const EMPTY_MESSAGES: readonly never[] = Object.freeze([]);

/** Membership test without allocating: every key of `next` is already in `previous`. */
function hasEvery(
  previous: ReadonlyMap<ResourceSlot, number>,
  next: ReadonlyMap<ResourceSlot, number>,
): boolean {
  for (const slot of next.keys()) if (!previous.has(slot)) return false;
  return true;
}
function createContext(owner: Instance, board: InstanceBoard): DeviceContext {
  return Object.freeze({
    get props() {
      board.assertReadAllowed(owner);
      return Object.freeze(
        Object.fromEntries([...owner.props].map(([key, value]) => [key, externalValue(value)])),
      );
    },
    get inputs() {
      owner.assertCallAllowed();
      return owner.inputs();
    },
    get memory() {
      board.assertReadAllowed(owner);
      return owner.publicMemory();
    },
    topics: board.topicBridge(owner),
    reportError: (error: unknown) => board.report(owner, error),
    attachJit: (options: JitOptions) => owner.attach(options),
    loadBytes: (name: string, bytes: Uint8Array, ...offset: unknown[]) =>
      owner.loadBytes(name, bytes, offset.length ? offset[0] : 0),
  });
}

export class Instance {
  readonly declarations = new Map<string, DeclarationIR>();
  readonly props = new Map<string, unknown>();
  readonly constants = new Map<string, unknown>();
  readonly states = new Map<string, unknown>();
  readonly memories = new Map<string, Uint8Array>();
  private readonly memoryViews = new Map<string, DataView>();
  private readonly memorySizes = new Map<string, number>();
  readonly pins = new Map<string, ElectricalPin>();
  readonly channels = new Map<string, Channel>();
  readonly notificationInputs = new Set<string>();
  readonly notificationOutputs = new Map<string, number | null>();
  private readonly batchInputs: Channel[] = [];
  private readonly batchOutputs: (readonly [string, Channel])[] = [];
  private readonly batchNotifications: string[] = [];
  private readonly emptyOutputs: Record<string, unknown> = Object.create(null);
  readonly resources: Disposable[] = [];
  readonly jits: Jit[] = [];
  readonly processes: Process[] = [];
  readonly reactions: Reaction[] = [];
  readonly derived = new Map<string, { dependencies: Dependencies; value: unknown }>();
  private readonly derivedBuffers = new Map<string, Map<ResourceSlot, number>>();
  readonly stateResources = new Map<string, ResourceSlot>();
  readonly memoryResources = new Map<string, ResourceSlot>();
  readonly sampleResources = new Map<string, ResourceSlot>();
  observerRevision = 0;
  private readonly dependencyStack: Map<ResourceSlot, number>[] = [];
  private readonly observations = new WeakMap<Observation, Dependencies>();
  private readonly staticObservations = new WeakMap<Observation, () => unknown>();
  private readonly resistorIntents = new Map<string, Map<number, readonly ResistorBranch[]>>();
  private readonly sampleEntries = new Map<string, { pin: ElectricalPin; slot: ResourceSlot }>();
  private readonly stateSlots = new Map<string, ResourceSlot>();
  /** Per-instance handles for the fixed resources a resumable process body binds. */
  private readonly resourceHandles = new Map<string, ResourceHandle>();
  private readonly memoryPlans = new Map<
    string,
    { name: string; bytes: Uint8Array; view: DataView; slot: ResourceSlot }
  >();
  private readonly observationFrames = new WeakMap<
    Observation,
    { first: Map<ResourceSlot, number>; second: Map<ResourceSlot, number>; alternate: boolean }
  >();
  readonly evaluating = new Set<string>();
  readonly random: Uint32Array;
  readonly host: ExecutionHost;
  readonly context: DeviceContext;
  adapter?: DeviceAdapter;
  valid = true;
  rawProps: Record<string, unknown>;
  constructor(
    readonly board: InstanceBoard,
    readonly entry: Entry,
    readonly id: string,
    props: unknown,
    seed: number,
    override?: readonly number[],
  ) {
    for (const declaration of entry.model.declarations) {
      if ('name' in declaration) this.declarations.set(declaration.name, declaration);
      if (
        declaration.kind === 'state' ||
        declaration.kind === 'memory' ||
        declaration.kind === 'pin'
      ) {
        const resources =
          declaration.kind === 'state'
            ? this.stateResources
            : declaration.kind === 'memory'
              ? this.memoryResources
              : this.sampleResources;
        resources.set(declaration.name, { version: 0, subscribers: new Set() });
      }
    }
    dataObject(props);
    this.rawProps = props;
    for (const key of Object.keys(props))
      if (this.declarations.get(key)?.kind !== 'property')
        throw new TypeError(`Unknown property ${key}`);
    this.random = randomState(seed, id, override);
    this.host = {
      read: (kind, name) => this.read(kind, name),
      write: (name, value) => {
        const slot = this.stateSlot(name);
        this.states.set(name, snapshot(value));
        this.board.invalidate(slot);
      },
      sample: (ref) => {
        return this.readSample(ref);
      },
      intent: (pin, value) => {
        const target = this.pin(pin);
        // Reassigning the same immutable intent value is already the current contribution.
        if (target.intent === value) return;
        target.intent = value as readonly ResistorBranch[];
        board.dirtyElectricalSlots.add(board.electricalSlot(target));
        board.electricalDirty = true;
      },
      resistor: (pin, resistance) => {
        const r = electricalNumber(resistance);
        if (r < 0.001 || r > 1e9)
          throw new ElectricalParameterError('Resistance outside [0.001, 1e9]');
        return this.resistorIntent(pin, r);
      },
      memoryLength: (memory) => this.memory(memory).length,
      load: (kind, memory, offset) => {
        const plan = this.memoryPlan(memory);
        const size = kind.startsWith('load8') ? 1 : kind.startsWith('load16') ? 2 : 4;
        const at = range(plan.bytes, offset, size);
        const dependencies = this.dependencyStack.at(-1);
        if (dependencies) dependencies.set(plan.slot, plan.slot.version);
        if (size === 1) return plan.bytes[at]!;
        return size === 2
          ? plan.view.getUint16(at, kind.endsWith('le'))
          : plan.view.getUint32(at, kind.endsWith('le'));
      },
      store: (kind, memory, offset, value) => {
        const plan = this.memoryPlan(memory);
        const size = kind.startsWith('store8') ? 1 : kind.startsWith('store16') ? 2 : 4;
        const at = range(plan.bytes, offset, size);
        const n = integer(value, 'stored value');
        if (size === 1) plan.bytes[at] = n;
        else if (size === 2) plan.view.setUint16(at, n, kind.endsWith('le'));
        else plan.view.setUint32(at, n, kind.endsWith('le'));
        this.memoryChangedPlan(plan);
      },
      copyBytes: (memory, offset, length) => {
        this.track(this.memoryResources, String(memory));
        const bytes = this.memory(memory),
          at = range(bytes, offset, length);
        return bytes.slice(at, at + Number(length));
      },
      send: (name, value) => this.send(name, value, false),
      notify: (name) => {
        if (!this.notificationOutputs.has(name))
          throw new TypeError(`Unknown notification ${name}`);
        this.notificationOutputs.set(name, board.time);
      },
      now: () => board.time,
      random: () => nextRandom(this.random),
      call: (name, args) => this.invoke(name, args),
      assert: (condition, message) => {
        if (condition !== true)
          throw new Error(message === undefined ? 'Assertion failed' : String(message));
      },
      bind: (specs) => this.bindResources(specs),
    };
    this.context = createContext(this, board);
  }
  private track(resources: ReadonlyMap<string, ResourceSlot>, name: string): void {
    this.trackSlot(resources.get(name)!);
  }
  private trackSlot(slot: ResourceSlot): void {
    const dependencies = this.dependencyStack.at(-1);
    if (dependencies) dependencies.set(slot, slot.version);
  }
  /** Read-only evidence that a process frame bound per-instance resource handles. */
  bindingReport(): unknown {
    return Object.freeze({
      instance: this.id,
      handles: this.resourceHandles.size,
      bound: Object.freeze([...this.resourceHandles.keys()].sort()),
      processes: Object.freeze(
        this.processes.map((process) =>
          Object.freeze({
            name: process.declaration.kind === 'on' ? process.declaration.name : 'start',
            bound: process.frame?.resources?.length ?? 0,
          }),
        ),
      ),
    });
  }
  dependenciesCurrent(dependencies: Dependencies | undefined): boolean {
    if (!dependencies) return false;
    for (const [slot, version] of dependencies) if (slot.version !== version) return false;
    return true;
  }
  evaluate<T>(
    compute: () => T,
    target?: Map<ResourceSlot, number>,
  ): { value: T; dependencies: Dependencies } {
    const dependencies = target ?? new Map<ResourceSlot, number>();
    this.dependencyStack.push(dependencies);
    try {
      return { value: compute(), dependencies };
    } finally {
      this.dependencyStack.pop();
      const parent = this.dependencyStack.at(-1);
      if (parent) for (const [key, version] of dependencies) parent.set(key, version);
    }
  }
  /** Leaf form of :func:`evaluate` for a source walk: no closure and no result wrapper. */
  private evaluateSource(
    path: readonly string[],
    dependencies: Map<ResourceSlot, number>,
  ): unknown {
    this.dependencyStack.push(dependencies);
    try {
      return snapshot(this.source(path));
    } finally {
      this.dependencyStack.pop();
      const parent = this.dependencyStack.at(-1);
      if (parent) for (const [key, version] of dependencies) parent.set(key, version);
    }
  }
  observe(observation: Observation, path: readonly string[]): unknown {
    const read = this.staticObservations.get(observation);
    if (read) return read();
    const declaration = this.declarations.get(path[0]!);
    if (declaration?.kind === 'pin' || declaration?.kind === 'state') {
      const resources = declaration.kind === 'pin' ? this.sampleResources : this.stateResources;
      const pin = declaration.kind === 'pin' ? this.pin(declaration.name) : undefined;
      if (pin && path[1] !== 'sample') throw new TypeError(`Invalid source ${path.join('.')}`);
      // Published samples are immutable; state values may contain byte snapshots.
      const read = () => {
        let value: unknown = pin ? pin.sample : this.states.get(declaration.name);
        for (let index = pin ? 2 : 1; index < path.length; index++)
          value = (value as Record<string, unknown>)[path[index]!];
        return pin ? value : snapshot(value);
      };
      const value = read();
      const slot = resources.get(declaration.name)!;
      if (!slot.subscribers.size) this.observerRevision++;
      slot.subscribers.add(observation);
      this.staticObservations.set(observation, read);
      return value;
    }
    // Dynamic sources alternate between two reusable dependency buffers, so one round can
    // be diffed against the other without allocating a map per publication boundary.
    const frames = this.observationFrames.get(observation);
    let target: Map<ResourceSlot, number>;
    if (frames === undefined) {
      target = new Map();
      this.observationFrames.set(observation, {
        first: target,
        second: new Map(),
        alternate: true,
      });
    } else {
      target = frames.alternate ? frames.second : frames.first;
      frames.alternate = !frames.alternate;
      target.clear();
    }
    const observed = this.evaluateSource(path, target);
    const previous = this.observations.get(observation);
    // A stable network re-derives the same slots every round; only membership changes
    // touch subscriber bookkeeping.
    if (previous === undefined || previous.size !== target.size || !hasEvery(previous, target)) {
      if (previous)
        for (const slot of previous.keys())
          if (!target.has(slot) && slot.subscribers.delete(observation) && !slot.subscribers.size)
            this.observerRevision++;
      for (const slot of target.keys())
        if (!previous?.has(slot)) {
          if (!slot.subscribers.size) this.observerRevision++;
          slot.subscribers.add(observation);
        }
    }
    this.observations.set(observation, target);
    return observed;
  }
  observationReader(observation: Observation, path: readonly string[]): () => unknown {
    return this.staticObservations.get(observation) ?? (() => this.observe(observation, path));
  }
  read(kind: string, name: string): unknown {
    if (kind === 'state') {
      this.trackSlot(this.stateSlot(name));
      return this.states.get(name);
    }
    if (kind === 'derived') {
      let cached = this.derived.get(name);
      if (!cached || !this.dependenciesCurrent(cached.dependencies)) {
        const declaration = this.declarations.get(name);
        if (declaration?.kind !== 'derived') throw new TypeError(`Unknown derived ${name}`);
        // The previous dependency set is only used by the staleness check above, so this
        // name's buffer can be cleared and refilled in place for the new evaluation.
        let buffer = this.derivedBuffers.get(name);
        if (buffer === undefined) {
          buffer = new Map();
          this.derivedBuffers.set(name, buffer);
        } else buffer.clear();
        cached = this.evaluate(() => computation(declaration.value, this.host), buffer);
        this.derived.set(name, cached);
      }
      const parent = this.dependencyStack.at(-1);
      if (parent) for (const [key, version] of cached.dependencies) parent.set(key, version);
      return cached.value;
    }
    const values = kind === 'property' ? this.props : this.constants;
    if (values.has(name)) return values.get(name);
    if (this.evaluating.has(name)) throw new TypeError(`Circular creation dependency ${name}`);
    this.evaluating.add(name);
    try {
      const declaration = this.declarations.get(name);
      if (declaration?.kind !== 'property' && declaration?.kind !== 'const')
        throw new TypeError(`Invalid creation reference ${name}`);
      let value: unknown;
      if (declaration.kind === 'property') {
        if (Object.hasOwn(this.rawProps, name))
          value = captureValue(declaration.type, this.rawProps[name], this.declarations, true);
        else if (declaration.default)
          value = captureValue(
            declaration.type,
            computation(declaration.default, this.host),
            this.declarations,
            true,
          );
        else throw new TypeError(`Missing property ${name}`);
      } else value = computation(declaration.value, this.host);
      values.set(name, value);
      return value;
    } finally {
      this.evaluating.delete(name);
    }
  }
  invoke(name: string, args: readonly unknown[] = []): Execution {
    const fn = this.declarations.get(name);
    if (fn?.kind !== 'function') throw new TypeError(`Unknown function ${name}`);
    return body(fn.body)(this.host, args);
  }
  syncCall(name: string, args: readonly unknown[] = []): unknown {
    const step = this.invoke(name, args).next();
    if (!step.done) throw new TypeError('Unexpected suspension in synchronous function');
    return step.value;
  }
  pin(ref: unknown): ElectricalPin {
    const pin = this.pins.get(String(ref));
    if (!pin) throw new TypeError(`Unknown pin ${String(ref)}`);
    return pin;
  }
  /**
   * One frozen, reusable intent value per (pin, resistance); intents are immutable. The
   * outer map is keyed by pin name and the inner one by resistance, so the hot path builds
   * no key string. Bounds: at most 64 names, and at most 8 resistances per name; a full
   * level is cleared wholesale (no least-recently-used eviction), so identity is only
   * reused while both levels stay under their limits.
   */
  resistorIntent(pin: unknown, resistance: number): readonly ResistorBranch[] {
    const name = typeof pin === 'string' ? pin : String(pin);
    let byResistance = this.resistorIntents.get(name);
    if (byResistance === undefined) {
      if (this.resistorIntents.size >= 64) this.resistorIntents.clear();
      byResistance = new Map();
      this.resistorIntents.set(name, byResistance);
    }
    let intent = byResistance.get(resistance);
    if (intent === undefined) {
      if (byResistance.size >= 8) byResistance.clear();
      intent = Object.freeze([Object.freeze({ to: this.pin(name), resistance })]);
      byResistance.set(resistance, intent);
    }
    return intent;
  }
  private readSample(ref: unknown): ElectricalPin['sample'] {
    const name = typeof ref === 'string' ? ref : String(ref);
    let entry = this.sampleEntries.get(name);
    if (entry === undefined) {
      const pin = this.pin(name);
      entry = { pin, slot: this.sampleResources.get(pin.name)! };
      if (this.sampleEntries.size >= 512) this.sampleEntries.clear();
      this.sampleEntries.set(name, entry);
    }
    const dependencies = this.dependencyStack.at(-1);
    if (dependencies) dependencies.set(entry.slot, entry.slot.version);
    return entry.pin.sample;
  }
  memory(ref: unknown): Uint8Array {
    const bytes = this.memories.get(String(ref));
    if (!bytes) throw new TypeError(`Unknown memory ${String(ref)}`);
    return bytes;
  }
  /** Cached resource bookkeeping for state and memory, resolved once per declaration name. */
  private stateSlot(name: string): ResourceSlot {
    let slot = this.stateSlots.get(name);
    if (slot === undefined) {
      if (!this.states.has(name)) throw new TypeError(`Unknown state ${name}`);
      slot = this.stateResources.get(name)!;
      this.stateSlots.set(name, slot);
    }
    return slot;
  }
  memoryPlan(ref: unknown): {
    name: string;
    bytes: Uint8Array;
    view: DataView;
    slot: ResourceSlot;
  } {
    const name = typeof ref === 'string' ? ref : String(ref);
    let plan = this.memoryPlans.get(name);
    if (plan === undefined) {
      const bytes = this.memories.get(name);
      if (!bytes) throw new TypeError(`Unknown memory ${name}`);
      plan = {
        name,
        bytes,
        view: this.memoryViews.get(name)!,
        slot: this.memoryResources.get(name)!,
      };
      this.memoryPlans.set(name, plan);
    }
    return plan;
  }
  memoryChanged(name: string): void {
    this.memoryChangedSlot(name, this.memoryPlan(name).slot);
  }
  private memoryChangedPlan(plan: { name: string; slot: ResourceSlot }): void {
    this.memoryChangedSlot(plan.name, plan.slot);
  }
  private memoryChangedSlot(name: string, slot: ResourceSlot): void {
    this.board.invalidate(slot);
    for (const jit of this.jits)
      if (jit.options.code === name) {
        jit.cache.clear();
        jit.revision++;
        jit.directPrograms.clear();
        jit.directProgramRevision = -1;
        jit.directSkip = undefined;
        if (jit.direct?.frame.resume) jit.direct.frame.stopAfterInstruction = true;
        else jit.direct = undefined;
      }
  }
  /**
   * Handles for the fixed names a resumable process body uses. They live on the instance,
   * so a shared program text binds each instance (and each process frame) separately, and
   * every read still resolves the current sample or state value.
   */
  private bindResources(specs: readonly (readonly [string, string])[]): readonly ResourceHandle[] {
    const handles = new Array<ResourceHandle>(specs.length);
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index]!;
      const key = `${spec[0]}\0${spec[1]}`;
      let handle = this.resourceHandles.get(key);
      if (handle === undefined) {
        handle = this.resourceHandle(spec[0], spec[1]);
        this.resourceHandles.set(key, handle);
      }
      handles[index] = handle;
    }
    return handles;
  }
  /**
   * Each method repeats the generic host operation exactly: name resolution stays lazy so
   * an invalid name still fails at the same operation, dependency slots are still
   * recorded, state writes still snapshot, and memory stores still run the code-memory
   * invalidation that clears JIT caches.
   */
  private resourceHandle(kind: string, name: string): ResourceHandle {
    if (kind === 'pin') {
      let pin: ElectricalPin | undefined;
      let slot = -1;
      let sample: ResourceSlot | undefined;
      const resolve = (): ElectricalPin => {
        if (pin === undefined) {
          pin = this.pin(name);
          slot = this.board.electricalSlot(pin);
          sample = this.sampleResources.get(name)!;
        }
        return pin;
      };
      return Object.freeze({
        sample: () => {
          const current = resolve();
          const dependencies = this.dependencyStack.at(-1);
          if (dependencies) dependencies.set(sample!, sample!.version);
          return current.sample;
        },
        intent: (value: unknown) => {
          const current = resolve();
          if (current.intent === value) return;
          current.intent = value as readonly ResistorBranch[];
          this.board.dirtyElectricalSlots.add(slot);
          this.board.electricalDirty = true;
        },
        resistor: (resistance: unknown) => {
          const r = electricalNumber(resistance);
          if (r < 0.001 || r > 1e9)
            throw new ElectricalParameterError('Resistance outside [0.001, 1e9]');
          return this.resistorIntent(name, r);
        },
      });
    }
    if (kind === 'state') {
      let slot: ResourceSlot | undefined;
      const resolve = (): ResourceSlot => (slot ??= this.stateSlot(name));
      const states = this.states;
      return Object.freeze({
        read: () => {
          const current = resolve();
          const dependencies = this.dependencyStack.at(-1);
          if (dependencies) dependencies.set(current, current.version);
          return states.get(name);
        },
        write: (value: unknown) => {
          const current = resolve();
          states.set(name, snapshot(value));
          this.board.invalidate(current);
        },
      });
    }
    let plan: { name: string; bytes: Uint8Array; view: DataView; slot: ResourceSlot } | undefined;
    const resolve = (): NonNullable<typeof plan> => (plan ??= this.memoryPlan(name));
    const read = (size: number, little: boolean, offset: unknown): number => {
      const current = resolve();
      const at = range(current.bytes, offset, size);
      const dependencies = this.dependencyStack.at(-1);
      if (dependencies) dependencies.set(current.slot, current.slot.version);
      return size === 1
        ? current.bytes[at]!
        : size === 2
          ? current.view.getUint16(at, little)
          : current.view.getUint32(at, little);
    };
    const write = (size: number, little: boolean, offset: unknown, value: unknown): void => {
      const current = resolve();
      const at = range(current.bytes, offset, size);
      const n = integer(value, 'stored value');
      if (size === 1) current.bytes[at] = n;
      else if (size === 2) current.view.setUint16(at, n, little);
      else current.view.setUint32(at, n, little);
      this.memoryChangedSlot(name, current.slot);
    };
    return Object.freeze({
      load8: (offset: unknown) => read(1, false, offset),
      load16le: (offset: unknown) => read(2, true, offset),
      load16be: (offset: unknown) => read(2, false, offset),
      load32le: (offset: unknown) => read(4, true, offset),
      load32be: (offset: unknown) => read(4, false, offset),
      store8: (offset: unknown, value: unknown) => write(1, false, offset, value),
      store16le: (offset: unknown, value: unknown) => write(2, true, offset, value),
      store16be: (offset: unknown, value: unknown) => write(2, false, offset, value),
      store32le: (offset: unknown, value: unknown) => write(4, true, offset, value),
      store32be: (offset: unknown, value: unknown) => write(4, false, offset, value),
      length: () => this.memory(name).length,
      copy: (offset: unknown, length: unknown) => {
        this.track(this.memoryResources, name);
        const bytes = this.memory(name),
          at = range(bytes, offset, length);
        return bytes.slice(at, at + Number(length));
      },
    });
  }
  prepare(): void {
    for (const declaration of this.entry.model.declarations)
      if (declaration.kind === 'pin')
        this.pins.set(declaration.name, {
          id: `${this.id}\0${declaration.name}`,
          instance: this.id,
          name: declaration.name,
          intent: [],
          sample: { voltage: null, level: 'unknown', status: 'floating' },
        });
    for (const declaration of this.entry.model.declarations) {
      switch (declaration.kind) {
        case 'property':
        case 'const':
          this.read(declaration.kind, declaration.name);
          break;
        case 'state':
          this.states.set(declaration.name, snapshot(computation(declaration.initial, this.host)));
          break;
        case 'memory': {
          const length = nonnegative(computation(declaration.length, this.host), 'memory length');
          this.memorySizes.set(declaration.name, length);
          break;
        }
        case 'pin': {
          const pin = this.pins.get(declaration.name)!;
          if (declaration.low && declaration.high) {
            const low = electricalNumber(computation(declaration.low, this.host)),
              high = electricalNumber(computation(declaration.high, this.host));
            if (low >= high)
              throw new ElectricalParameterError('Pin thresholds must satisfy low < high');
            Object.assign(pin, { low, high });
          }
          if (declaration.initial)
            pin.intent = computation(declaration.initial, this.host) as readonly ResistorBranch[];
          break;
        }
        case 'channel': {
          const capacity = nonnegative(computation(declaration.capacity, this.host), 'capacity');
          if (capacity === 0) throw new RangeError('Capacity must be positive');
          let maxLength: number | undefined;
          if (declaration.maxLength) {
            maxLength = nonnegative(computation(declaration.maxLength, this.host), 'maxLength');
            if (maxLength === 0) throw new RangeError('maxLength must be positive');
          }
          this.channels.set(declaration.name, {
            declaration,
            capacity,
            ...(maxLength === undefined ? {} : { maxLength }),
            overflow: declaration.overflow
              ? String(computation(declaration.overflow, this.host))
              : 'drop_new',
            incoming: new Fifo(),
            pending: new Fifo(),
            outgoing: new Fifo(),
          });
          break;
        }
        case 'notification':
          if (declaration.direction === 'output')
            this.notificationOutputs.set(declaration.name, null);
          break;
        case 'start':
        case 'on':
          this.processes.push({
            instance: this,
            declaration,
            resumable: resumable(declaration.body),
            ...(declaration.kind === 'on' ? { source: declaration.sourcePath } : {}),
            state: 'idle',
            pending: false,
          });
          break;
        case 'reaction':
          this.reactions.push({
            instance: this,
            declaration,
            previous: undefined,
            frame: undefined,
          });
          break;
      }
    }
    // Preserve the batch key order: output channels, then output notifications.
    for (const [name, channel] of this.channels) {
      if (channel.declaration.direction === 'input') this.batchInputs.push(channel);
      else {
        this.batchOutputs.push([name, channel]);
        this.emptyOutputs[name] = EMPTY_MESSAGES;
      }
    }
    for (const name of this.notificationOutputs.keys()) {
      this.batchNotifications.push(name);
      this.emptyOutputs[name] = null;
    }
    Object.freeze(this.emptyOutputs);
  }
  captureBatch(from: number, to: number): DeviceBatch {
    for (const channel of this.batchInputs) if (channel.incoming.length) channel.incoming.clear();
    let outputs = this.emptyOutputs;
    for (const [name, channel] of this.batchOutputs) {
      if (!channel.outgoing.length) continue;
      if (outputs === this.emptyOutputs)
        outputs = Object.assign(Object.create(null), this.emptyOutputs);
      outputs[name] = Object.freeze(
        channel.outgoing
          .drain()
          .map((message) =>
            Object.freeze({ time: message.time, value: externalValue(message.value) }),
          ),
      );
    }
    for (const name of this.batchNotifications) {
      const notified = this.notificationOutputs.get(name)!;
      if (notified === null) continue;
      if (outputs === this.emptyOutputs)
        outputs = Object.assign(Object.create(null), this.emptyOutputs);
      outputs[name] = Object.freeze({ time: notified });
      this.notificationOutputs.set(name, null);
    }
    return Object.freeze({
      from,
      to,
      outputs: outputs === this.emptyOutputs ? outputs : Object.freeze(outputs),
    });
  }
  assertCreation(): void {
    for (const declaration of this.entry.model.declarations) {
      if (declaration.kind !== 'assert') continue;
      const step = body(declaration.body)(this.host).next();
      if (!step.done) throw new TypeError('Creation assertion suspended');
    }
  }
  allocate(): void {
    for (const [name, length] of this.memorySizes) {
      const bytes = new Uint8Array(length);
      this.memories.set(name, bytes);
      this.memoryViews.set(name, new DataView(bytes.buffer));
    }
    this.memorySizes.clear();
  }
  assertCallAllowed(): void {
    this.board.assertCallAllowed(this);
  }
  inputs(): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null);
    for (const declaration of this.entry.model.declarations) {
      if (declaration.kind === 'channel' && declaration.direction === 'input')
        result[declaration.name] = Object.freeze({
          send: (value: unknown) => {
            this.assertCallAllowed();
            this.send(declaration.name, value, true);
          },
        });
      if (declaration.kind === 'notification' && declaration.direction === 'input')
        result[declaration.name] = Object.freeze({
          notify: () => {
            this.assertCallAllowed();
            this.notificationInputs.add(declaration.name);
          },
        });
    }
    return Object.freeze(result);
  }
  publicMemory(): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null);
    for (const declaration of this.entry.model.declarations)
      if (declaration.kind === 'memory' && declaration.public)
        result[declaration.name] = bytesView(this.memory(declaration.name), () => {
          this.board.assertAlive(this);
          if (!['idle', 'initialize', 'sync'].includes(this.board.phase))
            throw this.board.error(
              'INVALID_CALL_STATE',
              'Memory cannot be borrowed in this phase',
              this,
            );
          if (this.board.phase === 'initialize' && this.board.current !== this)
            throw this.board.error('INVALID_CALL_STATE', 'Another factory is initializing', this);
        });
    return Object.freeze(result);
  }
  send(name: string, value: unknown, input: boolean): void {
    const channel = this.channels.get(name);
    if (!channel || channel.declaration.direction !== (input ? 'input' : 'output'))
      throw new TypeError(`Unknown channel ${name}`);
    const captured = captureValue(channel.declaration.type, value, this.declarations);
    if (channel.maxLength !== undefined && (captured as Uint8Array).length > channel.maxLength)
      throw new RangeError('Message exceeds maxLength');
    const queue = input ? channel.pending : channel.outgoing;
    if (queue.length === channel.capacity) {
      if (channel.overflow === 'drop_new') return;
      if (channel.overflow === 'error') {
        const error = this.board.error('CHANNEL_OVERFLOW', `Channel ${name} overflow`, this);
        this.board.fault(error);
        throw error;
      }
      queue.shift();
    }
    queue.push({ time: this.board.time, value: captured });
  }
  attach(options: JitOptions): Disposable {
    this.assertCallAllowed();
    if (this.board.phase !== 'initialize' || this.board.current !== this)
      throw this.board.error('INVALID_CALL_STATE', 'attachJit is initialization-only', this);
    dataObject(options, [
      'entry',
      'code',
      'pc',
      'beforeInstruction',
      'polling',
      'delays',
      'translate',
    ]);
    identity(options.entry);
    identity(options.code);
    identity(options.pc);
    if (this.jits.some((jit) => jit.active && jit.options.entry === options.entry))
      throw this.board.error('INVALID_BINDING', 'Duplicate JIT entry', this);
    if (
      !this.memories.has(options.code) ||
      this.declarations.get(options.pc)?.kind !== 'state' ||
      (this.declarations.get(options.pc) as Decl<'state'>).type.kind !== 'number' ||
      typeof options.translate !== 'function'
    )
      throw this.board.error('INVALID_BINDING', 'Invalid JIT binding', this);
    if (options.beforeInstruction !== undefined) {
      dataObject(options.beforeInstruction, ['when', 'call']);
      const condition = this.declarations.get(options.beforeInstruction.when),
        fn = this.declarations.get(options.beforeInstruction.call);
      if (
        !condition ||
        !['state', 'derived'].includes(condition.kind) ||
        !('type' in condition) ||
        condition.type.kind !== 'bool' ||
        fn?.kind !== 'function' ||
        fn.params.length ||
        fn.returns
      )
        throw this.board.error('INVALID_BINDING', 'Invalid instruction hook', this);
    } else if (Object.hasOwn(options, 'beforeInstruction'))
      throw new TypeError('Invalid beforeInstruction');
    const polling = new Map<number, string>();
    if (Object.hasOwn(options, 'polling')) {
      if (!Array.isArray(options.polling)) throw new TypeError('polling must be an array');
      for (const item of options.polling) {
        dataObject(item, ['pc', 'predicate']);
        const pc = finite(item.pc, 'polling pc');
        const predicate = identity(item.predicate);
        const declaration = this.declarations.get(predicate);
        if (
          polling.has(pc) ||
          declaration?.kind !== 'function' ||
          !declaration.pure ||
          declaration.params.length ||
          declaration.returns?.kind !== 'bool'
        )
          throw this.board.error('INVALID_BINDING', 'Invalid polling declaration', this);
        polling.set(pc, predicate);
      }
    }
    if (Object.hasOwn(options, 'delays') && !(options.delays instanceof Map))
      throw new TypeError('delays must be a Map');
    const jit: Jit = {
      instance: this,
      options: Object.freeze({
        ...options,
        ...(options.beforeInstruction
          ? { beforeInstruction: Object.freeze({ ...options.beforeInstruction }) }
          : {}),
      }),
      cache: new Map(),
      polling,
      delays: options.delays ?? new Map(),
      revision: 0,
      directRevision: -1,
      directObserverRevision: -1,
      directStateGuards: new Set(),
      directMemoryGuards: new Set(),
      directHookReads: new Set(),
      directPrograms: new Map(),
      directProgramRevision: -1,
      direct: undefined,
      directSkip: undefined,
      pollReads: undefined,
      currentPc: undefined,
      automaticPolling: false,
      pollingWait: false,
      pollingPeriod: 0,
      pollingOrigin: 0,
      active: true,
      stopped: false,
      queued: false,
      execution: undefined,
    };
    this.jits.push(jit);
    this.board.jits.push(jit);
    const disposable = {
      dispose: () => {
        if (!jit.active) return;
        jit.active = false;
        jit.execution = undefined;
        delete jit.predicate;
        this.board.waitingJits.delete(jit);
        jit.cache.clear();
        jit.directPrograms.clear();
        jit.direct = undefined;
        jit.pollReads = undefined;
      },
    };
    this.resources.push(disposable);
    return disposable;
  }
  loadBytes(name: string, bytes: Uint8Array, offset: unknown): void {
    this.assertCallAllowed();
    if (
      this.board.phase !== 'idle' &&
      !(this.board.phase === 'initialize' && this.board.current === this)
    )
      throw this.board.error(
        'INVALID_CALL_STATE',
        'Code loading is not allowed in this phase',
        this,
      );
    if (
      typeof name !== 'string' ||
      !this.jits.some((jit) => jit.active && jit.options.code === name)
    )
      throw this.board.error('INVALID_BINDING', 'Memory is not bound as code', this);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Code must be Uint8Array');
    const memory = this.memory(name),
      at = range(memory, offset, bytes.length);
    if (bytes.length) {
      memory.set(bytes.slice(), at);
      this.memoryChanged(name);
    }
  }
  source(path: readonly string[]): unknown {
    const declaration = this.declarations.get(path[0]!);
    let value: unknown;
    let firstField = 1;
    if (declaration?.kind === 'pin') {
      this.track(this.sampleResources, declaration.name);
      if (path[1] !== 'sample') throw new TypeError(`Invalid source ${path.join('.')}`);
      value = this.pin(declaration.name).sample;
      firstField = 2;
    } else if (declaration?.kind === 'state' || declaration?.kind === 'derived')
      value = this.read(declaration.kind, declaration.name);
    else throw new TypeError(`Invalid source ${path.join('.')}`);
    for (let index = firstField; index < path.length; index++)
      value = (value as Record<string, unknown>)[path[index]!];
    return value;
  }
}
