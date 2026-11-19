import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '../../devices/test/support/legacy-model-bridge.mjs';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * 板载器件测试夹具：仍只装载构建产物 `dist/model.js`。
 *
 * 与 `harness.ts` 的区别是它把模型方法直接暴露给测试，并按需捕获新事件。
 * 帧载荷与 oracle 对账仍由 `harness.ts` 的正式用例负责。
 */

const FLASH_BASE = 0x0800_0000;
const ARTIFACT_JS = resolve(import.meta.dirname, '..', 'dist', 'model.js');

type Outputs = Readonly<
  Record<string, readonly { readonly time: number; readonly value: unknown }[]>
>;

interface ArtifactAdapter {
  readonly methods?: Readonly<Record<string, (params: unknown) => unknown>>;
  sync(batch: { readonly from: number; readonly to: number; readonly outputs: Outputs }): void;
  dispose(): void;
}

interface DeviceModule {
  readonly model: DeviceIR;
  readonly create: (context: never) => ArtifactAdapter;
}

interface InstanceState {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

export interface BoardHarness {
  readonly board: {
    readonly time: number;
    readonly status: string;
    runUntil(target: number): void;
    dispose(): void;
    readonly topics: {
      onDidReceive(listener: (message: { topic: string; payload: unknown }) => unknown): {
        dispose(): void;
      };
    };
    readonly onDidError: (listener: (error: unknown) => unknown) => { dispose(): void };
  };
  readonly instance: InstanceState;
  readonly methods: Readonly<Record<string, (params: unknown) => unknown>>;
  readonly events: readonly {
    readonly name: string;
    readonly time: number;
    readonly value: unknown;
  }[];
  readonly errors: readonly string[];
  run(spanPs: number): void;
  state(name: string): unknown;
  memory(name: string): Uint8Array;
  dispose(): void;
}

let modulePromise: Promise<DeviceModule> | undefined;

function loadArtifact(): Promise<DeviceModule> {
  modulePromise ??= (async () => {
    if (!existsSync(ARTIFACT_JS))
      throw new Error(`Missing ${ARTIFACT_JS}; run "mica build" before the tests`);

    return (await import(pathToFileURL(ARTIFACT_JS).href)) as DeviceModule;
  })();

  return modulePromise;
}

function findInstance(value: unknown): InstanceState | undefined {
  if (value instanceof Map) return value.get('ct117e-m4') as InstanceState | undefined;
  if (Array.isArray(value))
    return (value as readonly InstanceState[]).find(
      (entry) => (entry as unknown as { id?: string }).id === 'ct117e-m4',
    );
  if (value !== null && typeof value === 'object')
    return (value as Record<string, InstanceState>)['ct117e-m4'];
  return undefined;
}

export async function createBoardHarness(firmware: Uint8Array): Promise<BoardHarness> {
  const { model, create } = await loadArtifact();
  let methods: Readonly<Record<string, (params: unknown) => unknown>> = {};

  const createAdapter = (context: never): ArtifactAdapter => {
    const adapted = adaptModelFactory(create as never, {
      props: (legacy) => ({
        ...(legacy.props as Readonly<Record<string, unknown>>),
        firmware: firmwareImage([{ addressSpace: 'flash', address: FLASH_BASE, data: firmware }]),
      }),
      events: {
        onDidFramebuffer: 'framebuffer',
        onDidFault: 'fault',
        onDidSerial1Tx: 'serial1.tx',
        onDidSerial2Tx: 'serial2.tx',
        onDidSerial3Tx: 'serial3.tx',
        onDidLed: 'led',
        onDidPress: 'button',
        onDidPotentiometer: 'potentiometer',
        onDidEepromWrite: 'eepromWrite',
        onDidWiper: 'wiper',
      },
    });
    const adapter = adapted(context);

    methods = adapter.methods as unknown as Readonly<Record<string, (params: unknown) => unknown>>;

    return {
      methods,
      sync(batch) {
        adapter.sync(batch);
      },
      dispose: () => adapter.dispose(),
    };
  };

  const board = createBoard(
    createDeviceLibrary([{ id: 'ct117e-m4', model, create: createAdapter as never }]),
    {
      instances: [
        {
          id: 'ct117e-m4',
          type: 'ct117e-m4',
          props: { clockFrequency: 80_000_000, refreshRate: 60 },
        },
      ],
      nets: [
        {
          id: 'vdd',
          voltage: 3.3,
          pins: [{ instance: 'ct117e-m4', pin: 'VDD1' }],
        },
        {
          id: 'vss',
          voltage: 0,
          pins: [{ instance: 'ct117e-m4', pin: 'VSS1' }],
        },
      ],
    } as never,
  );

  const instance = findInstance((board as unknown as { instances?: unknown }).instances);
  if (instance === undefined) {
    board.dispose();
    throw new Error('ct117e-m4 board did not expose its single instance');
  }

  const events: { name: string; time: number; value: unknown }[] = [];
  const errors: string[] = [];
  const subscription = board.topics.onDidReceive((message) => {
    if (['led', 'button', 'potentiometer'].includes(message.topic))
      events.push({
        name: message.topic,
        time: board.time,
        value: message.payload,
      });
  });
  const diagnostics = board.onDidError((error) =>
    errors.push(String((error as { message?: unknown }).message ?? error)),
  );

  return {
    board,
    instance,
    methods,
    events,
    errors,
    run(spanPs) {
      board.runUntil(board.time + spanPs);
    },
    state(name) {
      if (!instance.states.has(name)) throw new Error(`Missing state ${name}`);
      return instance.states.get(name);
    },
    memory(name) {
      const value = instance.memories.get(name);
      if (value === undefined) throw new Error(`Missing memory ${name}`);
      return value;
    },
    dispose() {
      subscription.dispose();
      diagnostics.dispose();
      board.dispose();
    },
  };
}
