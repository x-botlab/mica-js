import { timePs } from '@mica-js/core';
import { compileDDL } from '@mica-js/ddl';
import type { DeviceMetadata } from '@mica-js/document/schematic';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { TopicMessage } from '../types';
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
      const instance = {
        symbol: SYMBOL,
        device: {
          topics: new Map<string, IPreparedDeviceTopic>([
            ['echo', { port: 'echo', direction: 'output', type: 'string', delivery: 'message' }],
            ['blob', { port: 'blob', direction: 'output', type: 'bytes', delivery: 'message' }],
          ]),
        },
      } as unknown as IPreparedInstance;
      const outputs: Parameters<typeof scopeTopics>[2] = [];
      const diagnostics: Parameters<typeof scopeTopics>[3] = [];
      // The runtime hands factories an owner-scoped facade over this same bridge; the fan-out a
      // direct `board.topics` listener observes is identical.
      const topics = scopeTopics(board.topics, instance, outputs, diagnostics);
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
    // Without a listener the only remaining copies are the per-publish snapshots that keep the
    // board fan-out (and batch outputs) independent from the device's own buffers.
    expect(unlistened.copies).toBe(PUBLISHED_TOPICS.length);
    // With a listener the level baseline is copied on change, and no message payload is copied twice.
    expect(listened.copies).toBe(PUBLISHED_TOPICS.length + LEVEL_TOPICS);
  });

  it('keeps publishing through the bridge while the instance has no scoped subscriber', async () => {
    async function run(subscribe: boolean) {
      const api = runtime();
      const publishes: ISimulationMessage[] = [];
      api.onDidPublish((publish) => publishes.push(publish));
      await api.load(codeSimulation(deviceCode(subscribe)));
      vi.mocked(copyPayload).mockClear();
      await api.tick(timePs(4));
      return { publishes, copies: vi.mocked(copyPayload).mock.calls.length };
    }
    const unsubscribed = await run(false);
    const subscribed = await run(true);
    expect(unsubscribed.publishes).toHaveLength(PUBLISHED_TOPICS.length);
    expect(unsubscribed.publishes).toEqual(subscribed.publishes);
    expect(unsubscribed.copies).toBe(PUBLISHED_TOPICS.length + LEVEL_TOPICS);
    expect(subscribed.copies).toBe(PUBLISHED_TOPICS.length + LEVEL_TOPICS);
  });
});
