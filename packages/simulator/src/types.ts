import type { SchedulerOptions, TimePs } from '@mica-js/core';
import type { SchematicDocument } from '@mica-js/core/schematic';
import type { IDeviceProvider, TopicPayload, TopicPayloadType } from '@mica-js/device';

/** Lifecycle of one executor. `ready` is the only state that can advance. */
export type SimulationState = 'idle' | 'ready' | 'faulted' | 'disposed';

/**
 * One logical endpoint of the running schematic.
 *
 * `symbol` + `port` is the same pair a canvas binding refers to, and `direction` / `type` match
 * `DevicePortDescriptor`, so a host can build binding candidates without touching the devices.
 */
export interface DeviceTopic {
  /** Symbol id inside the schematic (`SchematicSymbol.id`). */
  readonly symbol: string;
  /** Port key declared by the device description. */
  readonly port: string;
  readonly direction: 'input' | 'output';
  readonly type: TopicPayloadType;
  readonly title?: string;
}

export interface DeviceTopicTarget {
  readonly symbol: string;
  readonly port: string;
}

/** One payload a device published while the simulation was running. */
export interface DevicePublish {
  readonly target: DeviceTopicTarget;
  readonly payload: TopicPayload;
  /** Virtual time captured when the device published. */
  readonly simTime: TimePs;
}

export type AdvanceReason = 'until' | 'empty' | 'entry-limit' | 'paused';

/** Result of one {@link DeviceSimExecutor.advance} call. */
export interface AdvanceReport {
  readonly from: TimePs;
  /** Virtual time after the call; equals {@link DeviceSimExecutor.getSimTime}. */
  readonly to: TimePs;
  /** Entries the scheduler executed during this call. */
  readonly executed: number;
  readonly reason: AdvanceReason;
}

export type SimulationDiagnosticCode =
  | 'simulator/device-load-failed'
  | 'simulator/instance-create-failed'
  | 'simulator/advance-failed'
  | 'simulator/publish-failed'
  | 'simulator/dispose-failed';

/** A problem the executor survives; the simulation keeps running unless stated otherwise. */
export interface SimulationDiagnostic {
  readonly code: SimulationDiagnosticCode;
  readonly message: string;
  /** Symbol the problem belongs to, when it is attributable to one. */
  readonly symbol?: string;
  readonly cause?: unknown;
}

export interface DeviceSimExecutorOptions {
  /** Device descriptions and code; the schematic only names device ids. */
  readonly devices: IDeviceProvider;
  readonly scheduler?: SchedulerOptions;
  readonly onDiagnostic?: (diagnostic: SimulationDiagnostic) => void;
}

/**
 * Runs the devices of one schematic on a single virtual clock.
 *
 * The executor owns the scheduler, the device instances and the topic routing; the host owns the
 * clock: it calls {@link advance} with the slice of time it wants simulated and dispatches widget
 * input through {@link deliver}. Every getter returns the current value at call time.
 */
export interface DeviceSimExecutor {
  getState(): SimulationState;
  /** Current virtual time; `0` before the first `loadSchematic`. */
  getSimTime(): TimePs;
  /** Schematic the current runtime was built from; the empty sheet before the first load. */
  getSchematic(): SchematicDocument;
  /** Endpoints of the running instances, in schematic order; empty while `idle`. */
  getTopics(): readonly DeviceTopic[];

  /**
   * Builds a runtime for `document` and mounts one device instance per symbol.
   *
   * The new runtime is built before the old one is dropped, so a rejected load leaves the previous
   * simulation untouched. Resolves once every `initialize` entry has run, with the clock back at 0.
   *
   * @throws {SimulatorError} when a device cannot be loaded or instantiated.
   */
  loadSchematic(document: SchematicDocument): Promise<void>;

  /**
   * Advances the virtual clock by `delta` picoseconds and runs everything scheduled up to it.
   *
   * Synchronous on purpose: the whole slice runs inside the call, so the host can drive it from a
   * frame loop and read {@link AdvanceReport} right away. Payloads queued by {@link deliver} are
   * consumed at the start of the slice.
   *
   * @throws {SimulatorError} when the executor is idle, disposed or `delta` is not positive.
   * @throws when a device faults; `getState()` is then `'faulted'`.
   */
  advance(delta: TimePs): AdvanceReport;

  /** Subscribes to device publishes; returns the unsubscribe function. */
  onPublish(listener: (publish: DevicePublish) => void): () => void;

  /**
   * Queues one payload for a device input port.
   *
   * Delivery is deferred to the next {@link advance}, so a host can post several events for the
   * same instant and have the devices observe them in call order.
   *
   * @throws {SimulatorError} when the symbol or port is unknown, or the port is an output.
   */
  deliver(target: DeviceTopicTarget, payload: TopicPayload): void;

  /** Drops the running instances and rebuilds them from the current schematic at time 0. */
  reset(): Promise<void>;

  /** Destroys every instance and releases the runtime. Idempotent. */
  dispose(): Promise<void>;
}
