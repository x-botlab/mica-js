/**
 * Production headless runtime of the fused device contract (RFC 0025).
 *
 * The runtime owns one document snapshot, one prepared set of package bytes and one simulator
 * board. It runs in the caller's thread, reuses the production simulator and its electrical solver,
 * loads models through the caller-supplied `loadModule` and serializes every state change at a safe
 * boundary: method calls, `step`, `resume`, `pause`, `reset` and `dispose` never interleave.
 */
import { MAX_TIME_PS, timePs } from '@mica-js/core';
import type { TimePs } from '@mica-js/core';
import { Emitter } from '@mica-js/core/lifecycle';
import type { Event } from '@mica-js/core/lifecycle';
import type { DeviceRegistry, FusedDocument, PackageFiles, Value } from '@mica-js/document/fused';
import { SimulationError, createBoard, createDeviceLibrary } from '@mica-js/simulator';
import type {
  Board,
  BoardDescription,
  DeviceContext,
  DeviceLibraryEntry,
} from '@mica-js/simulator';
import { diagnostic } from './diagnostics.js';
import type { DiagnosticSink, RuntimeDiagnostic } from './diagnostics.js';
import { ModelBinding, ModelDisconnectedError, ModelFault } from './models.js';
import { MethodError, isMethodError } from './model.js';
import type { RuntimeModelClient, RuntimeModelEvent } from './models.js';
import { MICA_HOST_API_VERSION } from './package.js';
import { prepareFusedSession } from './prepare.js';
import type { PreparedSession } from './prepare.js';
import type { FirmwareProjectSource } from './firmware.js';
import type { ResourceResolver } from './properties.js';
import { snapshotValue } from './values.js';

export interface HeadlessRuntimeOptions {
  /** Fused `.sch` version 2 document; snapshotted before anything runs. */
  readonly document: FusedDocument;
  /** Resolves the locked packages of this document. */
  readonly registry: DeviceRegistry;
  /** Loads one declared package entry; explicit and in-process, no implicit resolution. */
  readonly loadModule: (files: PackageFiles, path: string) => Promise<unknown>;
  /** Fixed positive step of every advance; constant for the whole session. */
  readonly step: TimePs;
  /** Explicit resolver of `file` and `store` property resources. */
  readonly resolveResource?: ResourceResolver;
  /** Firmware project service; required by `firmware` properties with project references. */
  readonly projects?: FirmwareProjectSource;
  /** Observer of every model event, installed before model initialization. */
  readonly onModelEvent?: (event: RuntimeModelEvent) => void;
  /** Receives preparation and runtime diagnostics that have no event subscriber yet. */
  readonly onDiagnostic?: DiagnosticSink;
}

export interface RuntimeState {
  readonly status: 'running' | 'paused' | 'faulted' | 'disposed';
  readonly simTime: TimePs;
}

/** Thrown or rejected by runtime operations; `code` is a stable contract code. */
export class FusedRuntimeError extends Error {
  readonly code: string;
  readonly instanceId?: string;

  constructor(code: string, message: string, instanceId?: string) {
    super(message);
    this.name = 'FusedRuntimeError';
    this.code = code;
    if (instanceId !== undefined) {
      this.instanceId = instanceId;
    }
  }
}

export interface HeadlessRuntime {
  getState(): RuntimeState;
  readonly onDidChangeState: Event<RuntimeState>;
  readonly onDidReportDiagnostic: Event<RuntimeDiagnostic>;
  /** Host client of one modeled instance; the same instance id keeps one client per session. */
  getModel(instanceId: string): RuntimeModelClient;
  /** Advances exactly one fixed step; only valid while paused. */
  step(): Promise<void>;
  /** Starts continuous fixed-step advancement and resolves after the first step. */
  resume(): Promise<void>;
  /** Stops advancement synchronously, keeping models, listeners and view state. */
  pause(): void;
  /** Replaces the session with fresh models built from the same captured bytes and modules. */
  reset(): Promise<void>;
  /** Releases the board, models, listeners and emitters; safe to call more than once. */
  dispose(): Promise<void>;
}

const DISCONNECTED = 'model/disconnected';

class Session {
  readonly board: Board;
  readonly #bindings = new Map<string, ModelBinding>();

  constructor(prepared: PreparedSession, hooks: SessionHooks) {
    const pending = new Map<string, ModelBinding[]>();
    for (const instance of prepared.instances) {
      const device = prepared.devices.get(instance.deviceId);
      const definition = device?.package.manifest.model;
      if (device?.model === undefined || definition === undefined) {
        continue;
      }
      const binding = new ModelBinding({
        instanceId: instance.instanceId,
        methods: definition.methods ?? {},
        events: definition.events ?? {},
        types: definition.types ?? {},
        props: instance.props,
        factory: device.model.create,
        report: hooks.report,
        blocked: hooks.blocked,
        now: hooks.now,
        ...(hooks.observer === undefined ? {} : { observer: hooks.observer }),
      });
      this.#bindings.set(instance.instanceId, binding);
      const queue = pending.get(instance.deviceId);
      if (queue === undefined) {
        pending.set(instance.deviceId, [binding]);
      } else {
        queue.push(binding);
      }
    }

    const entries: DeviceLibraryEntry[] = [];
    for (const [deviceId, device] of prepared.devices) {
      if (device.model === undefined) {
        continue;
      }
      entries.push({
        id: deviceId,
        model: device.model.ir,
        create: (context: DeviceContext) => {
          // The board creates instances in description order, which is document order, so each
          // device type consumes its prepared bindings in the same order.
          const binding = pending.get(deviceId)?.shift();
          if (binding === undefined) {
            throw new Error(`Unexpected model factory call for "${deviceId}"`);
          }
          return binding.create(context);
        },
      });
    }

    const description: BoardDescription = {
      instances: prepared.instances.map((instance) => ({
        id: instance.instanceId,
        type: instance.deviceId,
        props: { ...instance.boardProps },
      })),
      nets: prepared.nets.map((net) => ({
        id: net.id,
        pins: net.pins.map((pin) => ({ instance: pin.instance, pin: pin.pin })),
        ...(net.voltage === undefined ? {} : { voltage: net.voltage }),
      })),
    };
    this.board = createBoard(createDeviceLibrary(entries), description);
  }

  binding(instanceId: string): ModelBinding | undefined {
    return this.#bindings.get(instanceId);
  }

  invalidate(): void {
    for (const binding of this.#bindings.values()) {
      binding.invalidate();
    }
    this.#bindings.clear();
  }
}

interface SessionHooks {
  readonly observer?: (event: RuntimeModelEvent) => void;
  readonly report: (entry: RuntimeDiagnostic) => void;
  readonly blocked: () => string | undefined;
  readonly now: () => TimePs;
}

class HeadlessRuntimeImpl implements HeadlessRuntime {
  readonly #prepared: PreparedSession;
  readonly #step: number;
  readonly #onModelEvent: ((event: RuntimeModelEvent) => void) | undefined;
  readonly #onDiagnostic: DiagnosticSink | undefined;
  readonly #stateEmitter = new Emitter<RuntimeState>();
  readonly #diagnosticEmitter = new Emitter<RuntimeDiagnostic>();
  readonly #queue: (() => void)[] = [];
  #status: RuntimeState['status'] = 'paused';
  #session: Session | undefined;
  #pumping = false;
  #pumpDone: Promise<void> | undefined;
  #modelInputAllowed = false;

  readonly onDidChangeState: Event<RuntimeState> = this.#stateEmitter.event;
  readonly onDidReportDiagnostic: Event<RuntimeDiagnostic> = this.#diagnosticEmitter.event;

  constructor(prepared: PreparedSession, options: HeadlessRuntimeOptions, step: number) {
    this.#prepared = prepared;
    this.#step = step;
    this.#onModelEvent = options.onModelEvent;
    this.#onDiagnostic = options.onDiagnostic;
    this.#session = this.#createSession();
  }

  getState(): RuntimeState {
    const simTime = timePs(this.#session?.board.time ?? 0);
    return Object.freeze({ status: this.#status, simTime });
  }

  getModel(instanceId: string): RuntimeModelClient {
    if (this.#status === 'disposed') {
      throw new FusedRuntimeError(
        DISCONNECTED,
        'The runtime is disposed; no model client is available.',
        instanceId,
      );
    }
    const binding = this.#session?.binding(instanceId);
    if (binding === undefined) {
      throw new FusedRuntimeError(
        'model/unknown-instance',
        `No live model for instance "${instanceId}"; modeled instance ids are declared by the document.`,
        instanceId,
      );
    }
    return binding.client((name, params) => this.#invokeFromClient(binding, name, params));
  }

  async step(): Promise<void> {
    this.#assertAdvanceAllowed('step');
    if (this.#status === 'running') {
      throw new FusedRuntimeError(
        'runtime/unavailable-state',
        'step requires the paused state; pause the runtime first.',
      );
    }
    await this.#schedule(() => this.#advance());
  }

  async resume(): Promise<void> {
    this.#assertAdvanceAllowed('resume');
    if (this.#status === 'running') {
      return;
    }
    this.#setStatus('running');
    await this.#schedule(() => {
      if (this.#status === 'running') {
        this.#advance();
      }
    });
  }

  pause(): void {
    if (this.#status === 'running') {
      this.#setStatus('paused');
    }
  }

  async reset(): Promise<void> {
    if (this.#status === 'disposed') {
      throw new FusedRuntimeError('runtime/unavailable-state', 'The runtime is disposed.');
    }
    this.#setStatus('paused');
    await this.#settle();
    const previous = this.#session;
    this.#session = undefined;
    if (previous !== undefined) {
      // The board owns the adapters, so it disposes the models before the clients go stale.
      let cleanup: FusedRuntimeError | undefined;
      try {
        previous.board.dispose();
      } catch (cause) {
        cleanup = new FusedRuntimeError(
          'runtime/model-failed',
          `Board cleanup failed during reset: ${messageOf(cause)}`,
          cause instanceof SimulationError ? cause.diagnostic.instanceId : undefined,
        );
      } finally {
        previous.invalidate();
      }
      if (cleanup !== undefined) {
        // A half-released session must not be reported as a successful reset.
        this.#fault(cleanup, true);
        throw cleanup;
      }
    }
    this.#session = this.#createSession();
    this.#emitState();
  }

  async dispose(): Promise<void> {
    if (this.#status === 'disposed') {
      return;
    }
    this.#setStatus('disposed');
    await this.#settle();
    const session = this.#session;
    this.#session = undefined;
    const problems: RuntimeDiagnostic[] = [];
    if (session !== undefined) {
      try {
        session.board.dispose();
      } catch (cause) {
        const fault = modelFaultOf(cause);
        problems.push(
          diagnostic(
            fault?.code ?? 'runtime/model-failed',
            `Board cleanup failed: ${messageOf(cause)}`,
          ),
        );
      }
      session.invalidate();
    }
    this.#stateEmitter.dispose();
    this.#diagnosticEmitter.dispose();
    for (const entry of problems) {
      this.#onDiagnostic?.(entry);
    }
    if (problems.length > 0) {
      throw new FusedRuntimeError(
        problems[0]!.code,
        problems.map((entry) => entry.message).join('; '),
      );
    }
  }

  #createSession(): Session {
    // Factories and their initial events run inside the board initialization phase.
    this.#modelInputAllowed = true;
    try {
      return new Session(this.#prepared, {
        report: (entry) => this.#report(entry),
        blocked: () =>
          this.#modelInputAllowed && (this.#status === 'paused' || this.#status === 'running')
            ? undefined
            : 'model input is only allowed during initialization, method calls, sync and advance',
        now: () => timePs(this.#session?.board.time ?? 0),
        ...(this.#onModelEvent === undefined ? {} : { observer: this.#onModelEvent }),
      });
    } finally {
      this.#modelInputAllowed = false;
    }
  }

  #assertAdvanceAllowed(operation: string): void {
    if (this.#status === 'disposed') {
      throw new FusedRuntimeError(
        'runtime/unavailable-state',
        `${operation} is not allowed after dispose.`,
      );
    }
    if (this.#status === 'faulted') {
      throw new FusedRuntimeError(
        'runtime/model-failed',
        `${operation} is not allowed while the runtime is faulted; call reset first.`,
      );
    }
  }

  #advance(): void {
    const session = this.#session;
    if (session === undefined) {
      throw new FusedRuntimeError('runtime/unavailable-state', 'No session is prepared.');
    }
    const from = session.board.time;
    const target = from + this.#step;
    if (target > MAX_TIME_PS) {
      const error = new FusedRuntimeError(
        'runtime/invalid-time',
        `Advancing ${this.#step} ps from ${from} ps exceeds the supported simulation time range.`,
      );
      this.#report(diagnostic(error.code, error.message));
      if (this.#status === 'running') {
        this.#setStatus('paused');
      }
      throw error;
    }
    this.#modelInputAllowed = true;
    try {
      session.board.runUntil(target);
    } catch (cause) {
      throw this.#faultFrom(cause);
    } finally {
      this.#modelInputAllowed = false;
    }
    this.#emitState();
  }

  #invokeFromClient(binding: ModelBinding, name: string, params: Value): Promise<Value> {
    if (!binding.live) {
      return Promise.reject(new ModelDisconnectedError());
    }
    let captured: Value;
    try {
      captured = binding.prepareParams(name, params);
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
    if (this.#status === 'disposed') {
      return Promise.reject(
        new FusedRuntimeError(DISCONNECTED, 'The runtime is disposed.', binding.instanceId),
      );
    }
    return this.#schedule(() => this.#execute(binding, name, captured));
  }

  #execute(binding: ModelBinding, name: string, params: Value): Value {
    if (!binding.live) {
      throw new ModelDisconnectedError();
    }
    if (this.#status === 'faulted') {
      throw new FusedRuntimeError(
        'runtime/model-failed',
        'The runtime is faulted; method calls are rejected until reset.',
        binding.instanceId,
      );
    }
    this.#modelInputAllowed = true;
    try {
      const result = binding.invoke(name, params);
      return binding.captureResult(name, result);
    } catch (cause) {
      throw this.#callFailure(binding, name, cause);
    } finally {
      this.#modelInputAllowed = false;
    }
  }

  #callFailure(binding: ModelBinding, name: string, cause: unknown): unknown {
    if (isMethodError(cause)) {
      // Declared business rejection: the model keeps running and only this call rejects.
      return this.#businessRejection(binding, name, cause);
    }
    if (cause instanceof ModelDisconnectedError || cause instanceof FusedRuntimeError) {
      return cause;
    }
    if (cause instanceof ModelFault) {
      const error = new FusedRuntimeError(cause.code, cause.message, binding.instanceId);
      this.#fault(error, false);
      return error;
    }
    const error = new FusedRuntimeError(
      'model/execution-failed',
      `Method "${name}" failed: ${messageOf(cause)}`,
      binding.instanceId,
    );
    this.#fault(error, true);
    return error;
  }

  /**
   * Rebuilds a business rejection as this SDK's `MethodError`.
   *
   * A bundled model artifact constructs its own copy of the class, so the fields are carried over
   * and `details` is captured as an independent value; the caller always sees a class of this
   * runtime and the model keeps running.
   */
  #businessRejection(binding: ModelBinding, name: string, cause: MethodError): MethodError {
    const details = cause.details;
    if (details === undefined) {
      return new MethodError(cause.code, cause.message);
    }
    try {
      return new MethodError(cause.code, cause.message, snapshotValue(details));
    } catch (failure) {
      this.#report(
        diagnostic(
          'model/invalid-result',
          `Details of the rejection "${cause.code}" of method "${name}" are not a model value: ${messageOf(failure)}`,
          binding.instanceId,
        ),
      );
      return new MethodError(cause.code, cause.message);
    }
  }

  #faultFrom(cause: unknown): FusedRuntimeError {
    const fault = modelFaultOf(cause);
    const board = cause instanceof SimulationError ? cause.diagnostic : undefined;
    const instanceId = board?.instanceId;
    const detail =
      board === undefined
        ? messageOf(cause)
        : `${board.code} at ${String(board.time)} ps: ${board.message}`;
    const error = new FusedRuntimeError('runtime/model-failed', detail, instanceId);
    // A model fault already reported itself with its own contract code.
    this.#fault(error, fault === undefined);
    return error;
  }

  #fault(error: FusedRuntimeError, report: boolean): void {
    if (report) {
      this.#report(diagnostic(error.code, error.message, error.instanceId));
    }
    if (this.#status === 'running' || this.#status === 'paused') {
      this.#setStatus('faulted');
    }
  }

  /**
   * Delivers one diagnostic.
   *
   * Delivery problems are surfaced instead of swallowed: a failing sink or listener is logged as a
   * secondary host failure, and a failing listener is additionally reported to the sink.
   */
  #report(entry: RuntimeDiagnostic): void {
    const sink = this.#onDiagnostic;
    if (sink !== undefined) {
      try {
        sink(entry);
      } catch (cause) {
        this.#fallback('the onDiagnostic sink', cause);
      }
    }
    try {
      this.#diagnosticEmitter.fire(entry);
    } catch (cause) {
      const secondary = diagnostic(
        'runtime/presentation-failed',
        `A diagnostic listener failed: ${messageOf(cause)}`,
        entry.instanceId,
      );
      if (sink === undefined) {
        this.#fallback('a diagnostic listener', cause);
        return;
      }
      try {
        sink(secondary);
      } catch (nested) {
        this.#fallback('the onDiagnostic sink', nested);
      }
    }
  }

  /** Last resort of reporting: a failure must never silently disappear. */
  #fallback(what: string, cause: unknown): void {
    try {
      console.error(`[mica fused] ${what} failed:`, cause);
    } catch {
      /* Nothing else can carry the failure at this point. */
    }
  }

  #setStatus(status: RuntimeState['status']): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.#emitState();
  }

  #emitState(): void {
    const state = this.getState();
    try {
      this.#stateEmitter.fire(state);
    } catch (cause) {
      this.#report(
        diagnostic('runtime/presentation-failed', `A state listener failed: ${messageOf(cause)}`),
      );
    }
  }

  #schedule<T>(task: () => T): Promise<T> {
    if (this.#status === 'disposed') {
      return Promise.reject(new FusedRuntimeError(DISCONNECTED, 'The runtime is disposed.'));
    }
    return new Promise<T>((resolve, reject) => {
      this.#queue.push(() => {
        try {
          resolve(task());
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
      this.#start();
    });
  }

  #start(): void {
    if (this.#pumping || this.#status === 'disposed') {
      return;
    }
    this.#pumping = true;
    let settle: () => void = () => {};
    this.#pumpDone = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const done = settle;
    void this.#pump(done);
  }

  async #pump(done: () => void): Promise<void> {
    try {
      for (;;) {
        const command = this.#queue.shift();
        if (command !== undefined) {
          command();
          // Let the settled promise of this command run its continuations before the next
          // command (and therefore its events) is produced: a query response is applied before
          // an event caused by a later call, as RFC 0021 requires.
          await nextMicrotaskBoundary();
          continue;
        }
        if (this.#status !== 'running' || this.#session === undefined) {
          break;
        }
        try {
          this.#advance();
        } catch {
          if (this.#status !== 'running') {
            break;
          }
        }
        await yieldToHost();
      }
    } finally {
      this.#pumping = false;
      this.#pumpDone = undefined;
      done();
    }
  }

  async #settle(): Promise<void> {
    while (this.#pumping) {
      const done = this.#pumpDone;
      if (done === undefined) {
        break;
      }
      await done;
    }
  }
}

function modelFaultOf(cause: unknown): ModelFault | undefined {
  if (cause instanceof ModelFault) {
    return cause;
  }
  if (cause instanceof SimulationError) {
    return modelFaultOf(cause.diagnostic.cause);
  }
  return undefined;
}

/**
 * One queued microtask boundary.
 *
 * The resolution callback is enqueued with `queueMicrotask`, so it sits *behind* the reaction a
 * caller attached to the settled command promise in the same job: that reaction applies the result
 * before the pump resumes with the next command and its events. Handlers chained later or behind an
 * `await` are the receiver's ordering responsibility, as RFC 0021 states.
 */
function nextMicrotaskBoundary(): Promise<void> {
  return new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}

function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Creates one headless runtime.
 *
 * Resolves paused, at simulation time zero, with models initialized and their initial events
 * already delivered to `onModelEvent`. Rejects with {@link FusedPreparationError} without running
 * any model factory when the document, a package, the topology, a resource or a model interface is
 * invalid.
 */
export async function createHeadlessRuntime(
  options: HeadlessRuntimeOptions,
): Promise<HeadlessRuntime> {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createHeadlessRuntime expects an options object');
  }
  if (typeof options.loadModule !== 'function') {
    throw new TypeError('options.loadModule must be a function');
  }
  if (options.registry === null || typeof options.registry?.open !== 'function') {
    throw new TypeError('options.registry must open locked device packages');
  }
  let step: number;
  try {
    step = timePs(options.step);
  } catch (cause) {
    const entry = diagnostic('runtime/invalid-time', messageOf(cause));
    options.onDiagnostic?.(entry);
    throw new FusedRuntimeError(entry.code, entry.message);
  }
  if (step <= 0) {
    const entry = diagnostic(
      'runtime/invalid-time',
      'options.step must be a positive TimePs value',
    );
    options.onDiagnostic?.(entry);
    throw new FusedRuntimeError(entry.code, entry.message);
  }

  const prepared = await prepareFusedSession({
    document: options.document,
    registry: options.registry,
    loadModule: options.loadModule,
    hostApiVersion: MICA_HOST_API_VERSION,
    ...(options.resolveResource === undefined ? {} : { resolveResource: options.resolveResource }),
    ...(options.projects === undefined ? {} : { projects: options.projects }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });
  return new HeadlessRuntimeImpl(prepared, options, step);
}
