import { timePs } from '@mica-js/core';
import type { Disposable } from '@mica-js/core/lifecycle';
import { compileDDL } from '@mica-js/ddl';
import { createDeviceBuilder, types, type DeviceIR } from '@mica-js/device-model';
import type { DeviceMetadata } from '@mica-js/document/schematic';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { DeviceAdapter, DeviceContext, InstanceDescription, TopicMessage } from '../types';
import { copyPayload } from './payload';
import type { IPreparedDeviceTopic, IPreparedInstance } from './prepare';
import { createSimulationRuntime, scopeTopics } from './runtime';
import {
  DEVICE,
  DEFINITION,
  SYMBOL,
  TOGGLE_MODEL,
  importer,
  message,
  toggleSimulation,
} from './test-helpers';
import type {
  IPreparedSimulation,
  ISimulationDiagnostic,
  ISimulationMessage,
  ISimulationRuntime,
} from './types';

vi.mock('./payload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./payload')>();
  return { ...actual, copyPayload: vi.fn(actual.copyPayload) };
});

const BYTE_MODEL = await compileDDL(`
device ByteEcho {
  input channel frame: bytes(maxLength: 8, capacity: 2);
  output channel echo: bytes(maxLength: 8, capacity: 2);
  process start {
    loop {
      const value = await frame.receive();
      echo.send(value);
    }
  }
}
`);

const BYTE_DEFINITION: DeviceMetadata = {
  kind: 'device',
  id: 'toggle',
  version: '1.0.0',
  displayName: 'ByteEcho',
  ports: {
    frame: { direction: 'input', type: 'bytes', delivery: 'message' },
    echo: { direction: 'output', type: 'bytes', delivery: 'message' },
  },
};

const BYTE_CODE = `export const model = ${JSON.stringify(BYTE_MODEL)};
export function create(context) {
  const subscription = context.topics.onDidReceive(({ topic, payload }) => {
    if (topic === 'frame') context.inputs.frame.send(payload);
  });
  return {
    sync(batch) {
      for (const entry of batch.outputs.echo) context.topics.publish('echo', entry.value);
    },
    dispose() { subscription.dispose(); },
  };
}`;

const PUBLISHED_TOPICS = ['state', 'pulseCount', 'frameLength', 'echo', 'blob'] as const;
/** `state`, `pulseCount` and `frameLength` are level topics; `echo` and `blob` deliver messages. */
const LEVEL_TOPICS = 3;

const runtimes: ISimulationRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  vi.mocked(copyPayload).mockClear();
});
function runtime(): ISimulationRuntime {
  const result = createSimulationRuntime({ importer });
  runtimes.push(result);
  return result;
}
function deviceCode(subscribe: boolean): string {
  return `export const model = ${JSON.stringify(TOGGLE_MODEL)};
export function create(context) {
  ${subscribe ? 'const subscription = context.topics.onDidReceive(() => {});' : ''}
  return {
    sync() {
      context.topics.publish('state', false);
      context.topics.publish('pulseCount', 0);
      context.topics.publish('frameLength', 0);
      context.topics.publish('echo', 'tick');
      context.topics.publish('blob', new Uint8Array([1, 2, 3]));
    },
    dispose() {${subscribe ? ' subscription.dispose();' : ''}},
  };
}`;
}
function codeSimulation(code: string): IPreparedSimulation {
  return { ...toggleSimulation(), devices: [{ id: DEVICE, definition: DEFINITION, code }] };
}

const OUTPUT_TOPICS: readonly (readonly [string, IPreparedDeviceTopic])[] = [
  ['echo', { port: 'echo', direction: 'output', type: 'string', delivery: 'message' }],
  ['blob', { port: 'blob', direction: 'output', type: 'bytes', delivery: 'message' }],
];

function fakeInstance(symbol = SYMBOL): IPreparedInstance {
  return {
    symbol,
    device: { topics: new Map<string, IPreparedDeviceTopic>(OUTPUT_TOPICS) },
  } as unknown as IPreparedInstance;
}

interface IBoardObservation {
  readonly topic: string;
  readonly payload: unknown;
  readonly time: number;
}

/**
 * One real board whose single device publishes through an instance-scoped bridge. Each run picks the
 * surfaces that observe the fan-out, so the same messages can be compared across all of them.
 */
function publishOnBoard(surfaces: { readonly host: boolean; readonly scoped: boolean }): {
  readonly host: IBoardObservation[];
  readonly outputs: Parameters<typeof scopeTopics>[2];
  readonly diagnostics: Parameters<typeof scopeTopics>[3];
  readonly copies: number;
} {
  const instance = fakeInstance();
  const host: IBoardObservation[] = [];
  const outputs: Parameters<typeof scopeTopics>[2] = [];
  const diagnostics: Parameters<typeof scopeTopics>[3] = [];
  const buffer = new Uint8Array([1, 2, 3]);
  let sent = false;
  let subscription: Disposable | undefined;
  const library = createDeviceLibrary([
    {
      id: DEVICE,
      model: TOGGLE_MODEL,
      create: (context) => {
        // The runtime hands factories an owner-scoped facade over the board bridge.
        const topics = scopeTopics(context.topics, instance, outputs, diagnostics, () => false);
        if (surfaces.scoped) subscription = topics.onDidReceive(() => {});
        return {
          sync() {
            if (sent) return;
            sent = true;
            topics.publish('echo', 'tick');
            topics.publish('blob', buffer);
            // The device reuses its buffer; every surface must keep the publish snapshot instead.
            buffer[0] = 9;
          },
          dispose() {
            subscription?.dispose();
          },
        };
      },
    },
  ]);
  const board = createBoard(library, {
    instances: [{ id: SYMBOL, type: DEVICE, props: { panel: new Uint8Array([1]) } }],
    nets: [],
  });
  const observing: Disposable | undefined = surfaces.host
    ? board.topics.onDidReceive((entry) => host.push({ ...entry, time: board.time }))
    : undefined;
  vi.mocked(copyPayload).mockClear();
  try {
    board.runUntil(timePs(10));
  } finally {
    observing?.dispose();
    board.dispose();
  }
  return { host, outputs, diagnostics, copies: vi.mocked(copyPayload).mock.calls.length };
}

describe('topic publishing', () => {
  it('publishes byte channel outputs that pass their own payload contract', async () => {
    const api = runtime();
    const diagnostics: ISimulationDiagnostic[] = [];
    api.onDidDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    const publishes: ISimulationMessage[] = [];
    api.onDidPublish((publish) => publishes.push(publish));
    await api.load({
      ...toggleSimulation(),
      devices: [{ id: DEVICE, definition: BYTE_DEFINITION, code: BYTE_CODE }],
    });
    await api.deliver(message(SYMBOL, 'frame', new Uint8Array([7, 8, 9])));
    await api.tick(timePs(10));
    expect(diagnostics).toEqual([]);
    expect(publishes).toHaveLength(1);
    const payload = publishes[0]!.payload;
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload as Uint8Array)).toEqual([7, 8, 9]);
    expect(publishes[0]!.simTime).toBe(10);
  });

  it('keeps the whole stream through board.topics while the instance has no scoped subscriber', () => {
    const board = createBoard(createDeviceLibrary([]), { instances: [], nets: [] });
    try {
      const received: TopicMessage[] = [];
      // A direct subscriber on the exported bridge, as an embedding harness does.
      board.topics.onDidReceive((entry) => received.push(entry));
      const outputs: Parameters<typeof scopeTopics>[2] = [];
      const diagnostics: Parameters<typeof scopeTopics>[3] = [];
      // The runtime hands factories an owner-scoped facade over this same bridge; the fan-out a
      // direct `board.topics` listener observes is identical.
      const topics = scopeTopics(board.topics, fakeInstance(), outputs, diagnostics, () => false);
      const bytes = new Uint8Array([1, 2, 3]);
      topics.publish('echo', 'tick');
      topics.publish('blob', bytes);
      topics.publish('echo', 7);
      bytes[0] = 9;

      expect(received.map((entry) => entry.topic)).toEqual([`${SYMBOL}/echo`, `${SYMBOL}/blob`]);
      expect(received[0]!.payload).toBe('tick');
      // The fan-out payload stays the publish snapshot even when the device reuses its buffer.
      expect(Array.from(received[1]!.payload as Uint8Array)).toEqual([1, 2, 3]);
      expect(outputs).toHaveLength(2);
      expect(diagnostics.map((entry) => entry.port)).toEqual(['echo']);
    } finally {
      board.dispose();
    }
  });

  it('counts owner-less host subscriptions and ignores scoped ones', () => {
    let subscription: Disposable | undefined;
    const library = createDeviceLibrary([
      {
        id: DEVICE,
        model: TOGGLE_MODEL,
        create: (context) => {
          subscription = context.topics.onDidReceive(() => {});
          return { sync() {}, dispose: () => subscription?.dispose() };
        },
      },
    ]);
    const board = createBoard(library, {
      instances: [{ id: SYMBOL, type: DEVICE, props: { panel: new Uint8Array([1]) } }],
      nets: [],
    });
    try {
      // The device subscribes through its instance, so the board bridge still has no host listener.
      expect(subscription).toBeDefined();
      expect(board.topics.hostListenerCount).toBe(0);
      const first = board.topics.onDidReceive(() => {});
      const second = board.topics.onDidReceive(() => {});
      expect(board.topics.hostListenerCount).toBe(2);
      first.dispose();
      // Releasing twice keeps the symmetric count.
      first.dispose();
      expect(board.topics.hostListenerCount).toBe(1);
      second.dispose();
      expect(board.topics.hostListenerCount).toBe(0);
    } finally {
      board.dispose();
    }
  });

  it('keeps the whole output stream for a host listening on board.topics', () => {
    const scoped = publishOnBoard({ host: true, scoped: true });
    const hostOnly = publishOnBoard({ host: true, scoped: false });
    const silent = publishOnBoard({ host: false, scoped: false });
    const expected: IBoardObservation[] = [
      { topic: `${SYMBOL}/echo`, payload: 'tick', time: timePs(10) },
      { topic: `${SYMBOL}/blob`, payload: new Uint8Array([1, 2, 3]), time: timePs(10) },
    ];
    // A device without any scoped subscriber still fans out to a direct host subscription, on the
    // same schedule and from the publish snapshot rather than the device's mutated buffer.
    expect(hostOnly.host).toEqual(expected);
    expect(scoped.host).toEqual(expected);
    // The batch entries `flush` turns into `ISimulationMessage`s track that stream one to one.
    expect(hostOnly.outputs).toEqual([
      { symbol: SYMBOL, port: 'echo', payload: 'tick', delivery: 'message' },
      { symbol: SYMBOL, port: 'blob', payload: new Uint8Array([1, 2, 3]), delivery: 'message' },
    ]);
    // With nothing observing the topics, neither the snapshot nor the batch entry is produced.
    expect(silent.outputs).toEqual([]);
    expect(silent.copies).toBe(0);
    expect(silent.diagnostics).toEqual([]);
    expect(hostOnly.diagnostics).toEqual([]);
  });

  it('keeps the publish guards on the skipped path', () => {
    interface IGuardCase {
      readonly model: DeviceIR;
      readonly props: NonNullable<InstanceDescription['props']>;
      readonly create: (context: DeviceContext, publish: (port: string) => void) => DeviceAdapter;
    }
    /** Runs one board whose device publishes from a callback that `publish` must reject. */
    function guardedPublish(entry: IGuardCase, scoped: boolean): string | undefined {
      const errors: { code?: string }[] = [];
      let subscription: Disposable | undefined;
      const library = createDeviceLibrary([
        {
          id: DEVICE,
          model: entry.model,
          create: (context) => {
            const topics = scopeTopics(context.topics, fakeInstance(), [], [], () => false);
            if (scoped) subscription = topics.onDidReceive(() => {});
            return entry.create(context, (port) => {
              try {
                topics.publish(port, 'tick');
              } catch (cause) {
                errors.push(cause as { code?: string });
              }
            });
          },
        },
      ]);
      const board = createBoard(library, {
        instances: [{ id: SYMBOL, type: DEVICE, props: entry.props }],
        nets: [],
      });
      try {
        board.runUntil(timePs(10));
      } catch {
        /* A faulted board rejects the run; the publish guard is what this test reads. */
      } finally {
        subscription?.dispose();
        board.dispose();
      }
      return errors[0]?.code;
    }

    const toggle: Omit<IGuardCase, 'create'> = {
      model: TOGGLE_MODEL,
      props: { panel: new Uint8Array([1]) },
    };
    for (const scoped of [false, true]) {
      // Disposal invalidates the instance before its adapter disposes.
      expect(
        guardedPublish(
          {
            ...toggle,
            create: (_context, publish) => ({ sync() {}, dispose: () => publish('echo') }),
          },
          scoped,
        ),
      ).toBe('OBJECT_DISPOSED');
      // A faulted board keeps rejecting publishes even when nothing observes the topics.
      expect(
        guardedPublish(
          {
            ...toggle,
            create: (context, publish) => ({
              sync() {
                context.reportError(new Error('boom'));
                publish('echo');
              },
              dispose() {},
            }),
          },
          scoped,
        ),
      ).toBe('BOARD_FAULTED');
    }

    // Blocks are translated while the board is in a phase that forbids publishing.
    const builder = createDeviceBuilder({ name: 'Guard' });
    builder.memory({ name: 'code', length: 4 });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    const jit: IGuardCase = {
      model: builder.finish(),
      props: {},
      create: (context, publish) => {
        const registration = context.attachJit({
          entry: 'guard',
          code: 'code',
          pc: 'pc',
          translate: (input, block) => {
            publish('echo');
            block.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => body.stop());
            return block.finish();
          },
        });
        context.loadBytes('code', new Uint8Array(4));
        return { sync() {}, dispose: () => registration.dispose() };
      },
    };
    expect(guardedPublish(jit, false)).toBe('INVALID_CALL_STATE');
    expect(guardedPublish(jit, true)).toBe('INVALID_CALL_STATE');
  });

  it('drops the flush-stage copies and messages, not the delivered stream, without a listener', async () => {
    async function run(listener: boolean) {
      const api = runtime();
      const publishes: ISimulationMessage[] = [];
      if (listener) api.onDidPublish((publish) => publishes.push(publish));
      await api.load(codeSimulation(deviceCode(false)));
      vi.mocked(copyPayload).mockClear();
      await api.tick(timePs(4));
      return { publishes, copies: vi.mocked(copyPayload).mock.calls.length };
    }
    const expected: ISimulationMessage[] = [
      { target: { symbol: SYMBOL, port: 'state' }, payload: false, simTime: timePs(4) },
      { target: { symbol: SYMBOL, port: 'pulseCount' }, payload: 0, simTime: timePs(4) },
      { target: { symbol: SYMBOL, port: 'frameLength' }, payload: 0, simTime: timePs(4) },
      { target: { symbol: SYMBOL, port: 'echo' }, payload: 'tick', simTime: timePs(4) },
      {
        target: { symbol: SYMBOL, port: 'blob' },
        payload: new Uint8Array([1, 2, 3]),
        simTime: timePs(4),
      },
    ];
    const unlistened = await run(false);
    const listened = await run(true);
    expect(listened.publishes).toEqual(expected);
    // Nothing observes the topics: no snapshot is taken and no message is assembled.
    expect(unlistened.copies).toBe(0);
    expect(unlistened.publishes).toEqual([]);
    // With a listener the level baseline is copied on change, and no message payload is copied twice.
    expect(listened.copies).toBe(PUBLISHED_TOPICS.length + LEVEL_TOPICS);
  });

  it('keeps the snapshot when only the device subscribes to its own topics', async () => {
    async function run(subscribe: boolean) {
      const api = runtime();
      const publishes: ISimulationMessage[] = [];
      await api.load(codeSimulation(deviceCode(subscribe)));
      vi.mocked(copyPayload).mockClear();
      await api.tick(timePs(4));
      return { publishes, copies: vi.mocked(copyPayload).mock.calls.length };
    }
    const unsubscribed = await run(false);
    const subscribed = await run(true);
    // The device's own subscription keeps the per-publish snapshot and the board fan-out alive.
    expect(subscribed.copies).toBe(PUBLISHED_TOPICS.length);
    // Without it the accepted outputs are dropped before they are copied or queued.
    expect(unsubscribed.copies).toBe(0);
    // Neither run has a publish listener, so no message reaches the delivery surface.
    expect(unsubscribed.publishes).toEqual([]);
    expect(subscribed.publishes).toEqual([]);
  });
});
