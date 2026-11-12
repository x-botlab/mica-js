import { addTime, timePs } from '@mica-js/core';
import type { TimePs } from '@mica-js/core';
import { Emitter } from '@mica-js/core/lifecycle';
import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type { DeliveryKind } from '@mica-js/document/canvas';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Board, DeviceContext, RuntimeDiagnostic, TopicBridge, TopicMessage } from '../types';
import { errorMessage, SimulationRuntimeError } from './errors';
import { copyPayload, payloadMatches, samePayload, targetKey } from './payload';
import { prepareSimulation } from './prepare';
import type { IPreparedDeviceTopic, IPreparedInstance, IResolvedSimulation } from './prepare';
import type {
  IPreparedSimulation,
  ISimulationDiagnostic,
  ISimulationMessage,
  ISimulationRuntime,
  ISimulationRuntimeOptions,
  ISimulationTickReport,
} from './types';

interface IOutput {
  readonly symbol: string;
  readonly port: string;
  readonly payload: unknown;
  readonly delivery: DeliveryKind;
}
interface IDelivery {
  readonly symbol: string;
  readonly port: string;
  readonly payload: unknown;
}
interface ILoadedRuntime {
  readonly prepared: IResolvedSimulation;
  readonly board: Board;
  readonly inputs: ReadonlyMap<string, IPreparedDeviceTopic>;
  readonly outputs: IOutput[];
  readonly diagnostics: ISimulationDiagnostic[];
  readonly subscriptions: readonly Disposable[];
}

/** Runs self-contained SDK devices on an atomic, replaceable Board. */
export function createSimulationRuntime(
  options: ISimulationRuntimeOptions = {},
): ISimulationRuntime {
  const publishes = new Emitter<ISimulationMessage>();
  const diagnostics = new Emitter<ISimulationDiagnostic>();
  const pending: IDelivery[] = [];
  const published = new Map<string, unknown>();
  let active: ILoadedRuntime | undefined;
  let simTime = timePs(0);
  let disposed = false;
  let generation = 0;

  const assertActive = (): void => {
    if (disposed)
      throw new SimulationRuntimeError('disposed', 'Simulation runtime has been disposed');
  };
  const flush = (loaded: ILoadedRuntime): void => {
    // Without a publish listener nothing can observe these messages, and no listener can be added
    // while this loop runs, so the copies and messages are skipped instead of built and dropped.
    if (publishes.hasListeners) {
      for (const output of loaded.outputs.splice(0)) {
        if (output.delivery === 'level') {
          const key = targetKey(output.symbol, output.port);
          if (published.has(key) && samePayload(published.get(key), output.payload)) continue;
          // Keep the equality baseline independent from buffers/objects handed to listeners.
          if (publishes.hasListeners) published.set(key, copyPayload(output.payload));
        }
        // The publish snapshot in `outputs` is already an owned copy, so listeners may share it.
        publishes.fire({
          target: { symbol: output.symbol, port: output.port },
          payload: output.payload,
          simTime,
        });
      }
    } else {
      loaded.outputs.length = 0;
    }
    for (const diagnostic of loaded.diagnostics.splice(0)) {
      diagnostics.fire(
        diagnostic.runtimeCode === undefined ? { ...diagnostic, simTime } : diagnostic,
      );
    }
  };
  const release = (loaded: ILoadedRuntime | undefined): void => {
    if (loaded === undefined) return;
    try {
      loaded.board.dispose();
    } catch (cause) {
      diagnostics.fire({
        code: 'board/diagnostic',
        symbol: '',
        message: errorMessage(cause),
        simTime,
        phase: 'dispose',
      });
    } finally {
      for (const subscription of loaded.subscriptions) subscription.dispose();
    }
  };
  const install = (next: ILoadedRuntime): void => {
    const previous = active;
    active = next;
    pending.length = 0;
    published.clear();
    simTime = timePs(0);
    release(previous);
  };
  return {
    async load(input: IPreparedSimulation): Promise<void> {
      assertActive();
      const current = ++generation;
      const prepared = await prepareSimulation(
        input,
        options.importer ?? importBlobModule,
        assertActive,
      );
      assertActive();
      if (current !== generation) return;
      install(buildLoadedRuntime(prepared));
    },
    async reset(): Promise<void> {
      assertActive();
      ++generation;
      if (active !== undefined) install(buildLoadedRuntime(active.prepared));
      else {
        pending.length = 0;
        published.clear();
        simTime = timePs(0);
      }
    },
    async tick(dt: TimePs): Promise<ISimulationTickReport> {
      assertActive();
      if (!Number.isSafeInteger(dt) || dt <= 0)
        throw new TypeError('tick expects a positive integer dt in picoseconds');
      // Check the cumulative bound before consuming queued inputs or touching the board.
      const target = addTime(simTime, dt);
      const loaded = active;
      if (loaded === undefined) {
        simTime = target;
        return { simTime, executed: 0 };
      }
      try {
        for (const delivery of pending.splice(0)) {
          loaded.board.topics.publish(
            scopedTopic(delivery.symbol, delivery.port),
            delivery.payload,
          );
        }
        loaded.board.runUntil(target);
      } finally {
        simTime = timePs(loaded.board.time);
        flush(loaded);
      }
      return { simTime, executed: 1 };
    },
    async deliver(message: ISimulationMessage): Promise<void> {
      assertActive();
      if (
        message === null ||
        typeof message !== 'object' ||
        message.target === null ||
        typeof message.target !== 'object' ||
        typeof message.target.symbol !== 'string' ||
        typeof message.target.port !== 'string'
      ) {
        throw new SimulationRuntimeError(
          'invalid-input',
          'Expected a message with string symbol and port',
        );
      }
      if (active === undefined)
        throw new SimulationRuntimeError('not-loaded', 'No simulation loaded');
      const { symbol, port } = message.target;
      const topic = active.inputs.get(targetKey(symbol, port));
      if (topic === undefined || !payloadMatches(topic.type, message.payload)) {
        throw new SimulationRuntimeError(
          'invalid-input',
          `Unknown input or invalid payload for ${symbol}.${port}`,
        );
      }
      if (topic.delivery === 'level') {
        const previous = pending.findIndex(
          (entry) => entry.symbol === symbol && entry.port === port,
        );
        if (previous !== -1) pending.splice(previous, 1);
      }
      pending.push({ symbol, port, payload: copyPayload(message.payload) });
    },
    onDidPublish: publishes.event,
    onDidDiagnostic: diagnostics.event,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      ++generation;
      pending.length = 0;
      published.clear();
      release(active);
      active = undefined;
      publishes.dispose();
      diagnostics.dispose();
    },
  };
}

function buildLoadedRuntime(prepared: IResolvedSimulation): ILoadedRuntime {
  const outputs: IOutput[] = [];
  const found: ISimulationDiagnostic[] = [];
  const inputs = new Map<string, IPreparedDeviceTopic>();
  const library = createDeviceLibrary(
    prepared.instances.map((instance) => {
      for (const topic of instance.device.topics.values()) {
        if (topic.direction === 'input') inputs.set(targetKey(instance.symbol, topic.port), topic);
      }
      return {
        id: instance.symbol,
        model: instance.device.model,
        create: (context: DeviceContext) =>
          instance.device.create({
            ...context,
            topics: scopeTopics(context.topics, instance, outputs, found),
          }),
      };
    }),
  );
  // Board captures bytes, but clone per creation as well so a factory cannot alter reset inputs.
  const description = {
    ...prepared.description,
    instances: prepared.description.instances.map((instance) => ({
      ...instance,
      props: Object.fromEntries(
        Object.entries(instance.props ?? {}).map(([key, value]) => [
          key,
          value instanceof Uint8Array ? new Uint8Array(value) : value,
        ]),
      ),
    })),
  };
  const board = createBoard(library, description);
  const project = (diagnostic: RuntimeDiagnostic, fatal: boolean): void => {
    found.push({
      code: fatal
        ? diagnostic.phase === 'topic'
          ? 'device/input-failed'
          : diagnostic.phase === 'sync'
            ? 'device/output-failed'
            : 'board/error'
        : 'board/diagnostic',
      symbol: diagnostic.instanceId ?? '',
      message: diagnostic.message,
      simTime: timePs(diagnostic.time ?? board.time),
      runtimeCode: diagnostic.code,
      phase: diagnostic.phase,
    });
  };
  return {
    prepared,
    board,
    inputs,
    outputs,
    diagnostics: found,
    subscriptions: [
      board.onDidError((event) => project(event, true)),
      board.onDidDiagnostic((event) => project(event, false)),
    ],
  };
}

/**
 * Board topics are opaque global strings; this boundary gives each factory local port names.
 *
 * Exported for the fan-out regression test, which drives it against a real `Board`: every accepted
 * output must still reach `board.topics` listeners even when the instance has no scoped subscriber.
 */
export function scopeTopics(
  bridge: TopicBridge,
  instance: IPreparedInstance,
  outputs: IOutput[],
  diagnostics: ISimulationDiagnostic[],
): TopicBridge {
  const prefix = `${encodeURIComponent(instance.symbol)}/`;
  return {
    onDidReceive: ((listener, thisArgs, disposables) =>
      bridge.onDidReceive(
        (message) => {
          if (!message.topic.startsWith(prefix)) return;
          const port = message.topic.slice(prefix.length);
          if (instance.device.topics.get(port)?.direction !== 'input') return;
          return listener.call(thisArgs, { topic: port, payload: copyPayload(message.payload) });
        },
        undefined,
        disposables,
      )) as Event<TopicMessage>,
    publish(port, payload): void {
      const topic = instance.device.topics.get(port);
      if (topic?.direction !== 'output' || !payloadMatches(topic.type, payload)) {
        diagnostics.push({
          code: 'device/output-failed',
          symbol: instance.symbol,
          port,
          message: `Unknown output or invalid payload for ${instance.symbol}.${port}`,
          simTime: timePs(0),
        });
        return;
      }
      const snapshot = copyPayload(payload);
      // Publish first so Board still enforces its phase and disposed/faulted guards.
      bridge.publish(scopedTopic(instance.symbol, port), snapshot);
      outputs.push({ symbol: instance.symbol, port, payload: snapshot, delivery: topic.delivery });
    },
  };
}

function scopedTopic(symbol: string, port: string): string {
  return `${encodeURIComponent(symbol)}/${port}`;
}

function importBlobModule(code: string): Promise<unknown> {
  if (
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof Blob === 'undefined'
  ) {
    return Promise.reject(new Error('Inject a module importer outside a browser worker'));
  }
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  return import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url));
}
