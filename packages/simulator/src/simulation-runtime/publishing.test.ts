import { timePs } from '@mica-js/core';
import { compileDDL } from '@mica-js/ddl';
import type { DeviceMetadata } from '@mica-js/document/schematic';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyPayload } from './payload';
import { createSimulationRuntime } from './runtime';
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
function collect(api: ISimulationRuntime): ISimulationMessage[] {
  const publishes: ISimulationMessage[] = [];
  api.onDidPublish((publish) => publishes.push(publish));
  return publishes;
}
function deviceCode(subscribe: boolean): string {
  return `export const model = ${JSON.stringify(TOGGLE_MODEL)};
export function create(context) {
  ${subscribe ? 'const subscription = context.topics.onDidReceive(() => {});' : ''}
  return {
    sync() {
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
    const publishes = collect(api);
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

  it('records batch outputs without copying or fanning out while the device has no listener', async () => {
    async function run(subscribe: boolean) {
      const api = runtime();
      const publishes = collect(api);
      await api.load(codeSimulation(deviceCode(subscribe)));
      vi.mocked(copyPayload).mockClear();
      await api.tick(timePs(4));
      return { publishes, copies: vi.mocked(copyPayload).mock.calls.length };
    }
    const expected = [
      { target: { symbol: SYMBOL, port: 'echo' }, payload: 'tick', simTime: 4 },
      { target: { symbol: SYMBOL, port: 'blob' }, payload: new Uint8Array([1, 2, 3]), simTime: 4 },
    ];
    const unsubscribed = await run(false);
    const subscribed = await run(true);
    expect(unsubscribed.publishes).toEqual(expected);
    expect(subscribed.publishes).toEqual(expected);
    // Without a subscription only the flush copy is left; the bridge call and its copy are skipped.
    expect(unsubscribed.copies).toBe(expected.length);
    expect(subscribed.copies).toBe(expected.length * 2);
  });
});
