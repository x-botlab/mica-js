import { MAX_TIME_PS, timePs } from '@mica-js/core';
import { compileDDL } from '@mica-js/ddl';
import { parseSchematic } from '@mica-js/document/schematic';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSimulationRuntime } from './runtime';
import { prepareSimulation } from './prepare';
import {
  DEFINITION,
  DEVICE,
  SYMBOL,
  PANEL,
  PANEL_BYTES,
  TOGGLE_CODE,
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
  SimulationModuleImporter,
} from './types';

const runtimes: ISimulationRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});
function runtime(importModule: SimulationModuleImporter = importer): ISimulationRuntime {
  const result = createSimulationRuntime({ importer: importModule });
  runtimes.push(result);
  return result;
}
function withCode(code: string): IPreparedSimulation {
  return { ...toggleSimulation(), devices: [{ id: DEVICE, definition: DEFINITION, code }] };
}
function collect(api: ISimulationRuntime): ISimulationMessage[] {
  const publishes: ISimulationMessage[] = [];
  api.onDidPublish((publish) => publishes.push(publish));
  return publishes;
}

describe('prepared SDK Board runtime', () => {
  it('runs real DDL channels, queues inputs, coalesces levels, preserves messages and resets', async () => {
    const api = runtime();
    const publishes = collect(api);
    await api.load(toggleSimulation());
    expect(await api.tick(timePs(10))).toEqual({ simTime: 10, executed: 1 });
    expect(publishes.map((publish) => publish.payload)).toEqual([
      false,
      0,
      0,
      'tick',
      new Uint8Array([1, 2, 3]),
    ]);
    expect(publishes.every((publish) => publish.simTime === 10)).toBe(true);
    publishes.length = 0;
    await api.tick(timePs(10));
    expect(publishes.map((publish) => publish.target.port)).toEqual(['echo', 'blob']);
    publishes.length = 0;
    await api.deliver(message(SYMBOL, 'lamp', false));
    await api.deliver(message(SYMBOL, 'lamp', true));
    await api.deliver(message(SYMBOL, 'pulse', 'a'));
    await api.deliver(message(SYMBOL, 'pulse', 'b'));
    const bytes = new Uint8Array([4, 5, 6]);
    await api.deliver(message(SYMBOL, 'frame', bytes));
    bytes.fill(0);
    expect(publishes).toEqual([]);
    await api.tick(timePs(10));
    expect(publishes.slice(0, 3).map((publish) => publish.payload)).toEqual([true, 2, 3]);
    await api.deliver(message(SYMBOL, 'lamp', true));
    await api.reset();
    publishes.length = 0;
    await api.tick(timePs(5));
    expect(publishes.slice(0, 3).map((publish) => publish.payload)).toEqual([false, 0, 0]);
    expect(publishes.every((publish) => publish.simTime === 5)).toBe(true);
  });

  it('uses payload-specific defaults when SDK metadata omits delivery', async () => {
    const api = runtime();
    const publishes = collect(api);
    const ports = Object.fromEntries(
      Object.entries(DEFINITION.ports!).map(([port, topic]) => [
        port,
        { direction: topic.direction, type: topic.type },
      ]),
    );
    await api.load({
      ...toggleSimulation(),
      devices: [{ id: DEVICE, definition: { ...DEFINITION, ports }, code: TOGGLE_CODE }],
    });
    await api.deliver(message(SYMBOL, 'pulse', 'one'));
    await api.deliver(message(SYMBOL, 'pulse', 'two'));
    await api.deliver(message(SYMBOL, 'lamp', false));
    await api.deliver(message(SYMBOL, 'lamp', true));
    await api.tick(timePs(1));
    expect(publishes.slice(0, 2).map((publish) => publish.payload)).toEqual([true, 2]);
    publishes.length = 0;
    await api.tick(timePs(1));
    expect(publishes.map((publish) => publish.target.port)).toEqual(['echo', 'blob']);
  });

  it('snapshots binary outputs without detaching or changing the device buffer', async () => {
    const api = runtime();
    const publishes = collect(api);
    await api.load(toggleSimulation());
    await api.tick(timePs(1));
    (publishes.at(-1)!.payload as Uint8Array).fill(9);
    await api.tick(timePs(1));
    expect(publishes.at(-1)!.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('scopes topics to symbol instances sharing a device model', async () => {
    const api = runtime();
    const input = toggleSimulation();
    const other = '22222222-2222-4222-8222-222222222222';
    const source = input.schematic.sheet.symbols[0]!;
    const prepared = {
      ...input,
      schematic: {
        ...input.schematic,
        sheet: {
          ...input.schematic.sheet,
          symbols: [source, { ...source, id: other, designator: 'K2', x: 200 }],
        },
      },
      assets: { ...input.assets, [other]: { [PANEL]: PANEL_BYTES } },
    };
    const publishes = collect(api);
    await api.load(prepared);
    await api.deliver(message(SYMBOL, 'lamp', true));
    await api.tick(timePs(10));
    expect(
      publishes
        .filter((entry) => entry.target.port === 'state')
        .map((entry) => [entry.target.symbol, entry.payload]),
    ).toEqual([
      [SYMBOL, true],
      [other, false],
    ]);
  });

  it.each([
    'export default function create() {}',
    `export default ${JSON.stringify(TOGGLE_MODEL)}; export function create() {}`,
    `export const model = ${JSON.stringify(TOGGLE_MODEL)}; export const create = null;`,
    'export const model = {}; export function create() {}',
  ])('rejects invalid named SDK exports without replacing the board', async (code) => {
    const api = runtime();
    const publishes = collect(api);
    await api.load(toggleSimulation());
    await api.deliver(message(SYMBOL, 'lamp', true));
    await expect(api.load(withCode(code))).rejects.toMatchObject({ code: 'invalid-device' });
    await api.tick(timePs(1));
    expect(publishes[0]!.payload).toBe(true);
  });

  it('rejects asynchronous factories and preserves the previous board', async () => {
    const api = runtime();
    await api.load(toggleSimulation());
    await expect(
      api.load(
        withCode(
          `export const model = ${JSON.stringify(TOGGLE_MODEL)}; export async function create() { return { sync() {}, dispose() {} }; }`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ASYNC_HOOK_RESULT' });
    expect(await api.tick(timePs(1))).toEqual({ simTime: 1, executed: 1 });
  });

  it('keeps reset atomic when a subsequent synchronous factory fails', async () => {
    let creations = 0;
    const api = runtime(async (code, id) => {
      const module = (await importer(code, id)) as { create: (context: unknown) => unknown };
      return {
        ...module,
        create: (context: unknown) => {
          if (++creations > 1) throw new Error('reset failed');
          return module.create(context);
        },
      };
    });
    const publishes = collect(api);
    await api.load(toggleSimulation());
    await api.deliver(message(SYMBOL, 'lamp', true));
    await expect(api.reset()).rejects.toThrow('reset failed');
    await api.tick(timePs(1));
    expect(publishes[0]!.payload).toBe(true);
  });

  it('reports invalid outputs without faulting the board and suppresses undeclared ports', async () => {
    const api = runtime();
    const diagnostics: ISimulationDiagnostic[] = [];
    api.onDidDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    const publishes = collect(api);
    await api.load(
      withCode(
        TOGGLE_CODE.replace(
          "context.topics.publish('state', lamp);",
          "context.topics.publish('state', 'bad'); context.topics.publish('missing', true);",
        ),
      ),
    );
    expect(await api.tick(timePs(7))).toEqual({ simTime: 7, executed: 1 });
    expect(diagnostics.map((event) => [event.code, event.port, event.simTime])).toEqual([
      ['device/output-failed', 'state', 7],
      ['device/output-failed', 'missing', 7],
    ]);
    expect(publishes.some((publish) => publish.target.port === 'state')).toBe(false);
  });

  it.each([
    [
      "if (topic === 'lamp') context.inputs.control.send(payload);",
      "if (topic === 'lamp') throw new Error('bad input');",
      'device/input-failed',
      'topic',
    ],
    [
      "context.topics.publish('state', lamp);",
      "throw new Error('bad sync');",
      'device/output-failed',
      'sync',
    ],
  ])('projects board faults and resets the faulted board', async (before, after, code, phase) => {
    const api = runtime();
    const diagnostics: ISimulationDiagnostic[] = [];
    api.onDidDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    await api.load(withCode(TOGGLE_CODE.replace(before, after)));
    await api.deliver(message(SYMBOL, 'lamp', true));
    await expect(api.tick(timePs(2))).rejects.toBeInstanceOf(Error);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        symbol: SYMBOL,
        code,
        phase,
        runtimeCode: 'DEVICE_CALLBACK_FAILED',
      }),
    );
    await api.reset();
  });

  it('projects model-execution failures with the native Board diagnostic code', async () => {
    const model = await compileDDL(
      'device Broken { process start { assert false, "execution failed"; } }',
    );
    const input = toggleSimulation();
    const api = runtime();
    const diagnostics: ISimulationDiagnostic[] = [];
    api.onDidDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    await api.load({
      ...input,
      devices: [
        {
          id: DEVICE,
          definition: { kind: 'device', id: 'toggle', version: '1.0.0', displayName: 'Broken' },
          code: `export const model = ${JSON.stringify(model)}; export function create() { return { sync() {}, dispose() {} }; }`,
        },
      ],
    });
    await expect(api.tick(timePs(1))).rejects.toThrow('execution failed');
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'board/error',
        symbol: SYMBOL,
        phase: 'execute',
        runtimeCode: 'MODEL_EXECUTION_FAILED',
      }),
    );
  });

  it('builds nets from metadata geometry and assigns ground references, not power voltages', async () => {
    const model = await compileDDL('device Wires { pin a; pin b; }');
    const definition = {
      kind: 'device' as const,
      id: 'wires',
      version: '1.0.0',
      displayName: 'Wires',
      pins: { a: {}, b: {} },
      symbol: {
        bounds: { x: 0, y: 0, width: 20, height: 20 },
        graphics: [],
        pins: {
          a: { position: [0, 0] as const, direction: 'left' as const },
          b: { position: [20, 0] as const, direction: 'right' as const },
        },
      },
    };
    const input = {
      schematic: parseSchematic({
        version: 1,
        sheet: {
          symbols: [
            { id: SYMBOL, device: 'test:wires', designator: 'W1', x: 0, y: 0, rotation: 0 },
            {
              id: '33333333-3333-4333-8333-333333333333',
              device: 'builtin:ground',
              net: 'GND',
              x: 0,
              y: 0,
              rotation: 0,
            },
            {
              id: '44444444-4444-4444-8444-444444444444',
              device: 'builtin:power',
              net: 'VCC',
              x: 20,
              y: 0,
              rotation: 0,
            },
          ],
          wires: [],
          junctions: [],
        },
      }),
      devices: [
        {
          id: 'test:wires',
          definition,
          code: `export const model = ${JSON.stringify(model)}; export function create() { return { sync() {}, dispose() {} }; }`,
        },
      ],
    };
    // Coincident pin/ground connection points need a wire under schematic topology semantics.
    const connected = {
      ...input,
      schematic: {
        ...input.schematic,
        sheet: {
          ...input.schematic.sheet,
          wires: [
            {
              id: '55555555-5555-4555-8555-555555555555',
              points: [
                { x: 0, y: 0 },
                { x: -10, y: 0 },
              ],
            },
            {
              id: '66666666-6666-4666-8666-666666666666',
              points: [
                { x: 20, y: 0 },
                { x: 30, y: 0 },
              ],
            },
          ],
        },
      },
    };
    const prepared = await prepareSimulation(connected, importer, () => {});
    expect(prepared.description.nets).toEqual([
      { id: 'net:0', pins: [{ instance: SYMBOL, pin: 'a' }], voltage: 0 },
      { id: 'net:1', pins: [{ instance: SYMBOL, pin: 'b' }] },
    ]);
    const api = runtime();
    await api.load(connected);
    await api.tick(timePs(1));
  });

  it('merges metadata defaults and instance properties and resolves resource overrides', async () => {
    const input = toggleSimulation();
    const code = `export const model = ${JSON.stringify(TOGGLE_MODEL)}; export function create(ctx) { if (ctx.props.scale !== 4 || ctx.props.panel[0] !== 9) throw new Error('props not merged'); return { sync() {}, dispose() {} }; }`;
    const prepared = {
      ...input,
      schematic: {
        ...input.schematic,
        sheet: {
          ...input.schematic.sheet,
          symbols: input.schematic.sheet.symbols.map((symbol) => ({
            ...symbol,
            properties: { scale: 4, panel: { mode: 'file' as const, src: 'override.bin' } },
          })),
        },
      },
      devices: [
        {
          id: DEVICE,
          definition: {
            ...DEFINITION,
            properties: {
              ...DEFINITION.properties,
              scale: { type: 'number' as const, required: false, default: 2 },
            },
          },
          code,
        },
      ],
      assets: { [SYMBOL]: { 'override.bin': new Uint8Array([9]) } },
    };
    const api = runtime();
    await api.load(prepared);
    await api.reset();
    const noAssets = { ...prepared, assets: {} };
    await expect(api.load(noAssets)).rejects.toMatchObject({ code: 'unresolved-asset' });
    await api.tick(timePs(1));
  });

  it('rejects metadata/model pin mismatches and unresolved references', async () => {
    const api = runtime();
    await expect(api.load({ ...toggleSimulation(), devices: [] })).rejects.toMatchObject({
      code: 'unresolved-device',
    });
    await expect(
      api.load({
        ...toggleSimulation(),
        devices: [
          { id: DEVICE, definition: { ...DEFINITION, pins: { wrong: {} } }, code: TOGGLE_CODE },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid-device' });
  });

  it('validates tick time before dequeuing input and rejects disposal or invalid endpoints', async () => {
    const api = runtime();
    await expect(api.deliver(message(SYMBOL, 'lamp', true))).rejects.toMatchObject({
      code: 'not-loaded',
    });
    expect(await api.tick(timePs(3))).toEqual({ simTime: 3, executed: 0 });
    await api.load(toggleSimulation());
    const publishes = collect(api);
    await api.deliver(message(SYMBOL, 'lamp', true));
    for (const dt of [0, -1, NaN, Infinity, 0.5, MAX_TIME_PS + 1])
      await expect(api.tick(dt as never)).rejects.toBeInstanceOf(Error);
    await api.tick(timePs(1));
    expect(publishes[0]!.payload).toBe(true);
    for (const event of [
      message(SYMBOL, 'state', true),
      message('missing', 'lamp', true),
      message(SYMBOL, 'lamp', 'bad'),
      null as never,
    ])
      await expect(api.deliver(event)).rejects.toMatchObject({ code: 'invalid-input' });
    await api.dispose();
    await api.dispose();
    await expect(api.tick(timePs(1))).rejects.toMatchObject({ code: 'disposed' });
    await expect(api.reset()).rejects.toMatchObject({ code: 'disposed' });
    await expect(api.load(toggleSimulation())).rejects.toMatchObject({ code: 'disposed' });
  });

  it('checks cumulative time bounds and retains queued input on overflow', async () => {
    const api = runtime();
    await api.load(toggleSimulation());
    await api.tick(timePs(MAX_TIME_PS - 1));
    await api.deliver(message(SYMBOL, 'lamp', true));
    await expect(api.tick(timePs(2))).rejects.toThrow();
    const publishes = collect(api);
    expect(await api.tick(timePs(1))).toEqual({ simTime: MAX_TIME_PS, executed: 1 });
    expect(publishes.find((publish) => publish.target.port === 'state')?.payload).toBe(true);
  });

  it('cancels an in-flight load on dispose and lets the latest load win', async () => {
    let resume!: () => void;
    const api = runtime(async (code, id) => {
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return importer(code, id);
    });
    const loading = api.load(toggleSimulation());
    await api.dispose();
    resume();
    await expect(loading).rejects.toMatchObject({ code: 'disposed' });

    let first = true;
    let unblock!: () => void;
    const factory = vi.fn((context) => ({
      sync() {
        context.topics.publish('state', true);
      },
      dispose() {},
    }));
    const other = runtime(async (code, id) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
      }
      return { ...((await importer(code, id)) as object), create: factory };
    });
    const slow = other.load(toggleSimulation());
    await other.load(toggleSimulation());
    unblock();
    await slow;
    expect(factory).toHaveBeenCalledTimes(1);
    await other.reset();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
