import { createScheduler, timePs, type Scheduler, type TimePs } from '@mica-js/core';
import {
  designatorOf,
  type SchematicDocument,
  type SchematicSymbol,
} from '@mica-js/core/schematic';
import {
  createDeviceInstance,
  loadDeviceModule,
  type DeviceInstance,
  type LoadedDeviceModule,
  type TopicPayload,
} from '@mica-js/device';
import { SimulatorError } from './errors';
import type {
  AdvanceReport,
  DeviceSimExecutor,
  DeviceSimExecutorOptions,
  DeviceSimHost,
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
  /** Wiring the instances were mounted against; released with the runtime. */
  readonly host: DeviceSimHost | undefined;
}

interface PendingDelivery {
  readonly target: DeviceTopicTarget;
  readonly payload: unknown;
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
  /** Loaded device modules, so `reset` can rebuild instances without touching the provider. */
  readonly #modules = new Map<string, LoadedDeviceModule>();
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
    await this.#loadModules(document);
    // Build first: a rejected load must leave the running simulation untouched.
    const runtime = this.#buildRuntime(document);
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

  deliver(target: DeviceTopicTarget, payload: unknown): void {
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

  reset(): void {
    this.#assertNotDisposed();
    if (this.#runtime === undefined) {
      this.#pending.length = 0;
      return;
    }
    // The modules are cached, so a reset never yields: it swaps in freshly built instances.
    const runtime = this.#buildRuntime(this.#schematic);
    this.#teardown();
    this.#runtime = runtime;
    this.#state = 'ready';
  }

  dispose(): void {
    if (this.#state === 'disposed') {
      return;
    }
    this.#state = 'disposed';
    this.#publishListeners.clear();
    this.#teardown();
    this.#modules.clear();
  }

  /** Loads the devices the schematic names; already loaded ids are reused. */
  async #loadModules(document: SchematicDocument): Promise<void> {
    for (const symbol of document.sheet.symbols) {
      if (this.#modules.has(symbol.device)) {
        continue;
      }
      try {
        this.#modules.set(
          symbol.device,
          await loadDeviceModule(symbol.device, this.#options.devices),
        );
      } catch (cause) {
        throw new SimulatorError(
          'simulator/device-load-failed',
          `Device ${JSON.stringify(symbol.device)} of symbol "${symbol.id}" could not be loaded.`,
          { symbol: symbol.id, cause },
        );
      }
    }
  }

  /** Mounts every symbol of the schematic and runs the `initialize` pass on a fresh scheduler. */
  #buildRuntime(document: SchematicDocument): Runtime {
    const scheduler =
      this.#options.scheduler === undefined
        ? createScheduler()
        : createScheduler(this.#options.scheduler);
    const host = this.#options.host?.({ scheduler, schematic: document });
    const instances = new Map<string, DeviceInstance>();
    const topics: DeviceTopic[] = [];
    try {
      for (const symbol of document.sheet.symbols) {
        const instance = this.#createInstance(symbol, scheduler, host);
        instances.set(symbol.id, instance);
        collectTopics(symbol, instance, topics);
      }
      // Device factories only queue `initialize`; run it so the runtime is ready to advance.
      scheduler.start({ until: scheduler.now });
      return { scheduler, instances, topics: Object.freeze(topics), host };
    } catch (error) {
      for (const instance of instances.values()) {
        destroyQuietly(instance, (diagnostic) => this.#report(diagnostic));
      }
      disposeHostQuietly(host, (diagnostic) => this.#report(diagnostic));
      throw error;
    }
  }

  #createInstance(
    symbol: SchematicSymbol,
    scheduler: Scheduler,
    host: DeviceSimHost | undefined,
  ): DeviceInstance {
    const loaded = this.#modules.get(symbol.device);
    if (loaded === undefined) {
      throw new SimulatorError(
        'simulator/device-load-failed',
        `Device ${JSON.stringify(symbol.device)} of symbol "${symbol.id}" was not loaded.`,
        { symbol: symbol.id },
      );
    }
    const additions = host?.instanceOptions?.(symbol);
    try {
      return createDeviceInstance(loaded, scheduler, {
        ...additions,
        instanceId: symbol.id,
        ...(symbol.properties === undefined ? {} : { properties: symbol.properties }),
        ...(host?.pinHost === undefined ? {} : { pinHost: host.pinHost }),
        ...(host?.topology === undefined ? {} : { connections: { topology: host.topology } }),
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
      // `deliver` accepts `unknown` because hosts forward widget payloads; the device layer
      // captures and validates the value against the port type.
      instance.deliver(delivery.target.port, delivery.payload as TopicPayload, { simTime });
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
    // The pin host and the topology outlive the instances they serve, so they go last.
    disposeHostQuietly(runtime.host, (diagnostic) => this.#report(diagnostic));
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
  const designator = designatorOf(symbol) ?? symbol.id;
  for (const [port, descriptor] of instance.description.ports) {
    into.push(
      Object.freeze({
        symbol: symbol.id,
        designator,
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

function disposeHostQuietly(
  host: DeviceSimHost | undefined,
  report: (diagnostic: SimulationDiagnostic) => void,
): void {
  try {
    host?.dispose?.();
  } catch (cause) {
    report({
      code: 'simulator/dispose-failed',
      message: 'The host wiring failed to dispose.',
      cause,
    });
  }
}
