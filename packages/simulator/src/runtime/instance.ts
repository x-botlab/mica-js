import type { Disposable } from '@mica-js/core/lifecycle';
import { type DeclarationIR, type DeviceIR, validateDeviceIR } from '@mica-js/device-model';
import type { ExecutionHost, ResourceHandle } from '@mica-js/compiler';
import type { ElectricalPin, ResistorBranch } from '../electrical';
import { Fifo } from '../queue';
import { bindBatch, type BoundBatch, type ProcessBatchRegistration } from './batch';
import { body, computation, resumable, resumableBatch, synchronousBody } from './execution';
import { acceptSync, electricalNumber, ElectricalParameterError } from './errors';
import {
  clearPromotions,
  disposeDirect,
  invalidateDirect,
  resolveDirectArtifactCache,
} from './jit';
import type {
  Channel,
  Decl,
  Dependencies,
  DerivedEntry,
  DirectJitLayout,
  Entry,
  Execution,
  Jit,
  JitMetadataRegion,
  JitPollingBinding,
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
  JitCodeChange,
  JitCodeRegion,
  JitDelay,
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
  /** Effective batch admission: option enabled and execution mode is throughput. */
  readonly batchExecution: boolean;
  /** Monotonic count of resource-version mutations on the whole board. */
  readonly resourceEpoch: number;
  noteResourceVersion(slot: ResourceSlot): void;
  markElectricalDirty(slot: number): void;
  readonly jits: Jit[];
  readonly waitingJits: Set<Jit>;
  /** Wakes or drops a parked JIT and removes its dependency registrations. */
  unparkWaiter(jit: Jit): void;
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
type JitFunctions = readonly Decl<'function'>[];
const jitModels = new WeakMap<DeviceIR, WeakMap<JitFunctions, DeviceIR>>();

/** Retain the binding identity when adapters reuse the same immutable function table. */
function bindJitFunctions(base: DeviceIR, functions: JitFunctions): DeviceIR {
  if (functions.length === 0) return base;
  let models = jitModels.get(base);
  const cached = models?.get(functions);
  if (cached !== undefined) return cached;
  const model = validateDeviceIR({ ...base, declarations: base.declarations.concat(functions) });
  for (const declaration of model.declarations.slice(base.declarations.length))
    if (declaration.kind !== 'function') throw new TypeError('Expected JIT function declaration');
  if (models === undefined) {
    models = new WeakMap();
    jitModels.set(base, models);
  }
  models.set(functions, model);
  return model;
}

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
    registerProcessBatch: (registration: ProcessBatchRegistration) =>
      owner.registerProcessBatch(registration),
    loadBytes: (name: string, bytes: Uint8Array, ...offset: unknown[]) =>
      owner.loadBytes(name, bytes, offset.length ? offset[0] : 0),
  });
}

/**
 * State map whose scalar direct-bank writes are synced lazily on read.
 *
 * Direct JIT writes update `stateValues` and invalidate `stateSlots` at every boundary,
 * while no observer or host reads `instance.states` until a reaction, observation,
 * fallback or external query accesses it. Deferring the string-keyed `Map.set` calls
 * until an actual read removes redundant map updates across resident GPIO edges while
 * keeping `instance.states` an exact `Map<string, unknown>` at every read site.
 */
class StateMirrorMap extends Map<string, unknown> {
  private names: readonly string[] = [];
  private bankValues: unknown[] = [];
  private dirty = new Int32Array(0);
  private pending = false;

  bindDirectBank(names: readonly string[], values: unknown[]): void {
    this.names = names;
    this.bankValues = values;
    this.dirty = new Int32Array(Math.ceil(names.length / 32));
  }

  markDirectDirty(word: number, bits: number): void {
    this.dirty[word]! |= bits;
    this.pending = true;
  }

  private flush(): void {
    if (!this.pending) return;
    this.pending = false;
    const { names, bankValues, dirty } = this;
    for (let word = 0; word < dirty.length; word++) {
      let bits = dirty[word]!;
      if (bits === 0) continue;
      dirty[word] = 0;
      const base = word << 5;
      while (bits !== 0) {
        const index = base + 31 - Math.clz32(bits & -bits);
        super.set(names[index]!, bankValues[index]);
        bits &= bits - 1;
      }
    }
  }

  override get(key: string): unknown {
    if (this.pending) this.flush();
    return super.get(key);
  }

  override set(key: string, value: unknown): this {
    if (this.pending) this.flush();
    return super.set(key, value);
  }

  override entries(): MapIterator<[string, unknown]> {
    if (this.pending) this.flush();
    return super.entries();
  }

  override values(): MapIterator<unknown> {
    if (this.pending) this.flush();
    return super.values();
  }

  override forEach(
    callbackfn: (value: unknown, key: string, map: Map<string, unknown>) => void,
    thisArg?: unknown,
  ): void {
    if (this.pending) this.flush();
    super.forEach(callbackfn, thisArg);
  }

  override [Symbol.iterator](): MapIterator<[string, unknown]> {
    if (this.pending) this.flush();
    return super[Symbol.iterator]();
  }
}

export class Instance {
  readonly declarations = new Map<string, DeclarationIR>();
  readonly props = new Map<string, unknown>();
  readonly constants = new Map<string, unknown>();
  readonly states = new StateMirrorMap();
  private directBank?: Pick<
    DirectJitLayout,
    'stateNames' | 'stateSlots' | 'states' | 'stateValues'
  >;
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
  readonly derived = new Map<string, DerivedEntry>();
  /** One-entry memo for repeated `read('derived', name)` calls inside a body. */
  private derivedName: string | undefined;
  private derivedEntry: DerivedEntry | undefined;
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
  private readonly intentEntries = new Map<string, { pin: ElectricalPin; slot: number }>();
  private readonly stateSlots = new Map<string, ResourceSlot>();
  /** Per-instance handles for the fixed resources a resumable process body binds. */
  private readonly resourceHandles = new Map<string, ResourceHandle>();
  /** Active process batch registrations, allocated on the first real registration. */
  private processBatchRegistrations:
    Map<Process, Map<number, { readonly bound: BoundBatch | undefined }>> | undefined;
  private readonly memoryPlans = new Map<
    string,
    { name: string; bytes: Uint8Array; view: DataView; slot: ResourceSlot }
  >();
  /** 按 memory 维护的代码代际；只有 code region 内写入才递增。 */
  private readonly codeVersions = new Map<string, number>();
  /**
   * Every memory name any attached JIT binds as a code region. A write outside this set
   * cannot affect a JIT, so the store path skips the region scans entirely.
   */
  private readonly codeMemories = new Set<string>();
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
        resources.set(declaration.name, {
          version: 0,
          subscribers: new Set(),
          waiters: undefined,
        });
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
      write: (name, value) => this.writeState(name, value, this.stateSlot(name)),
      sample: (ref) => {
        return this.readSample(ref);
      },
      intent: (pin, value) => {
        this.writeIntent(pin, value);
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
        const dependencies = this.dependencies();
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
        this.memoryChangedPlan(plan, at, size);
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
  /** Innermost dependency sink, or `undefined` outside an evaluation. */
  private dependencies(): Map<ResourceSlot, number> | undefined {
    const stack = this.dependencyStack;
    return stack.length === 0 ? undefined : stack[stack.length - 1];
  }
  private trackSlot(slot: ResourceSlot): void {
    const dependencies = this.dependencies();
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
  /** Whether any attached JIT owns this memory as code, including retired regions. */
  isCodeMemory(name: string): boolean {
    return this.codeMemories.has(name);
  }
  /**
   * Active JIT registrations that read or write `name` as their PC state. Process batches
   * reject any write to such a state; JIT batches accept only their own unshared PC.
   */
  activeJitPcCount(name: string): number {
    let count = 0;
    for (const jit of this.jits) if (jit.active && !jit.stopped && jit.options.pc === name) count++;
    return count;
  }
  private syncProcessBatches(process: Process): void {
    const registrations = this.processBatchRegistrations?.get(process);
    if (registrations === undefined || registrations.size === 0) {
      process.batch = undefined;
      return;
    }
    const bounds: BoundBatch[] = [];
    for (const registration of registrations.values())
      if (registration.bound !== undefined) bounds.push(registration.bound);
    process.batch = bounds.length === 0 ? undefined : bounds;
  }
  private invalidBatchBinding(message: string, cause?: unknown): SimulationError {
    return this.board.error('INVALID_BINDING', message, this, cause);
  }
  /**
   * Register one compiler-proven process loop for this instance. The registration is a
   * synchronous factory-time action; its configuration is snapshotted, and only the
   * optional binding attached to the process object is consulted per dispatch.
   */
  registerProcessBatch(registration: ProcessBatchRegistration): Disposable {
    this.assertCallAllowed();
    const board = this.board;
    if (board.phase !== 'initialize' || board.current !== this)
      throw board.error(
        'INVALID_CALL_STATE',
        'Process batch registration is initialization-only',
        this,
      );
    let input: Record<string, unknown>;
    try {
      dataObject(registration, ['process', 'loop', 'stopBefore']);
      input = registration as unknown as Record<string, unknown>;
    } catch (cause) {
      throw this.invalidBatchBinding('Invalid process batch registration', cause);
    }
    if (Object.hasOwn(input, 'stopBefore') && input.stopBefore === undefined)
      throw this.invalidBatchBinding('Explicit undefined stopBefore');

    let selector: Record<string, unknown>;
    try {
      dataObject(input.process, ['kind', 'index', 'name']);
      selector = input.process as Record<string, unknown>;
    } catch (cause) {
      throw this.invalidBatchBinding('Invalid process batch selector', cause);
    }
    let process: Process | undefined;
    if (selector.kind === 'start') {
      if (Object.hasOwn(selector, 'name'))
        throw this.invalidBatchBinding('Invalid process batch selector');
      const index = selector.index;
      if (!Number.isSafeInteger(index) || (index as number) < 0)
        throw this.invalidBatchBinding('Invalid process batch index');
      process = this.processes.filter((entry) => entry.declaration.kind === 'start')[
        index as number
      ];
    } else if (selector.kind === 'on') {
      if (Object.hasOwn(selector, 'index'))
        throw this.invalidBatchBinding('Invalid process batch selector');
      const name = selector.name;
      if (typeof name !== 'string' || name.length === 0)
        throw this.invalidBatchBinding('Invalid process batch name');
      process = this.processes.find(
        (entry) => entry.declaration.kind === 'on' && entry.declaration.name === name,
      );
    } else throw this.invalidBatchBinding('Invalid process batch selector');
    if (process === undefined) throw this.invalidBatchBinding('Unknown process batch target');

    const loop = input.loop;
    if (!Number.isSafeInteger(loop) || (loop as number) < 0)
      throw this.invalidBatchBinding('Invalid process batch loop');
    const loopCount = process.declaration.body.operations.filter(
      (operation) => operation.kind === 'while',
    ).length;
    if ((loop as number) >= loopCount)
      throw this.invalidBatchBinding('Process batch loop is not declared');

    let stopBefore: string | undefined;
    if (Object.hasOwn(input, 'stopBefore')) {
      const name = input.stopBefore;
      if (typeof name !== 'string' || name.length === 0)
        throw this.invalidBatchBinding('Invalid process batch stopBefore');
      const declaration = this.declarations.get(name);
      if (declaration?.kind !== 'state' || declaration.type.kind !== 'number')
        throw this.invalidBatchBinding('stopBefore must name a number state');
      stopBefore = name;
    }

    const registrations =
      this.processBatchRegistrations?.get(process) ??
      new Map<number, { readonly bound: BoundBatch | undefined }>();
    if (registrations.has(loop as number))
      throw this.invalidBatchBinding('Duplicate process batch registration');

    let bound: BoundBatch | undefined;
    if (board.batchExecution && process.resumable !== undefined) {
      const compilation = resumableBatch(process.declaration.body);
      if (compilation !== undefined) {
        const plan = compilation.loops[loop as number];
        if (plan !== undefined) {
          bound = bindBatch(this, plan, stopBefore);
          if (bound !== undefined) {
            // The plans must describe the exact machine that runs. Adopt the opt-in
            // program only after a real admission; every other process keeps its ordinary
            // compiled program and the baseline dispatch shape.
            process.resumable = compilation.program;
          }
        }
      }
    }
    registrations.set(loop as number, { bound });
    (this.processBatchRegistrations ??= new Map()).set(process, registrations);
    this.syncProcessBatches(process);

    let active = true;
    const disposable: Disposable = {
      dispose: () => {
        if (!active) return;
        active = false;
        const current = this.processBatchRegistrations?.get(process);
        if (current?.delete(loop as number) && current.size === 0)
          this.processBatchRegistrations!.delete(process);
        if (this.processBatchRegistrations?.size === 0) this.processBatchRegistrations = undefined;
        this.syncProcessBatches(process);
      },
    };
    this.resources.push(disposable);
    return disposable;
  }
  dependenciesCurrent(dependencies: Dependencies | undefined): boolean {
    if (!dependencies) return false;
    for (const [slot, version] of dependencies) if (slot.version !== version) return false;
    return true;
  }
  /** Publishes a derived cache entry; the memo must follow every table write. */
  setDerived(name: string, entry: DerivedEntry): void {
    // Observation chains republish the same entry on every boundary they observe; the
    // memo already proves `derived` maps this name to this entry, so the map write is
    // skipped. Every other writer still replaces the map entry below.
    if (this.derivedName === name && this.derivedEntry === entry) return;
    this.derived.set(name, entry);
    this.derivedName = name;
    this.derivedEntry = entry;
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
      const parent = this.dependencies();
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
      const parent = this.dependencies();
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
      // A body re-reads the same derived value between boundaries; one memoized name
      // saves the string-keyed lookup. Every writer of `derived` goes through `setDerived`,
      // so the memo can never disagree with the table.
      let cached = name === this.derivedName ? this.derivedEntry : this.derived.get(name);
      const epoch = this.board.resourceEpoch;
      if (
        cached === undefined ||
        (cached.epoch !== epoch && !this.dependenciesCurrent(cached.dependencies))
      ) {
        const declaration = this.declarations.get(name);
        if (declaration?.kind !== 'derived') throw new TypeError(`Unknown derived ${name}`);
        // The previous dependency set is only used by the staleness check above, so this
        // name's buffer can be cleared and refilled in place for the new evaluation.
        let buffer = this.derivedBuffers.get(name);
        if (buffer === undefined) {
          buffer = new Map();
          this.derivedBuffers.set(name, buffer);
        } else buffer.clear();
        const evaluated = this.evaluate(() => computation(declaration.value, this.host), buffer);
        cached = {
          value: evaluated.value,
          dependencies: evaluated.dependencies,
          epoch: this.board.resourceEpoch,
        };
        this.setDerived(name, cached);
      } else if (cached.epoch !== epoch) {
        // The versions still match, so the value holds while later mutations keep
        // advancing the epoch: record the checkpoint and skip the scan until then.
        cached.epoch = epoch;
      }
      const parent = this.dependencies();
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
  /** Shared by the generic host and direct JIT, which needs to know whether to publish. */
  writeIntent(ref: unknown, value: unknown): boolean {
    const name = typeof ref === 'string' ? ref : String(ref);
    const board = this.board;
    let entry = this.intentEntries.get(name);
    if (entry === undefined) {
      const pin = this.pin(name);
      entry = { pin, slot: board.electricalSlot(pin) };
      this.intentEntries.set(name, entry);
    }
    if (entry.pin.intent === value) return false;
    entry.pin.intent = value as readonly ResistorBranch[];
    board.markElectricalDirty(entry.slot);
    return true;
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
    const dependencies = this.dependencies();
    if (dependencies) dependencies.set(entry.slot, entry.slot.version);
    return entry.pin.sample;
  }
  memory(ref: unknown): Uint8Array {
    const bytes = this.memories.get(String(ref));
    if (!bytes) throw new TypeError(`Unknown memory ${String(ref)}`);
    return bytes;
  }
  /** Instance-owned numeric bank, mirrored by every non-direct state write. */
  directStateBank(): NonNullable<Instance['directBank']> {
    if (this.directBank === undefined) {
      const stateNames = [...this.states.keys()].filter((name) => {
        const declaration = this.declarations.get(name) as Decl<'state'>;
        return declaration.type.kind === 'number' || declaration.type.kind === 'bool';
      });
      const frozenNames = Object.freeze(stateNames);
      const stateValues = stateNames.map((name) => this.states.get(name));
      this.states.bindDirectBank(frozenNames, stateValues);
      this.directBank = {
        stateNames: frozenNames,
        stateSlots: Object.freeze(stateNames.map((name) => this.stateResources.get(name)!)),
        states: new Map(stateNames.map((name, index) => [name, index])),
        stateValues,
      };
    }
    return this.directBank;
  }
  /** Direct scalar writes are already in the numeric bank. Commit the mirror and version. */
  commitDirectStates(dirty: number[] | Int32Array): boolean {
    const { stateSlots } = this.directBank!;
    const states = this.states;
    const board = this.board;
    let wrote = false;
    for (let word = 0; word < dirty.length; word++) {
      let bits = dirty[word]!;
      if (bits === 0) continue;
      dirty[word] = 0;
      wrote = true;
      states.markDirectDirty(word, bits);
      const base = word << 5;
      while (bits !== 0) {
        const index = base + 31 - Math.clz32(bits & -bits);
        const slot = stateSlots[index]!;
        if (slot.subscribers.size === 0) {
          slot.version++;
          board.noteResourceVersion(slot);
        } else board.invalidate(slot);
        bits &= bits - 1;
      }
    }
    return wrote;
  }
  private writeState(name: string, value: unknown, slot: ResourceSlot): void {
    const captured = snapshot(value);
    this.states.set(name, captured);
    const index = this.directBank?.states.get(name);
    if (index !== undefined) this.directBank!.stateValues[index] = captured;
    this.board.invalidate(slot);
  }
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
  codeVersion(name: string): number {
    return this.codeVersions.get(name) ?? 0;
  }
  private intersectsCodeRegion(
    region: JitCodeRegion,
    offset: number | undefined,
    size: number | undefined,
  ): boolean {
    if (offset === undefined || size === undefined) return true;
    return offset < region.size && offset + size > 0;
  }
  private hasCodeRegion(name: string, offset?: number, size?: number): boolean {
    for (const jit of this.jits) {
      if (!jit.active) continue;
      for (const region of jit.codeRegions)
        if (region.memory === name && this.intersectsCodeRegion(region, offset, size)) return true;
    }
    return false;
  }
  private addMetadataChange(state: JitMetadataRegion, change: JitCodeChange): void {
    const pending = state.pending;
    let end = change.offset + change.length;
    let start = change.offset;
    for (let index = 0; index < pending.length;) {
      const current = pending[index]!;
      const currentEnd = current.offset + current.length;
      if (change.offset <= currentEnd && current.offset <= end) {
        start = Math.min(start, current.offset);
        end = Math.max(end, currentEnd);
        pending.splice(index, 1);
      } else index++;
    }
    pending.push({ memory: change.memory, offset: start, length: end - start });
  }
  private markMetadataChanged(
    jit: Jit,
    name: string,
    offset: number | undefined,
    size: number | undefined,
  ): void {
    if (!jit.metadata) return;
    for (const state of jit.metadata.regions.values()) {
      const region = state.region;
      if (region.memory !== name) continue;
      // The first successful callback receives the whole region; no pending range is
      // needed before that (and none is available to merge into).
      if (state.appliedVersion === -1) continue;
      if (name === jit.options.code) {
        // Primary aliases may jump to each other in one direct program. Every primary
        // alias is revalidated before a direct build, even if the write did not intersect
        // that alias's logical window; changes still carry only the actual write range.
        state.dirty = true;
      }
      if (!this.intersectsCodeRegion(region, offset, size)) continue;
      state.dirty = true;
      const start = offset === undefined ? 0 : Math.max(0, offset);
      const end = offset === undefined ? region.size : Math.min(region.size, offset + (size ?? 0));
      if (end > start)
        this.addMetadataChange(state, { memory: name, offset: start, length: end - start });
    }
  }
  memoryChanged(name: string, offset?: number, size?: number): void {
    this.memoryChangedSlot(name, this.memoryPlan(name).slot, offset, size);
  }
  private memoryChangedPlan(
    plan: { name: string; slot: ResourceSlot },
    offset?: number,
    size?: number,
  ): void {
    this.memoryChangedSlot(plan.name, plan.slot, offset, size);
  }
  private memoryChangedSlot(
    name: string,
    slot: ResourceSlot,
    offset?: number,
    size?: number,
  ): void {
    this.board.invalidate(slot);
    // Data memories are never bound as code, so no JIT region, cache or metadata can care.
    if (!this.codeMemories.has(name)) return;
    if (this.hasCodeRegion(name, offset, size))
      this.codeVersions.set(name, this.codeVersion(name) + 1);
    for (const jit of this.jits) {
      let affected = false;
      for (const region of jit.codeRegions)
        if (region.memory === name && this.intersectsCodeRegion(region, offset, size)) {
          affected = true;
          break;
        }
      if (!affected) continue;
      this.markMetadataChanged(jit, name, offset, size);
      if (jit.options.code === name) {
        // Primary code keeps the exact legacy invalidation and active-instruction contract.
        jit.cache.clear();
        jit.cacheMemories.clear();
        jit.revision++;
        // Promotion counts and routes belong to the replaced code generation.
        clearPromotions(jit);
        // Bodies in the shared compiler cache were emitted from the replaced bytes.
        invalidateDirect(jit, true);
      } else if (jit.cacheMemories.has(name)) {
        // Additional regions are conservatively invalidated as a whole. Direct admission
        // only covers the primary memory today; a future admitted entry from here still
        // invalidates the session instead of leaving a route over replaced bytes.
        for (const [pc, instruction] of jit.cache)
          if (instruction.codeRegion?.memory === name) jit.cache.delete(pc);
        jit.cacheMemories.delete(name);
        if (jit.directMemories.has(name)) invalidateDirect(jit, false);
        jit.directMemories.delete(name);
      }
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
   * Each method repeats the generic host operation exactly: dependency slots are still
   * recorded, state writes still snapshot, and memory stores still run the code-memory
   * invalidation that clears JIT caches. Every resource a declaration already provides is
   * resolved here, at bind time; a name that does not exist yet keeps resolving lazily so
   * it still fails at its first real use, not while binding.
   */
  private resourceHandle(kind: string, name: string): ResourceHandle {
    if (kind === 'pin') {
      let pin = this.pins.get(name);
      let slot = pin === undefined ? -1 : this.board.electricalSlot(pin);
      let sample = pin === undefined ? undefined : this.sampleResources.get(name)!;
      // One-entry cache for the constant resistance a body repeats on every execution.
      let lastResistance: unknown;
      let lastIntent: readonly ResistorBranch[] | undefined;
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
          const dependencies = this.dependencies();
          if (dependencies) dependencies.set(sample!, sample!.version);
          return current.sample;
        },
        intent: (value: unknown) => {
          const current = resolve();
          if (current.intent === value) return;
          current.intent = value as readonly ResistorBranch[];
          this.board.markElectricalDirty(slot);
        },
        resistor: (resistance: unknown) => {
          // Device bodies pass a pinned resistance on every execution; repeating the same
          // argument reuses the frozen intent instead of resolving `(pin, resistance)` again.
          // The intent is checked as well: an empty cache starts at `undefined`, which must
          // still reach `electricalNumber` and fail like the generic host path.
          if (lastIntent !== undefined && resistance === lastResistance) return lastIntent;
          const r = electricalNumber(resistance);
          if (r < 0.001 || r > 1e9)
            throw new ElectricalParameterError('Resistance outside [0.001, 1e9]');
          const intent = this.resistorIntent(name, r);
          lastResistance = resistance;
          lastIntent = intent;
          return intent;
        },
      });
    }
    if (kind === 'state') {
      let slot: ResourceSlot | undefined = this.states.has(name)
        ? this.stateResources.get(name)!
        : undefined;
      // Direct-bank index of this state: -2 not probed yet (the bank appears with the first
      // direct program), -1 outside the scalar bank, otherwise the live value's index.
      let banked = slot === undefined ? -1 : (this.directBank?.states.get(name) ?? -2);
      const resolve = (): ResourceSlot => (slot ??= this.stateSlot(name));
      const states = this.states;
      return Object.freeze({
        read: () => {
          const current = resolve();
          const dependencies = this.dependencies();
          if (dependencies) dependencies.set(current, current.version);
          if (banked === -2) banked = this.directBank?.states.get(name) ?? -1;
          return banked < 0 ? states.get(name) : this.directBank!.stateValues[banked];
        },
        write: (value: unknown) => {
          const current = resolve();
          this.writeState(name, value, current);
        },
      });
    }
    let plan: { name: string; bytes: Uint8Array; view: DataView; slot: ResourceSlot } | undefined =
      this.memories.has(name) ? this.memoryPlan(name) : undefined;
    const resolve = (): NonNullable<typeof plan> => (plan ??= this.memoryPlan(name));
    const read = (size: number, little: boolean, offset: unknown): number => {
      const current = resolve();
      const at = range(current.bytes, offset, size);
      const dependencies = this.dependencies();
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
      this.memoryChangedSlot(name, current.slot, at, size);
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
            batch: undefined,
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
            synchronousProgram: synchronousBody(this, declaration.body) ?? null,
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
  private bindingObject(
    value: unknown,
    fields: readonly string[],
    message: string,
  ): Record<string, unknown> {
    try {
      dataObject(value, fields);
    } catch {
      throw this.board.error('INVALID_BINDING', message, this);
    }
    return value as Record<string, unknown>;
  }
  private captureDirectTiming(
    value: unknown,
    functions?: ReadonlyMap<string, Decl<'function'>>,
  ): NonNullable<JitOptions['directTiming']> {
    const input = this.bindingObject(value, ['service', 'blocked'], 'Invalid directTiming');
    let service: { readonly elapsed: string; readonly deadline: string } | undefined;
    if (Object.hasOwn(input, 'service')) {
      const raw = this.bindingObject(
        input.service,
        ['elapsed', 'deadline'],
        'Invalid directTiming service',
      );
      if (!Object.hasOwn(raw, 'elapsed') || !Object.hasOwn(raw, 'deadline'))
        throw this.board.error('INVALID_BINDING', 'directTiming service is incomplete', this);
      const elapsed = raw.elapsed;
      const deadline = raw.deadline;
      if (
        typeof elapsed !== 'string' ||
        elapsed.length === 0 ||
        typeof deadline !== 'string' ||
        deadline.length === 0
      )
        throw this.board.error('INVALID_BINDING', 'Invalid directTiming service states', this);
      for (const name of [elapsed, deadline]) {
        const declaration = this.declarations.get(name);
        if (declaration?.kind !== 'state' || declaration.type.kind !== 'number')
          throw this.board.error(
            'INVALID_BINDING',
            'directTiming service must name number states',
            this,
          );
      }
      service = Object.freeze({ elapsed, deadline });
    }
    if (Object.hasOwn(input, 'blocked') && service === undefined)
      throw this.board.error('INVALID_BINDING', 'directTiming blocked requires service', this);
    let blocked: string | undefined;
    if (Object.hasOwn(input, 'blocked')) {
      const name = input.blocked;
      if (typeof name !== 'string' || name.length === 0)
        throw this.board.error('INVALID_BINDING', 'Invalid directTiming blocked function', this);
      const declaration = functions?.get(name) ?? this.declarations.get(name);
      if (
        declaration?.kind !== 'function' ||
        declaration.pure !== true ||
        declaration.params.length !== 0 ||
        declaration.returns?.kind !== 'bool'
      )
        throw this.board.error('INVALID_BINDING', 'Invalid directTiming blocked function', this);
      blocked = name;
    }
    return Object.freeze({
      ...(service === undefined ? {} : { service }),
      ...(blocked === undefined ? {} : { blocked }),
    });
  }
  private captureTranslationIdentity(
    value: unknown,
  ): NonNullable<JitOptions['translationIdentity']> {
    const input = this.bindingObject(
      value,
      ['abi', 'configuration'],
      'Invalid translationIdentity',
    );
    if (
      !Object.hasOwn(input, 'abi') ||
      !Object.hasOwn(input, 'configuration') ||
      typeof input.abi !== 'string' ||
      input.abi.length === 0 ||
      typeof input.configuration !== 'string' ||
      input.configuration.length === 0
    )
      throw this.board.error('INVALID_BINDING', 'Invalid translationIdentity', this);
    return Object.freeze({ abi: input.abi, configuration: input.configuration });
  }
  private captureDirectTier(value: unknown): NonNullable<JitOptions['directTier']> {
    const input = this.bindingObject(value, ['promoteAfter'], 'Invalid directTier');
    if (
      !Object.hasOwn(input, 'promoteAfter') ||
      !Number.isSafeInteger(input.promoteAfter) ||
      (input.promoteAfter as number) <= 0
    )
      throw this.board.error('INVALID_BINDING', 'Invalid directTier promoteAfter', this);
    return Object.freeze({ promoteAfter: input.promoteAfter as number });
  }
  private captureCodeRegions(options: JitOptions): {
    readonly all: readonly JitCodeRegion[];
    readonly additional: readonly JitCodeRegion[];
  } {
    const primaryMemory = this.memories.get(options.code)!;
    const primary = Object.freeze({
      memory: options.code,
      base: 0,
      size: primaryMemory.length,
    });
    const additional: JitCodeRegion[] = [];
    if (Object.hasOwn(options, 'codeRegions')) {
      if (!Array.isArray(options.codeRegions)) throw new TypeError('codeRegions must be an array');
      for (const item of options.codeRegions) {
        dataObject(item, ['memory', 'base', 'size']);
        const memory = identity(item.memory);
        const base = nonnegative(item.base, 'code region base');
        const size = nonnegative(item.size, 'code region size');
        if (size === 0) throw new RangeError('Code region size must be positive');
        const length = this.memories.get(memory)?.length;
        if (length === undefined)
          throw this.board.error('INVALID_BINDING', 'Unknown code region memory', this);
        if (size > length)
          throw this.board.error('INVALID_BINDING', 'Code region exceeds memory', this);
        if (base > Number.MAX_SAFE_INTEGER - size)
          throw this.board.error(
            'INVALID_BINDING',
            'Code region range is not a safe integer',
            this,
          );
        const region = Object.freeze({ memory, base, size });
        for (const existing of [primary, ...additional]) {
          if (
            region.base < existing.base + existing.size &&
            existing.base < region.base + region.size
          )
            throw this.board.error('INVALID_BINDING', 'Code regions overlap', this);
        }
        additional.push(region);
      }
    }
    return {
      all: Object.freeze([primary, ...additional]),
      additional: Object.freeze(additional),
    };
  }
  private capturePolling(items: unknown, region?: JitCodeRegion): Map<number, JitPollingBinding> {
    const polling = new Map<number, JitPollingBinding>();
    if (!Array.isArray(items)) throw new TypeError('polling must be an array');
    for (const item of items) {
      dataObject(item, ['pc', 'predicate', 'consume', 'wait']);
      const pc = finite(item.pc, 'polling pc');
      if (region !== undefined && (pc < region.base || pc >= region.base + region.size))
        throw this.board.error('INVALID_BINDING', 'Polling pc is outside its code region', this);
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
      let consume: string | undefined;
      if (Object.hasOwn(item, 'consume')) {
        consume = identity(item.consume);
        const fn = this.declarations.get(consume);
        if (fn?.kind !== 'function' || fn.params.length !== 0 || fn.returns !== undefined)
          throw this.board.error('INVALID_BINDING', 'Invalid polling consume function', this);
      }
      let wait: JitPollingBinding['wait'];
      if (Object.hasOwn(item, 'wait')) {
        dataObject(item.wait, ['delay', 'advance']);
        const delay = identity(item.wait.delay);
        const advance = identity(item.wait.advance);
        const delayFn = this.declarations.get(delay);
        const advanceFn = this.declarations.get(advance);
        if (
          delayFn?.kind !== 'function' ||
          !delayFn.pure ||
          delayFn.params.length !== 0 ||
          delayFn.returns?.kind !== 'number' ||
          advanceFn?.kind !== 'function' ||
          advanceFn.params.length !== 1 ||
          advanceFn.params[0]!.type.kind !== 'number' ||
          advanceFn.returns !== undefined
        )
          throw this.board.error('INVALID_BINDING', 'Invalid polling wait functions', this);
        wait = Object.freeze({ delay, advance });
      }
      polling.set(
        pc,
        Object.freeze({
          predicate,
          ...(consume === undefined ? {} : { consume }),
          ...(wait === undefined ? {} : { wait }),
        }),
      );
    }
    return polling;
  }
  private captureMetadataDelays(value: unknown, region: JitCodeRegion): Map<number, JitDelay> {
    if (!(value instanceof Map)) throw new TypeError('codeMetadata delays must be a Map');
    const delays = new Map<number, JitDelay>();
    for (const [key, item] of value) {
      const pc = finite(key, 'delay pc');
      if (pc < region.base || pc >= region.base + region.size)
        throw this.board.error('INVALID_BINDING', 'Delay pc is outside its code region', this);
      dataObject(item, ['counter', 'cycles', 'pending']);
      const counter = identity(item.counter);
      const cycles = integer(item.cycles, 'delay cycles');
      if (cycles <= 0) throw new RangeError('Delay cycles must be positive');
      let pending:
        | {
            readonly state: string;
            readonly period: string;
            readonly active: string;
          }
        | undefined;
      if (Object.hasOwn(item, 'pending')) {
        dataObject(item.pending, ['state', 'period', 'active']);
        pending = Object.freeze({
          state: identity(item.pending.state),
          period: identity(item.pending.period),
          active: identity(item.pending.active),
        });
      }
      delays.set(pc, Object.freeze({ counter, cycles, ...(pending ? { pending } : {}) }));
    }
    return delays;
  }
  /** Validate and copy provider output; caller applies it atomically. */
  captureCodeMetadata(
    region: JitCodeRegion,
    value: unknown,
  ): {
    readonly polling: Map<number, JitPollingBinding>;
    readonly delays: Map<number, JitDelay>;
  } {
    dataObject(value, ['polling', 'delays']);
    if (!Object.hasOwn(value, 'polling') || !Object.hasOwn(value, 'delays'))
      throw new TypeError('codeMetadata must contain polling and delays');
    return {
      polling: this.capturePolling(value.polling, region),
      delays: this.captureMetadataDelays(value.delays, region),
    };
  }
  attach(options: JitOptions): Disposable {
    this.assertCallAllowed();
    if (this.board.phase !== 'initialize' || this.board.current !== this)
      throw this.board.error('INVALID_CALL_STATE', 'attachJit is initialization-only', this);
    dataObject(options, [
      'entry',
      'code',
      'codeRegions',
      'codeMetadata',
      'pc',
      'functions',
      'beforeInstruction',
      'polling',
      'delays',
      'directTiming',
      'shareDirectBodies',
      'shareDirectArtifacts',
      'translationIdentity',
      'directTier',
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
    const codeRegions = this.captureCodeRegions(options);
    if (Object.hasOwn(options, 'codeMetadata')) {
      if (typeof options.codeMetadata !== 'function')
        throw this.board.error('INVALID_BINDING', 'Invalid codeMetadata provider', this);
      if (Object.hasOwn(options, 'polling') || Object.hasOwn(options, 'delays'))
        throw this.board.error(
          'INVALID_BINDING',
          'codeMetadata is mutually exclusive with static polling/delays',
          this,
        );
    }
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
    const polling = Object.hasOwn(options, 'polling')
      ? this.capturePolling(options.polling)
      : new Map<number, JitPollingBinding>();
    if (Object.hasOwn(options, 'delays') && !(options.delays instanceof Map))
      throw new TypeError('delays must be a Map');
    if (
      Object.hasOwn(options, 'shareDirectBodies') &&
      typeof options.shareDirectBodies !== 'boolean'
    )
      throw new TypeError('shareDirectBodies must be a boolean');
    if (
      Object.hasOwn(options, 'shareDirectArtifacts') &&
      typeof options.shareDirectArtifacts !== 'boolean'
    )
      throw new TypeError('shareDirectArtifacts must be a boolean');
    const metadata = Object.hasOwn(options, 'codeMetadata')
      ? {
          regions: new Map(
            codeRegions.all.map((region) => [
              region,
              {
                region,
                appliedVersion: -1,
                dirty: false,
                pending: [] as JitCodeChange[],
                polling: new Map<number, JitPollingBinding>(),
                delays: new Map<number, JitDelay>(),
              },
            ]),
          ),
          polling: new Map<number, JitPollingBinding>(),
          delays: new Map<number, JitDelay>(),
        }
      : undefined;
    const base = this.entry.model;
    const emit = options.functions;
    if (Object.hasOwn(options, 'functions') && typeof emit !== 'function')
      throw new TypeError('functions must be a JIT function builder callback');
    let model = base;
    let functions: Map<string, Decl<'function'>> | undefined;
    let host = this.host;
    if (emit) {
      const declarations = emit(base);
      acceptSync(declarations);
      if (!Array.isArray(declarations)) throw new TypeError('Expected JIT function declarations');
      model = bindJitFunctions(base, declarations);
      const local = new Map<string, Decl<'function'>>();
      for (const declaration of model.declarations.slice(base.declarations.length))
        if (declaration.kind === 'function') local.set(declaration.name, declaration);
      functions = local;
      host = {
        ...this.host,
        call: (name, args) => {
          const fn = local.get(name);
          return fn ? body(fn.body)(host, args) : this.invoke(name, args);
        },
      };
    }
    const directTiming = Object.hasOwn(options, 'directTiming')
      ? this.captureDirectTiming(options.directTiming, functions)
      : undefined;
    const translationIdentity = Object.hasOwn(options, 'translationIdentity')
      ? this.captureTranslationIdentity(options.translationIdentity)
      : undefined;
    const directTier = Object.hasOwn(options, 'directTier')
      ? this.captureDirectTier(options.directTier)
      : undefined;
    const artifactCache = resolveDirectArtifactCache(options.shareDirectArtifacts);
    const jit: Jit = {
      instance: this,
      model,
      host,
      ...(functions === undefined ? {} : { functions }),
      options: Object.freeze({
        ...options,
        ...(options.codeRegions === undefined ? {} : { codeRegions: codeRegions.additional }),
        ...(options.beforeInstruction
          ? { beforeInstruction: Object.freeze({ ...options.beforeInstruction }) }
          : {}),
        ...(directTiming === undefined ? {} : { directTiming }),
        ...(translationIdentity === undefined ? {} : { translationIdentity }),
        ...(directTier === undefined ? {} : { directTier }),
      }),
      codeRegions: codeRegions.all,
      cache: new Map(),
      cacheMemories: new Set(),
      promotions: new Map(),
      metadata,
      polling,
      delays: options.delays ?? new Map(),
      revision: 0,
      directObserverRevision: -1,
      directStateGuards: new Set(),
      directMemoryGuards: new Set(),
      directHookReads: new Set(),
      directMemories: new Set(),
      artifactCache,
      direct: undefined,
      directSkip: undefined,
      directStale: false,
      directCacheInvalid: false,
      pollReads: undefined,
      currentPc: undefined,
      automaticPolling: false,
      pollingWait: false,
      pollingPeriod: 0,
      pollingOrigin: 0,
      pollingToken: 0,
      dependencyDirty: true,
      waiterSlots: undefined,
      active: true,
      stopped: false,
      queued: false,
      execution: undefined,
      genericInstruction: undefined,
    };
    this.jits.push(jit);
    this.board.jits.push(jit);
    for (const region of jit.codeRegions) this.codeMemories.add(region.memory);
    const disposable = {
      dispose: () => {
        if (!jit.active) return;
        jit.active = false;
        jit.execution = undefined;
        delete jit.predicate;
        jit.pollingToken++;
        this.board.unparkWaiter(jit);
        jit.cache.clear();
        jit.cacheMemories.clear();
        disposeDirect(jit);
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
      !this.jits.some(
        (jit) => jit.active && jit.codeRegions.some((region) => region.memory === name),
      )
    )
      throw this.board.error('INVALID_BINDING', 'Memory is not bound as code', this);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Code must be Uint8Array');
    const memory = this.memory(name),
      at = range(memory, offset, bytes.length);
    if (bytes.length) {
      memory.set(bytes.slice(), at);
      this.memoryChanged(name, at, bytes.length);
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
