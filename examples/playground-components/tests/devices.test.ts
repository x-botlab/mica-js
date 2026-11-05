import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '@mica-js/simulator';
import type { Board, DeviceLibraryEntry, TopicMessage } from '@mica-js/simulator';
import { validateMetadata } from '@mica-js/sdk/metadata';

const root = fileURLToPath(new URL('..', import.meta.url));
const ids = ['resistor', 'push-button', 'led', 'voltmeter'] as const;
type Id = (typeof ids)[number];
const modules = new Map<Id, Pick<DeviceLibraryEntry, 'model' | 'create'>>();
const boards: Board[] = [];

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const cli = resolve(dirname(require.resolve('@mica-js/sdk')), '..', 'dist', 'build', 'cli.js');
  // Exercise the public SDK build, including DDL compilation, metadata and adapter bundling.
  execFileSync(process.execPath, [cli, 'build', '--root', root], {
    cwd: root,
    stdio: 'pipe',
    timeout: 60_000,
  });
  for (const id of ids) {
    const metadata = JSON.parse(
      await readFile(resolve(root, 'dist', 'devices', id, 'device.json'), 'utf8'),
    );
    validateMetadata(metadata, 'device', id);
    const source = await readFile(resolve(root, 'dist', 'devices', id, 'device.js'), 'utf8');
    modules.set(
      id,
      await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`),
    );
  }
}, 90_000);

afterEach(() => {
  for (const board of boards.splice(0)) board.dispose();
});

function circuit(options: { voltage?: number; resistance?: number; count?: number } = {}) {
  const outputs = new Map<string, number>();
  const listeners = new Map<string, Set<(message: TopicMessage) => unknown>>();
  const entries: DeviceLibraryEntry[] = [];
  const instances: { id: string; type: string; props?: { resistance: number } }[] = [];
  const nets: { id: string; voltage?: number; pins: { instance: string; pin: string }[] }[] = [];
  let disposals = 0;
  const endpoint = (instance: string, pin: string) => ({ instance, pin });
  for (let index = 0; index < (options.count ?? 1); index++) {
    const name = (id: Id) => `${index}:${id}`;
    for (const id of ids) {
      const key = name(id);
      const module = modules.get(id)!;
      const input = new Set<(message: TopicMessage) => unknown>();
      listeners.set(key, input);
      entries.push({
        id: key,
        model: module.model,
        create(context) {
          const adapter = module.create({
            ...context,
            topics: {
              onDidReceive(listener: (message: TopicMessage) => unknown) {
                input.add(listener);
                return {
                  dispose: () => {
                    input.delete(listener);
                  },
                };
              },
              publish(topic: string, payload: unknown) {
                if (typeof payload !== 'number') throw new TypeError('Expected numeric output');
                outputs.set(`${key}:${topic}`, payload);
              },
            },
          });
          return {
            sync: (batch) => adapter.sync(batch),
            dispose() {
              disposals++;
              adapter.dispose();
            },
          };
        },
      });
      instances.push({
        id: key,
        type: key,
        ...(id === 'resistor' && options.resistance !== undefined
          ? { props: { resistance: options.resistance } }
          : {}),
      });
    }
    nets.push(
      {
        id: `${index}:VCC`,
        voltage: options.voltage ?? 5,
        pins: [endpoint(name('resistor'), 'a')],
      },
      {
        id: `${index}:anode`,
        pins: [
          endpoint(name('resistor'), 'b'),
          endpoint(name('led'), 'anode'),
          endpoint(name('voltmeter'), 'positive'),
        ],
      },
      {
        id: `${index}:cathode`,
        pins: [
          endpoint(name('led'), 'cathode'),
          endpoint(name('push-button'), 'a'),
          endpoint(name('voltmeter'), 'negative'),
        ],
      },
      { id: `${index}:GND`, voltage: 0, pins: [endpoint(name('push-button'), 'b')] },
    );
  }
  const board = createBoard(createDeviceLibrary(entries), { instances, nets });
  boards.push(board);
  return {
    board,
    read(port: string, index = 0, device: Id = 'led') {
      const value = outputs.get(`${index}:${device}:${port}`);
      expect(value).toBeTypeOf('number');
      return value!;
    },
    press(payload: unknown, index = 0) {
      for (const listener of listeners.get(`${index}:push-button`)!)
        listener({ topic: 'press', payload });
    },
    listeners,
    get disposals() {
      return disposals;
    },
  };
}

function expected(voltage = 5, resistance = 330, pressed = true) {
  const ledAndMeter = 1 / (1 / 100 + 1 / 10_000_000);
  const v = (voltage * ledAndMeter) / (resistance + ledAndMeter + (pressed ? 1 : 1_000_000_000));
  return { voltage: v, current: v / 100, brightness: Math.min(1, Math.max(0, v / 2)) };
}

function check(run: ReturnType<typeof circuit>, solution: ReturnType<typeof expected>, index = 0) {
  expect(run.board.status).toBe('ready');
  expect(run.read('voltage', index)).toBeCloseTo(solution.voltage, 9);
  expect(run.read('voltage', index, 'voltmeter')).toBeCloseTo(solution.voltage, 9);
  expect(run.read('current', index)).toBeCloseTo(solution.current, 11);
  expect(run.read('brightness', index)).toBeCloseTo(solution.brightness, 9);
}

describe('SDK-built linear DC devices', () => {
  it('solves released / pressed / released with defined initial levels', () => {
    const run = circuit();
    run.board.runUntil(0);
    check(run, expected(5, 330, false));
    expect(run.read('brightness')).toBeLessThan(0.000001);
    run.press(true);
    run.board.runUntil(1);
    check(run, expected());
    expect(run.read('voltage')).toBeCloseTo(1.16, 2);
    run.press(false);
    run.board.runUntil(2);
    check(run, expected(5, 330, false));
  });

  it('honors configured resistance and board rail voltage', () => {
    const run = circuit({ voltage: 3.3, resistance: 1000 });
    run.press(true);
    run.board.runUntil(1);
    check(run, expected(3.3, 1000));
  });

  it('does not light under reverse polarity although the linear load conducts', () => {
    const run = circuit({ voltage: -5 });
    run.press(true);
    run.board.runUntil(1);
    check(run, expected(-5));
    expect(run.read('current')).toBeLessThan(0);
    expect(run.read('voltage')).toBeLessThan(0);
    expect(run.read('brightness')).toBe(0);
  });

  it('clamps forward brightness to one', () => {
    const run = circuit({ voltage: 12, resistance: 100 });
    run.press(true);
    run.board.runUntil(1);
    check(run, expected(12, 100));
    expect(run.read('brightness')).toBe(1);
  });

  it('isolates instances and rejects nonboolean level payloads', () => {
    const run = circuit({ count: 2 });
    run.press(true);
    run.press('true', 1);
    run.board.runUntil(1);
    check(run, expected(), 0);
    check(run, expected(5, 330, false), 1);
    run.press(true, 1);
    run.board.runUntil(2);
    check(run, expected(), 1);
  });

  it('removes input listeners and disposes each device once', () => {
    const run = circuit({ count: 2 });
    expect(run.listeners.get('0:push-button')!.size).toBe(1);
    run.board.dispose();
    run.board.dispose();
    expect(run.disposals).toBe(8);
    expect([...run.listeners.values()].every((set) => set.size === 0)).toBe(true);
    expect(run.board.status).toBe('disposed');
  });

  it('rejects resistance outside the supported finite range', () => {
    for (const resistance of [0, -1, Infinity, 1_000_000_001]) {
      expect(() => circuit({ resistance })).toThrow();
    }
  });
});
