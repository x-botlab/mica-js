import { createScheduler, timePs, type Scheduler, type TimePs } from '@mica-js/core';
import type { SchematicDocument, SchematicSymbol } from '@mica-js/core/schematic';
import {
  createDeviceInstance,
  loadDeviceModule,
  type DeviceInstance,
  type TopicPayload,
} from '@mica-js/device';
import { SimulatorError } from './errors';
import type {
  AdvanceReport,
  DeviceSimExecutor,
  DeviceSimExecutorOptions,
  DevicePublish,
  DeviceTopic,
  DeviceTopicTarget,
  SimulationDiagnostic,
  SimulationState,
} from './types';

const EMPTY_SCHEMATIC: SchematicDocument = Object.freeze({
  version: 1,
  sheet: Object.freeze({
    symbols: Object.freeze([]),
    wires: Object.freeze([]),
    junctions: Object.freeze([]),
  }),
});

const EMPTY_TOPICS: readonly DeviceTopic[] = Object.freeze([]);

/** One loaded schematic: its scheduler, the instances keyed by symbol id and the topic index. */
interface Runtime {
  readonly scheduler: Scheduler;
  readonly instances: ReadonlyMap<string, DeviceInstance>;
  readonly topics: readonly DeviceTopic[];
}

interface PendingDelivery {
  readonly target: DeviceTopicTarget;
  readonly payload: TopicPayload;
}

/**
 * Creates an executor for one schematic at a time.
 *
 * Instances are provisioned by `@mica-js/device` on a private scheduler; pins, nets and the
 * electrical network are not wired yet, so a device whose IR touches pins or connections fails to
 * load with the device layer's own error.
 */
export function createDeviceSimExecutor(options: DeviceSimExecutorOptions): DeviceSimExecutor {
  return new DeviceSimExecutorImpl(options);
}

class DeviceSimExecutorImpl implements DeviceSimExecutor {
  readonly #options: DeviceSimExecutorOptions;
  readonly #publishListeners = new Set<(publish: DevicePublish) => void>();
  readonly #pending: PendingDelivery[] = [];
  #runtime: Runtime | undefined;
  #schematic: SchematicDocument = EMPTY_SCHEMATIC;
  #state: SimulationState = 'idle';

  constructor(options: DeviceSimExecutorOptions) {
    this.#options = options;
  }

  getState(): SimulationState {
    return this.#state;
  }

  getSimTime(): TimePs {
    return this.#runtime?.scheduler.now ?? timePs(0);
  }

  getSchematic(): SchematicDocument {
    return this.#schematic;
  }

  getTopics(): readonly DeviceTopic[] {
    return this.#runtime?.topics ?? EMPTY_TOPICS;
  }

  async loadSchematic(document: SchematicDocument): Promise<void> {
    this.#assertNotDisposed();
    // Build first: a rejected load must leave the running simulation untouched.
    const runtime = await this.#buildRuntime(document);
    this.#teardown();
    this.#runtime = runtime;
    this.#schematic = document;
    this.#state = 'ready';
  }

  advance(delta: TimePs): AdvanceReport {
    const runtime = this.#requireRuntime();
    if (!Number.isSafeInteger(delta) || delta <= 0) {
      throw new SimulatorError(
        'simulator/invalid-delta',
        `advance expects a positive whole number of picoseconds, received ${String(delta)}.`,
      );
    }
    const { scheduler } = runtime;
    const from = scheduler.now;
    this.#flush(runtime);
    try {
      const result = scheduler.start({ until: from + delta });
      return Object.freeze({
        from,
        to: result.timePs,
        executed: result.executed,
        reason: result.reason,
      });
    } catch (cause) {
      this.#state = 'faulted';
      this.#report({
        code: 'simulator/advance-failed',
        message: `Advancing ${delta} ps failed.`,
        cause,
      });
      throw cause;
    }
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

  deliver(target: DeviceTopicTarget, payload: TopicPayload): void {
    const runtime = this.#requireRuntime();
    const instance = runtime.instances.get(target.symbol);
    if (instance === undefined) {
      throw new SimulatorError(
        'simulator/unknown-target',
        `The schematic has no symbol "${target.symbol}".`,
        { symbol: target.symbol },
      );
    }
    const port = instance.description.ports.get(target.port);
    if (port === undefined) {
      throw new SimulatorError(
        'simulator/unknown-port',
        `Device ${JSON.stringify(instance.deviceId)} has no port "${target.port}".`,
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

  async reset(): Promise<void> {
    this.#assertNotDisposed();
    if (this.#runtime === undefined) {
      this.#pending.length = 0;
      return;
    }
    await this.loadSchematic(this.#schematic);
  }

  async dispose(): Promise<void> {
    if (this.#state === 'disposed') {
      return;
    }
    this.#state = 'disposed';
    this.#publishListeners.clear();
    this.#teardown();
  }

  /** Loads every device of the schematic and runs the `initialize` pass on a fresh scheduler. */
  async #buildRuntime(document: SchematicDocument): Promise<Runtime> {
    const scheduler =
      this.#options.scheduler === undefined
        ? createScheduler()
        : createScheduler(this.#options.scheduler);
    const instances = new Map<string, DeviceInstance>();
    const topics: DeviceTopic[] = [];
    try {
      for (const symbol of document.sheet.symbols) {
        const instance = await this.#createInstance(symbol, scheduler);
        instances.set(symbol.id, instance);
        collectTopics(symbol, instance, topics);
      }
      // Device factories only queue `initialize`; run it so the runtime is ready to advance.
      scheduler.start({ until: scheduler.now });
      return { scheduler, instances, topics: Object.freeze(topics) };
    } catch (error) {
      for (const instance of instances.values()) {
        destroyQuietly(instance, (diagnostic) => this.#report(diagnostic));
      }
      throw error;
    }
  }

  async #createInstance(symbol: SchematicSymbol, scheduler: Scheduler): Promise<DeviceInstance> {
    let loaded;
    try {
      loaded = await loadDeviceModule(symbol.device, this.#options.devices);
    } catch (cause) {
      throw new SimulatorError(
        'simulator/device-load-failed',
        `Device ${JSON.stringify(symbol.device)} of symbol "${symbol.id}" could not be loaded.`,
        { symbol: symbol.id, cause },
      );
    }
    try {
      return createDeviceInstance(loaded, scheduler, {
        instanceId: symbol.id,
        ...(symbol.properties === undefined ? {} : { properties: symbol.properties }),
        onTopic: (message) => {
          this.#publish(scheduler, symbol.id, message.port, message.payload);
        },
      });
    } catch (cause) {
      throw new SimulatorError(
        'simulator/instance-create-failed',
        `Symbol "${symbol.id}" could not be instantiated with device ${JSON.stringify(symbol.device)}.`,
        { symbol: symbol.id, cause },
      );
    }
  }

  #publish(scheduler: Scheduler, symbol: string, port: string, payload: TopicPayload): void {
    const publish: DevicePublish = Object.freeze({
      target: Object.freeze({ symbol, port }),
      payload,
      simTime: scheduler.now,
    });
    for (const listener of [...this.#publishListeners]) {
      try {
        listener(publish);
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

  /** Hands the payloads queued by `deliver` to their instances at the slice's start time. */
  #flush(runtime: Runtime): void {
    if (this.#pending.length === 0) {
      return;
    }
    const deliveries = this.#pending.splice(0);
    const simTime = runtime.scheduler.now;
    for (const delivery of deliveries) {
      const instance = runtime.instances.get(delivery.target.symbol);
      if (instance === undefined) {
        continue; // The target was validated when it was queued; a reload dropped the instance.
      }
      instance.deliver(delivery.target.port, delivery.payload, { simTime });
    }
  }

  #teardown(): void {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#pending.length = 0;
    if (runtime === undefined) {
      return;
    }
    for (const instance of runtime.instances.values()) {
      destroyQuietly(instance, (diagnostic) => this.#report(diagnostic));
    }
  }

  #requireRuntime(): Runtime {
    this.#assertNotDisposed();
    const runtime = this.#runtime;
    if (runtime === undefined) {
      throw new SimulatorError(
        'simulator/not-ready',
        'Load a schematic before advancing the simulation.',
      );
    }
    return runtime;
  }

  #assertNotDisposed(): void {
    if (this.#state === 'disposed') {
      throw new SimulatorError('simulator/disposed', 'The executor is disposed.');
    }
  }

  #report(diagnostic: SimulationDiagnostic): void {
    try {
      this.#options.onDiagnostic?.(diagnostic);
    } catch {
      // A throwing diagnostic sink must not take the simulation down.
    }
  }
}

function collectTopics(
  symbol: SchematicSymbol,
  instance: DeviceInstance,
  into: DeviceTopic[],
): void {
  for (const [port, descriptor] of instance.description.ports) {
    into.push(
      Object.freeze({
        symbol: symbol.id,
        port,
        direction: descriptor.direction,
        type: descriptor.type,
        ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
      }),
    );
  }
}

function destroyQuietly(
  instance: DeviceInstance,
  report: (diagnostic: SimulationDiagnostic) => void,
): void {
  try {
    instance.destroy();
  } catch (cause) {
    report({
      code: 'simulator/dispose-failed',
      message: `Device instance "${instance.instanceId}" failed to destroy.`,
      symbol: instance.instanceId,
      cause,
    });
  }
}
