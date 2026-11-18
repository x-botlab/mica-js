import { addTime, timePs, type TimePs } from '@mica-js/core';
import { parseFusedDocument, type Value } from '@mica-js/document/fused';
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
  type HeadlessRuntimeOptions,
  type ModelEvent,
  type RuntimeDiagnostic,
  type RuntimeModelEvent,
} from '@mica-js/sdk/fused';
import { deviceFacade, type DynamicDevice } from './devices';

export type EventSelector = (
  | { readonly instanceId: string; readonly designator?: never }
  | { readonly designator: string; readonly instanceId?: never }
) & { readonly event: string };

export interface TestbenchOptions extends Omit<HeadlessRuntimeOptions, 'onModelEvent'> {
  readonly record?: readonly EventSelector[];
}

export interface Testbench {
  readonly devices: Readonly<Record<string, DynamicDevice>>;
  readonly simTime: TimePs;
  readonly diagnostics: readonly RuntimeDiagnostic[];
  device(designator: string): ReturnType<HeadlessRuntime['getModel']>;
  deviceById(instanceId: string): ReturnType<HeadlessRuntime['getModel']>;
  events(selector: EventSelector): readonly ModelEvent<Value>[];
  advanceFor(duration: TimePs): Promise<void>;
  advanceTo(target: TimePs): Promise<void>;
  advanceUntil(
    predicate: () => boolean | Promise<boolean>,
    options: { timeout: TimePs },
  ): Promise<void>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export class TestbenchError extends Error {
  constructor(
    readonly code:
      'testing/unknown-device' | 'testing/unrecorded-event' | 'testing/timeout' | 'testing/busy',
    message: string,
  ) {
    super(message);
    this.name = 'TestbenchError';
  }
}

export async function createTestbench(options: TestbenchOptions): Promise<Testbench> {
  const { record = [], onDiagnostic, ...runtimeOptions } = options;
  const document = parseFusedDocument(structuredClone(options.document));
  const step = timePs(options.step);
  if (step === 0) throw new RangeError('Testbench step must be positive');

  const instanceIdFor = (designator: string): string => {
    const instance = document.instances.find((item) => item.designator === designator);
    if (!instance)
      throw new TestbenchError('testing/unknown-device', `Unknown device ${designator}`);
    return instance.id;
  };
  const keyFor = (selector: EventSelector): string => {
    if (typeof selector.event !== 'string' || selector.event.length === 0) {
      throw new TypeError('Recorded event name must be nonempty');
    }
    if ((selector.instanceId === undefined) === (selector.designator === undefined)) {
      throw new TypeError('An event selector must specify exactly one instance ID or designator');
    }
    const instanceId = selector.instanceId ?? instanceIdFor(selector.designator!);
    if (!document.instances.some((instance) => instance.id === instanceId)) {
      throw new TestbenchError('testing/unknown-device', `Unknown device ${instanceId}`);
    }
    return JSON.stringify([instanceId, selector.event]);
  };
  const recordings = new Map<string, ModelEvent<Value>[]>();
  const selectors = record.map((value) => {
    const selector = { ...value };
    return { selector, key: keyFor(selector) };
  });
  for (const { key } of selectors) recordings.set(key, []);

  const onModelEvent = (event: RuntimeModelEvent): void => {
    const history = recordings.get(JSON.stringify([event.instanceId, event.event]));
    history?.push(structuredClone(event.payload));
  };
  const diagnostics: RuntimeDiagnostic[] = [];
  const runtime = await createHeadlessRuntime({
    ...runtimeOptions,
    document,
    onModelEvent,
    onDiagnostic(diagnostic) {
      diagnostics.push(structuredClone(diagnostic));
      onDiagnostic?.(diagnostic);
    },
  });
  try {
    for (const { selector } of selectors) {
      const id = selector.instanceId ?? instanceIdFor(selector.designator!);
      const client = runtime.getModel(id);
      if (!Object.hasOwn(client.events, selector.event)) {
        throw new TestbenchError(
          'testing/unrecorded-event',
          `Unknown event ${selector.event} on ${id}`,
        );
      }
    }
  } catch (error) {
    try {
      await runtime.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Testbench preparation and cleanup failed', {
        cause: cleanupError,
      });
    }
    throw error;
  }

  let busy = false;
  let disposal: Promise<void> | undefined;

  const assertPaused = (): void => {
    const state = runtime.getState();
    if (state.status !== 'paused') {
      throw new Error(`Testbench requires a paused runtime, got ${state.status}`);
    }
  };
  const exclusive = async (operation: () => Promise<void>): Promise<void> => {
    if (busy)
      throw new TestbenchError('testing/busy', 'Await the current testbench operation first');
    busy = true;
    try {
      await operation();
    } finally {
      busy = false;
    }
  };
  const targetAfter = (duration: TimePs): TimePs => {
    timePs(duration);
    if (duration % step !== 0) {
      throw new RangeError('Test duration must be a multiple of the fixed step');
    }
    return addTime(runtime.getState().simTime, duration);
  };
  const advanceTo = async (target: TimePs): Promise<void> => {
    assertPaused();
    timePs(target);
    const now = runtime.getState().simTime;
    if (target < now) throw new RangeError('Cannot advance virtual time backwards');
    if ((target - now) % step !== 0) {
      throw new RangeError('Target must be reachable by whole fixed steps');
    }
    while (runtime.getState().simTime < target) await runtime.step();
  };

  const devices: Record<string, DynamicDevice> = Object.create(null);
  for (const instance of document.instances) {
    if (instance.designator === undefined) continue;
    Object.defineProperty(devices, instance.designator, {
      enumerable: true,
      get() {
        const client = runtime.getModel(instance.id);
        return deviceFacade(client.methods, client.events);
      },
    });
  }

  return {
    devices: Object.freeze(devices),
    get simTime() {
      return runtime.getState().simTime;
    },
    get diagnostics() {
      return structuredClone(diagnostics);
    },
    device: (designator) => runtime.getModel(instanceIdFor(designator)),
    deviceById: (instanceId) => runtime.getModel(instanceId),
    events(selector) {
      const events = recordings.get(keyFor(selector));
      if (!events) {
        throw new TestbenchError(
          'testing/unrecorded-event',
          'Configure event recording before creation',
        );
      }

      return structuredClone(events);
    },
    advanceFor: (duration) => exclusive(() => advanceTo(targetAfter(duration))),
    advanceTo: (target) => exclusive(() => advanceTo(target)),
    advanceUntil: (predicate, { timeout }) =>
      exclusive(async () => {
        assertPaused();
        const target = targetAfter(timeout);
        for (;;) {
          const matched = await predicate();
          if (typeof matched !== 'boolean')
            throw new TypeError('Wait predicate must return a boolean');
          if (matched) return;
          if (runtime.getState().simTime === target) {
            throw new TestbenchError('testing/timeout', `Condition unmet at ${target} ps`);
          }
          await runtime.step();
        }
      }),
    reset: () =>
      exclusive(async () => {
        const { status } = runtime.getState();
        if (status !== 'paused' && status !== 'faulted') {
          throw new Error(`Cannot reset testbench in ${status} state`);
        }
        for (const history of recordings.values()) history.length = 0;
        diagnostics.length = 0;
        await runtime.reset();
      }),
    dispose() {
      if (disposal) return disposal;
      if (busy)
        return Promise.reject(
          new TestbenchError('testing/busy', 'Await the current operation before disposal'),
        );
      disposal = runtime.dispose();
      return disposal;
    },
  };
}

export function bindTestbenchDevices<D extends object>(bench: Testbench, devices: D) {
  const base: Omit<Testbench, 'devices'> = bench;
  return Object.assign(base, { devices: Object.freeze(devices) });
}
