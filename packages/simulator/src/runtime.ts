import { Emitter, type Event, type Disposable } from '@mica-js/core/lifecycle';
import {
  BuildError,
  validateDeviceIR,
  validateBoundBlockIR,
  createJitBlockBuilder,
  type DeviceIR,
  type DeclarationIR,
  type ComputationIR,
  type BlockIR,
  type RegionIR,
} from '@mica-js/device-model';
import {
  compileBody,
  compileComputation,
  type ExecutionHost,
  type ExecutionSignal,
  type CompiledBody,
  type ReactionFrame,
} from '@mica-js/compiler';
import {
  createElectricalNetwork,
  ElectricalError,
  type ElectricalPin,
  type ElectricalNetwork,
  type ResistorBranch,
} from './electrical';
import { EventQueue, Fifo } from './queue';
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
  same,
  snapshot,
} from './values';
import {
  SimulationError,
  type Board,
  type BoardDescription,
  type BoardOptions,
  type BoardStatus,
  type DeviceAdapter,
  type DeviceBatch,
  type DeviceContext,
  type DeviceLibrary,
  type DeviceLibraryEntry,
  type JitOptions,
  type RuntimeDiagnostic,
  type RuntimeDiagnosticCode,
  type RuntimePhase,
  type TopicBridge,
  type TopicMessage,
} from './types';

type Decl<K extends DeclarationIR['kind']> = Extract<DeclarationIR, { kind: K }>;
type Execution = Generator<ExecutionSignal, unknown, unknown>;
type Dependencies = ReadonlyMap<string, number>;
type Observation = Process | Reaction;
interface Entry {
  readonly id: string;
  readonly model: DeviceIR;
  readonly create: DeviceLibraryEntry['create'];
}
const libraries = new WeakMap<object, readonly Entry[]>();
const compiledBodies = new WeakMap<RegionIR, CompiledBody>();
const compiledComputations = new WeakMap<ComputationIR, (host: ExecutionHost) => unknown>();
const MAX_TIME = 7_200_000_000_000_000;
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value))
    throw new TypeError('Time must be a finite integer');
  if (value < 0 || value > MAX_TIME) throw new RangeError('Time out of range');
  return value === 0 ? 0 : value;
}
function body(region: RegionIR): CompiledBody {
  let result = compiledBodies.get(region);
  if (!result) {
    result = compileBody(region);
    compiledBodies.set(region, result);
  }
  return result;
}
function computation(value: ComputationIR, host: ExecutionHost): unknown {
  let result = compiledComputations.get(value);
  if (!result) {
    result = compileComputation(value);
    compiledComputations.set(value, result);
  }
  return result(host);
}
function thenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
class AsyncHookError extends TypeError {
  readonly code = 'ASYNC_HOOK_RESULT';
  constructor() {
    super('Device hooks must return synchronously');
  }
}
class ElectricalParameterError extends RangeError {
  readonly code = 'INVALID_ELECTRICAL_PARAMETER';
}
function electricalNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ElectricalParameterError('Electrical parameters must be finite numbers');
  return value;
}
function acceptSync(value: unknown): void {
  if (thenable(value)) {
    void Promise.resolve(value).catch(() => {});
    throw new AsyncHookError();
  }
}
function modelLocation(cause: unknown): Partial<Pick<RuntimeDiagnostic, 'path' | 'source'>> {
  if (!(cause instanceof BuildError)) return {};
  const diagnostic = cause.diagnostics[0];
  if (!diagnostic) return {};
  return {
    ...(diagnostic.path ? { path: Object.freeze([...diagnostic.path]) } : {}),
    ...(diagnostic.source
      ? { source: snapshot(diagnostic.source) as NonNullable<RuntimeDiagnostic['source']> }
      : {}),
  };
}
function standalone(
  code: RuntimeDiagnosticCode,
  cause: unknown,
  phase: RuntimePhase,
): SimulationError {
  return new SimulationError(
    Object.freeze({
      code,
      message: cause instanceof Error ? cause.message : String(cause),
      phase,
      time: null,
      cause,
      ...modelLocation(cause),
      related: Object.freeze([]),
    }),
  );
}
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
interface Message {
  readonly time: number;
  readonly value: unknown;
}
interface Channel {
  readonly declaration: Decl<'channel'>;
  readonly capacity: number;
  readonly maxLength?: number;
  readonly overflow: string;
  readonly incoming: Fifo<Message>;
  readonly pending: Fifo<Message>;
  readonly outgoing: Fifo<Message>;
  receiver?: Process;
}
interface Process {
  readonly instance: Instance;
  readonly declaration: Decl<'start'> | Decl<'on'>;
  readonly source?: readonly string[];
  previous?: unknown;
  order?: number;
  state: 'idle' | 'queued' | 'running' | 'waiting';
  pending: boolean;
  execution?: Execution;
}
interface Reaction {
  readonly instance: Instance;
  readonly declaration: Decl<'reaction'>;
  previous: unknown;
  order?: number;
}
interface Jit {
  readonly instance: Instance;
  readonly options: JitOptions;
  readonly cache: Map<number, BlockIR>;
  active: boolean;
  stopped: boolean;
  queued: boolean;
  ready: boolean;
  execution?: Execution;
  instruction?: BlockIR['instructions'][number];
  block?: BlockIR;
  version: number;
  activeVersion: number;
  predicate?: string;
  dependencies?: Dependencies;
  inHook: boolean;
}
interface TopicListener {
  readonly owner?: Instance;
  readonly call: (message: TopicMessage) => unknown;
}

function createContext(owner: Instance, board: BoardRuntime): DeviceContext {
  return Object.freeze({
    get props() {
      board.guard(owner, true);
      return Object.freeze(
        Object.fromEntries([...owner.props].map(([key, value]) => [key, externalValue(value)])),
      );
    },
    get inputs() {
      owner.guard();
      return owner.inputs();
    },
    get memory() {
      board.guard(owner, true);
      return owner.publicMemory();
    },
    topics: board.topicBridge(owner),
    reportError: (error: unknown) => board.report(owner, error),
    attachJit: (options: JitOptions) => owner.attach(options),
    loadBytes: (name: string, bytes: Uint8Array, ...offset: unknown[]) =>
      owner.loadBytes(name, bytes, offset.length ? offset[0] : 0),
  });
}

class Instance {
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
  readonly resources: Disposable[] = [];
  readonly jits: Jit[] = [];
  readonly processes: Process[] = [];
  readonly reactions: Reaction[] = [];
  readonly derived = new Map<string, { dependencies: Dependencies; value: unknown }>();
  private readonly versions = new Map<string, number>();
  private readonly dependencyStack: Map<string, number>[] = [];
  private readonly subscriptions = new Map<string, Set<Observation>>();
  private readonly observations = new WeakMap<Observation, Dependencies>();
  readonly evaluating = new Set<string>();
  readonly random: Uint32Array;
  readonly host: ExecutionHost;
  readonly context: DeviceContext;
  adapter?: DeviceAdapter;
  valid = true;
  rawProps: Record<string, unknown>;
  constructor(
    readonly board: BoardRuntime,
    readonly entry: Entry,
    readonly id: string,
    props: unknown,
    seed: number,
    override?: readonly number[],
  ) {
    for (const declaration of entry.model.declarations)
      if ('name' in declaration) this.declarations.set(declaration.name, declaration);
    dataObject(props);
    this.rawProps = props;
    for (const key of Object.keys(props))
      if (this.declarations.get(key)?.kind !== 'property')
        throw new TypeError(`Unknown property ${key}`);
    this.random = randomState(seed, id, override);
    this.host = {
      read: (kind, name) => this.read(kind, name),
      write: (name, value) => {
        if (!this.states.has(name)) throw new TypeError(`Unknown state ${name}`);
        this.states.set(name, snapshot(value));
        this.invalidate(`state:${name}`);
      },
      sample: (ref) => {
        const pin = this.pin(ref);
        this.track(`sample:${pin.name}`);
        return pin.sample;
      },
      intent: (pin, value) => {
        this.pin(pin).intent = value as readonly ResistorBranch[];
        board.electricalDirty = true;
      },
      resistor: (pin, resistance) => {
        const r = electricalNumber(resistance);
        if (r < 0.001 || r > 1e9)
          throw new ElectricalParameterError('Resistance outside [0.001, 1e9]');
        return Object.freeze([Object.freeze({ to: this.pin(pin), resistance: r })]);
      },
      memoryLength: (memory) => this.memory(memory).length,
      load: (kind, memory, offset) => {
        this.track(`memory:${String(memory)}`);
        const bytes = this.memory(memory),
          size = kind.startsWith('load8') ? 1 : kind.startsWith('load16') ? 2 : 4,
          at = range(bytes, offset, size);
        if (size === 1) return bytes[at]!;
        const view = this.memoryViews.get(String(memory))!;
        return size === 2
          ? view.getUint16(at, kind.endsWith('le'))
          : view.getUint32(at, kind.endsWith('le'));
      },
      store: (kind, memory, offset, value) => {
        const bytes = this.memory(memory),
          size = kind.startsWith('store8') ? 1 : kind.startsWith('store16') ? 2 : 4,
          at = range(bytes, offset, size),
          n = integer(value, 'stored value');
        if (size === 1) bytes[at] = n;
        else {
          const view = this.memoryViews.get(String(memory))!;
          if (size === 2) view.setUint16(at, n, kind.endsWith('le'));
          else view.setUint32(at, n, kind.endsWith('le'));
        }
        this.memoryChanged(String(memory));
      },
      copyBytes: (memory, offset, length) => {
        this.track(`memory:${String(memory)}`);
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
    };
    this.context = createContext(this, board);
  }
  private track(key: string): void {
    this.dependencyStack.at(-1)?.set(key, this.versions.get(key) ?? 0);
  }
  invalidate(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    for (const observation of this.subscriptions.get(key) ?? [])
      this.board.dirtyObservations.add(observation);
  }
  dependenciesCurrent(dependencies: Dependencies | undefined): boolean {
    if (!dependencies) return false;
    for (const [key, version] of dependencies)
      if ((this.versions.get(key) ?? 0) !== version) return false;
    return true;
  }
  evaluate<T>(compute: () => T): { value: T; dependencies: Dependencies } {
    const dependencies = new Map<string, number>();
    this.dependencyStack.push(dependencies);
    try {
      return { value: compute(), dependencies };
    } finally {
      this.dependencyStack.pop();
      const parent = this.dependencyStack.at(-1);
      if (parent) for (const [key, version] of dependencies) parent.set(key, version);
    }
  }
  observe(observation: Observation, path: readonly string[]): unknown {
    const observed = this.evaluate(() => snapshot(this.source(path)));
    for (const key of this.observations.get(observation)?.keys() ?? [])
      this.subscriptions.get(key)?.delete(observation);
    for (const key of observed.dependencies.keys()) {
      let subscribers = this.subscriptions.get(key);
      if (!subscribers) this.subscriptions.set(key, (subscribers = new Set()));
      subscribers.add(observation);
    }
    this.observations.set(observation, observed.dependencies);
    return observed.value;
  }
  read(kind: string, name: string): unknown {
    if (kind === 'state') {
      if (!this.states.has(name)) throw new TypeError(`Unknown state ${name}`);
      this.track(`state:${name}`);
      return this.states.get(name);
    }
    if (kind === 'derived') {
      let cached = this.derived.get(name);
      if (!cached || !this.dependenciesCurrent(cached.dependencies)) {
        const declaration = this.declarations.get(name);
        if (declaration?.kind !== 'derived') throw new TypeError(`Unknown derived ${name}`);
        cached = this.evaluate(() => computation(declaration.value, this.host));
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
  memory(ref: unknown): Uint8Array {
    const bytes = this.memories.get(String(ref));
    if (!bytes) throw new TypeError(`Unknown memory ${String(ref)}`);
    return bytes;
  }
  memoryChanged(name: string): void {
    this.invalidate(`memory:${name}`);
    for (const jit of this.jits)
      if (jit.options.code === name) {
        jit.version++;
        jit.cache.clear();
      }
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
            ...(declaration.kind === 'on' ? { source: declaration.sourcePath } : {}),
            state: 'idle',
            pending: false,
          });
          break;
        case 'reaction':
          this.reactions.push({ instance: this, declaration, previous: undefined });
          break;
      }
    }
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
  guard(): void {
    this.board.guard(this);
  }
  inputs(): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null);
    for (const declaration of this.entry.model.declarations) {
      if (declaration.kind === 'channel' && declaration.direction === 'input')
        result[declaration.name] = Object.freeze({
          send: (value: unknown) => {
            this.guard();
            this.send(declaration.name, value, true);
          },
        });
      if (declaration.kind === 'notification' && declaration.direction === 'input')
        result[declaration.name] = Object.freeze({
          notify: () => {
            this.guard();
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
          this.board.validity(this);
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
    this.guard();
    if (this.board.phase !== 'initialize' || this.board.current !== this)
      throw this.board.error('INVALID_CALL_STATE', 'attachJit is initialization-only', this);
    dataObject(options, ['entry', 'code', 'pc', 'beforeInstruction', 'translate']);
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
    const jit: Jit = {
      instance: this,
      options: Object.freeze({
        ...options,
        ...(options.beforeInstruction
          ? { beforeInstruction: Object.freeze({ ...options.beforeInstruction }) }
          : {}),
      }),
      cache: new Map(),
      active: true,
      stopped: false,
      queued: false,
      ready: true,
      version: 0,
      activeVersion: 0,
      inHook: false,
    };
    this.jits.push(jit);
    this.board.jits.push(jit);
    const disposable = {
      dispose: () => {
        if (!jit.active) return;
        jit.active = false;
        delete jit.execution;
        delete jit.predicate;
        jit.cache.clear();
      },
    };
    this.resources.push(disposable);
    return disposable;
  }
  loadBytes(name: string, bytes: Uint8Array, offset: unknown): void {
    this.guard();
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
    if (declaration?.kind === 'pin') {
      this.track(`sample:${declaration.name}`);
      value = { sample: this.pin(declaration.name).sample };
    } else if (declaration?.kind === 'state' || declaration?.kind === 'derived')
      value = this.read(declaration.kind, declaration.name);
    else throw new TypeError(`Invalid source ${path.join('.')}`);
    for (const field of path.slice(1)) value = (value as Record<string, unknown>)[field];
    return value;
  }
}

class BoardRuntime implements Board {
  time = 0;
  status: BoardStatus = 'ready';
  phase = 'assembly';
  current: Instance | undefined;
  electricalDirty = true;
  readonly dirtyObservations = new Set<Observation>();
  private readonly byId = new Map<string, Instance>();
  private dispatchDepth = 0;
  private initialized = false;
  private readonly errors = new Emitter<RuntimeDiagnostic>();
  private readonly diagnostics = new Emitter<RuntimeDiagnostic>();
  private readonly listeners = new Set<TopicListener>();
  private readonly models = new Fifo<Process>();
  private readonly events = new EventQueue<() => void>();
  private readonly readyJits = new Fifo<Jit>();
  readonly jits: Jit[] = [];
  readonly instances: Instance[] = [];
  private network!: ElectricalNetwork;
  private primary: SimulationError | undefined;
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
      dataObject(options, ['seed']);
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
      this.network = createElectricalNetwork(
        this.instances.flatMap((instance) => [...instance.pins.values()]),
        nets,
      );
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
  private queueJit(jit: Jit): void {
    if (jit.active && !jit.stopped && !jit.queued) {
      jit.queued = true;
      jit.ready = true;
      this.readyJits.push(jit);
    }
  }
  private publish(): void {
    if (!this.electricalDirty) return;
    const changed = this.network.solve();
    this.electricalDirty = false;
    for (const pin of changed) this.byId.get(pin.instance)!.invalidate(`sample:${pin.name}`);
  }
  private baseline(): void {
    this.publish();
    let order = 0;
    for (const instance of this.instances) {
      for (const process of instance.processes)
        if (
          process.source &&
          instance.declarations.get(process.source[0]!)?.kind !== 'notification'
        ) {
          process.order = order++;
          process.previous = instance.observe(process, process.source);
        }
      for (const reaction of instance.reactions) {
        reaction.order = order++;
        reaction.previous = instance.observe(reaction, reaction.declaration.sourcePath);
      }
    }
  }
  private boundary(): void {
    for (;;) {
      this.publish();
      if (!this.dirtyObservations.size) return;
      const observations = [...this.dirtyObservations].sort((a, b) => a.order! - b.order!);
      this.dirtyObservations.clear();
      const reactions: { reaction: Reaction; frame: ReactionFrame }[] = [];
      for (const observation of observations) {
        const path =
          observation.declaration.kind === 'reaction'
            ? observation.declaration.sourcePath
            : (observation as Process).source!;
        const current = observation.instance.observe(observation, path);
        if (same(observation.previous, current)) continue;
        const previous = observation.previous;
        observation.previous = current;
        if (observation.declaration.kind === 'reaction')
          reactions.push({
            reaction: observation as Reaction,
            frame: { previous, current, captures: [] },
          });
        else this.enqueue(observation as Process);
      }
      if (!reactions.length) return;
      for (const item of reactions)
        item.frame = {
          ...item.frame,
          captures: item.reaction.declaration.captures.map((capture) =>
            snapshot(computation(capture.value, item.reaction.instance.host)),
          ),
        };
      for (const item of reactions) {
        this.current = item.reaction.instance;
        const step = body(item.reaction.declaration.body)(
          item.reaction.instance.host,
          [],
          item.frame,
        ).next();
        if (!step.done) throw new TypeError('Reaction cannot suspend');
      }
    }
  }
  private drive(process: Process, value?: unknown): void {
    this.current = process.instance;
    process.state = 'running';
    process.execution ??= body(process.declaration.body)(process.instance.host);
    for (;;) {
      const step = process.execution.next(value);
      if (step.done) {
        this.boundary();
        delete process.execution;
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
      } else
        this.events.push(due, () => {
          process.state = 'queued';
          this.models.push(process);
        });
      return;
    }
  }
  private jitSignal(jit: Jit, signal: ExecutionSignal): boolean {
    if (signal.kind === 'elapse') {
      const duration = time(signal.duration);
      if (duration === 0) return false;
      const due = time(this.time + duration);
      jit.ready = false;
      this.events.push(due, () => this.queueJit(jit));
      this.boundary();
      return true;
    }
    if (signal.kind === 'waitUntil') {
      const checked = jit.instance.evaluate(() => jit.instance.syncCall(signal.predicate));
      if (checked.value === true) return false;
      jit.predicate = signal.predicate;
      jit.dependencies = checked.dependencies;
      jit.ready = false;
      this.boundary();
      return true;
    }
    if (signal.kind === 'stop') {
      jit.stopped = true;
      delete jit.execution;
      this.boundary();
      return true;
    }
    if (signal.kind === 'redirect') {
      finite(signal.pc, 'redirect target');
      const duration = time(signal.delay);
      jit.instance.host.write(jit.options.pc, signal.pc);
      delete jit.execution;
      delete jit.instruction;
      delete jit.block;
      jit.inHook = false;
      jit.ready = false;
      this.boundary();
      if (duration === 0) this.queueJit(jit);
      else this.events.push(time(this.time + duration), () => this.queueJit(jit));
      return true;
    }
    throw new TypeError('Invalid JIT suspension');
  }
  private runJit(jit: Jit): void {
    jit.queued = false;
    if (!jit.active || jit.stopped) return;
    this.current = jit.instance;
    if (!jit.execution) {
      const hook = jit.options.beforeInstruction;
      if (
        hook &&
        jit.instance.read(jit.instance.declarations.get(hook.when)!.kind, hook.when) === true
      ) {
        const execution = jit.instance.invoke(hook.call);
        const step = execution.next();
        if (!step.done) {
          jit.execution = execution;
          jit.inHook = true;
          if (this.jitSignal(jit, step.value)) return;
          throw new TypeError('Invalid hook suspension');
        }
      }
      const pc = finite(jit.instance.states.get(jit.options.pc), 'pc');
      let block = jit.cache.get(pc);
      if (!block) {
        const prior = this.phase;
        this.phase = 'translate';
        let valid = true;
        try {
          const code = bytesView(jit.instance.memory(jit.options.code), () => {
            if (!valid)
              throw this.error('OBJECT_DISPOSED', 'Translation view expired', jit.instance);
          });
          const result = jit.options.translate(
            Object.freeze({ pc, code: code as import('./types').BorrowedBytes }),
            createJitBlockBuilder({ device: jit.instance.entry.model }),
          );
          acceptSync(result);
          block = validateBoundBlockIR(result, jit.instance.entry.model);
          if (block.instructions[0]?.pc !== pc)
            throw new TypeError('Translated first pc does not match');
          for (const instruction of block.instructions) body(instruction.body);
          for (const instruction of block.instructions) jit.cache.set(instruction.pc, block);
        } catch (cause) {
          throw this.wrap(cause, 'JIT_FAILED', 'translate', jit.instance);
        } finally {
          valid = false;
          this.phase = prior;
        }
      }
      const instruction = block.instructions.find((item) => item.pc === pc);
      if (!instruction) throw new TypeError('Missing instruction');
      jit.block = block;
      jit.instruction = instruction;
      jit.activeVersion = jit.version;
      jit.instance.host.write(jit.options.pc, instruction.nextPc);
      jit.execution = body(instruction.body)(jit.instance.host);
    }
    for (;;) {
      const step = jit.execution.next();
      if (step.done) {
        delete jit.execution;
        delete jit.instruction;
        delete jit.block;
        jit.inHook = false;
        this.boundary();
        this.queueJit(jit);
        return;
      }
      if (this.jitSignal(jit, step.value)) return;
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
          for (const message of channel.pending.drain()) channel.incoming.push(message);
          if (channel.receiver && channel.incoming.length) {
            const process = channel.receiver;
            delete channel.receiver;
            const received = channel.incoming.shift().value;
            this.events.push(this.time, () => {
              process.state = 'queued';
              this.models.push(Object.assign(process, { resumeValue: received }));
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
          const process = this.models.shift() as Process & { resumeValue?: unknown };
          const value = process.resumeValue;
          delete process.resumeValue;
          this.drive(process, value);
          if (this.isFaulted) throw this.primary!;
          continue;
        }
        for (const jit of this.jits)
          if (
            jit.active &&
            !jit.stopped &&
            jit.predicate &&
            !jit.instance.dependenciesCurrent(jit.dependencies)
          ) {
            const checked = jit.instance.evaluate(() => jit.instance.syncCall(jit.predicate!));
            jit.dependencies = checked.dependencies;
            if (checked.value === true) {
              delete jit.predicate;
              delete jit.dependencies;
              this.queueJit(jit);
            }
          }
        if (this.time < end && this.readyJits.length) {
          this.runJit(this.readyJits.shift());
          if (this.isFaulted) throw this.primary!;
          continue;
        }
        if (this.events.time <= end) {
          this.time = this.events.time;
          continue;
        }
        this.time = end;
        break;
      }
      const batches: DeviceBatch[] = this.instances.map((instance) => {
        const outputs: Record<string, unknown> = Object.create(null);
        for (const [name, channel] of instance.channels) {
          channel.incoming.clear();
          if (channel.declaration.direction === 'output')
            outputs[name] = Object.freeze(
              channel.outgoing
                .drain()
                .map((message) =>
                  Object.freeze({ time: message.time, value: externalValue(message.value) }),
                ),
            );
        }
        for (const [name, notified] of instance.notificationOutputs) {
          outputs[name] = notified === null ? null : Object.freeze({ time: notified });
          instance.notificationOutputs.set(name, null);
        }
        return Object.freeze({ from, to: end, outputs: Object.freeze(outputs) });
      });
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
