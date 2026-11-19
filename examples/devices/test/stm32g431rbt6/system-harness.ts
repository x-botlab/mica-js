import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { RuntimeDiagnostic } from '@mica-js/simulator';
import { firmwareImage } from '../support/legacy-model-bridge.mjs';
import type { DeviceBatch, DeviceContext, InputChannel } from '@mica-js/sdk/device';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';
import { adaptDevice } from './harness';

/**
 * NVIC/EXTI/NRST 测试专用夹具。
 *
 * 与公共 `harness.ts` 分开：这里需要任意 GPIO（PA/PB/PC/PD/PF）与 NRST 的电源/探针，
 * 并暴露模型 state/memory 供验证复位后的寄存器与异常隐藏状态。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');

const PROBE_MODEL = `
device SystemProbe {
  pin p(low: 0.8, high: 2.0);
  output channel level: number(capacity: 128, overflow: Overflow.drop_oldest);
  fn report() {
    if p.sample.level == Logic.high { level.send(1); }
    else if p.sample.level == Logic.low { level.send(0); }
    else { level.send(2); }
  }
  process start { report(); }
  reaction changed on p.sample.level as (previous, next) { report(); }
}
`;

const SOURCE_MODEL = `
device SystemSource(outputResistance: number default 25, initialLevel: number default 2) {
  pin y;
  pin vcc;
  pin gnd;
  input channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
  state wanted: number = initialLevel;
  fn apply() {
    if wanted == 1 { y.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
    else if wanted == 0 { y.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
    else { y.intent <- []; }
  }
  process start { apply(); loop { wanted = await level.receive(); apply(); } }
}
`;

let deviceModule: Promise<{ create: unknown; model: DeviceIR }> | undefined;
const models = Promise.all([compileDDL(PROBE_MODEL), compileDDL(SOURCE_MODEL)]);

function loadDevice(): Promise<{ create: unknown; model: DeviceIR }> {
  deviceModule ??= (async () => {
    const [model, module] = await Promise.all([
      compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{ create: unknown }>,
    ]);

    return { model, create: module.create };
  })();

  return deviceModule;
}

export interface SystemBoardOptions {
  readonly firmware: Uint8Array;
  readonly pins?: readonly string[];
  readonly clockFrequency?: number;
  readonly initialLevels?: Readonly<Record<string, number>>;
}

export interface SystemBoard {
  readonly levels: Readonly<Record<string, number>>;
  readonly history: Readonly<Record<string, readonly number[]>>;
  readonly faults: readonly string[];
  /** 生产 `onDidFault` 映射到 board.topics 'fault' 的 CPU fault 值。 */
  readonly cpuFaults: number[];
  readonly inputs: Readonly<Record<string, { send(value: unknown): void }>>;
  readonly code: Uint8Array;
  readonly methods: unknown;
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
  state(name: string): unknown;
  sysWord(offset: number): number;
  periphWord(offset: number): number;
  sramWord(offset: number): number;
  run(durationPs: number): void;
  dispose(): void;
}

const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

export async function systemBoard(options: SystemBoardOptions): Promise<SystemBoard> {
  const [device, [probeModel, sourceModel]] = await Promise.all([loadDevice(), models]);
  const pins = options.pins ?? [];
  const levels: Record<string, number> = {};
  const history: Record<string, number[]> = {};
  const inputs: Record<string, { send(value: unknown): void }> = {};
  const faults: string[] = [];
  const cpuFaults: number[] = [];
  let methods: unknown;

  const createMcu = adaptDevice(device, {
    image: firmwareImage([
      { addressSpace: 'code', address: 0x0800_0000, data: new Uint8Array(options.firmware) },
    ]),
    clockFrequency: options.clockFrequency ?? 16_000_000,
  }) as unknown as (context: never) => {
    methods?: unknown;
    sync(batch: unknown): void;
    dispose(): void;
  };

  const mcu = (context: never) => {
    const adapter = createMcu(context);

    methods = adapter.methods;

    return {
      sync(batch: unknown) {
        adapter.sync(batch);
      },
      dispose: () => adapter.dispose(),
    };
  };

  const createProbe = (pin: string) => () => ({
    sync(batch: DeviceBatch<{ readonly level?: readonly { readonly value: unknown }[] }>) {
      const messages = batch.outputs.level ?? [];

      for (const message of messages) (history[pin] ??= []).push(Number(message.value));
      const latest = messages[messages.length - 1];

      if (latest !== undefined) levels[pin] = Number(latest.value);
    },
    dispose() {},
  });

  const createSource =
    (pin: string, initial: number) =>
    (context: DeviceContext<object, { readonly level: InputChannel<number> }>) => {
      const channel = context.inputs.level;

      if (channel !== undefined) inputs[pin] = channel;
      void initial;

      return { sync() {}, dispose() {} };
    };

  const entries = [
    { id: 'mcu', model: device.model, create: mcu as never },
    ...pins.map((pin) => ({ id: `probe_${pin}`, model: probeModel, create: createProbe(pin) as never })),
    ...pins.map((pin) => ({
      id: `src_${pin}`,
      model: sourceModel,
      create: createSource(pin, options.initialLevels?.[pin] ?? 2) as never,
    })),
  ];

  const board = createBoard(createDeviceLibrary(entries as never), {
    instances: [
      { id: 'mcu', type: 'mcu', props: { clockFrequency: options.clockFrequency ?? 16_000_000 } },
      ...pins.map((pin) => ({
        id: `probe_${pin}`,
        type: `probe_${pin}`,
      })),
      ...pins.map((pin) => ({
        id: `src_${pin}`,
        type: `src_${pin}`,
        props: { initialLevel: options.initialLevels?.[pin] ?? 2 },
      })),
    ],
    nets: [
      {
        id: 'vdd',
        voltage: 3.3,
        pins: [
          ...VDD.map((pin) => ({ instance: 'mcu', pin })),
          ...pins.map((pin) => ({ instance: `src_${pin}`, pin: 'vcc' })),
        ],
      },
      {
        id: 'vss',
        voltage: 0,
        pins: [
          ...VSS.map((pin) => ({ instance: 'mcu', pin })),
          ...pins.map((pin) => ({ instance: `src_${pin}`, pin: 'gnd' })),
        ],
      },
      ...pins.map((pin) => ({
        id: pin,
        pins: [
          { instance: 'mcu', pin },
          { instance: `probe_${pin}`, pin: 'p' },
          { instance: `src_${pin}`, pin: 'y' },
        ],
      })),
    ],
  } as never);

  const subscription = board.onDidError((error: RuntimeDiagnostic) =>
    faults.push(error.message),
  );
  const faultSubscription = board.topics.onDidReceive((message) => {
    if (message.topic === 'fault') cpuFaults.push(Number(message.payload));
  });
  board.runUntil(0);

  const instance = (
    board as unknown as { instances?: readonly InstanceView[] }
  ).instances?.[0];
  const view = (memory: string): DataView | undefined => {
    const bytes = instance?.memories.get(memory);

    return bytes === undefined
      ? undefined
      : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const word = (memory: string, offset: number): number =>
    view(memory)?.getUint32(offset & 0xffff, true) ?? 0;

  return {
    levels,
    history,
    faults,
    cpuFaults,
    inputs,
    get code() {
      return new Uint8Array(instance?.memories.get('code') ?? []);
    },
    methods,
    states: instance?.states ?? new Map(),
    memories: instance?.memories ?? new Map(),
    state: (name) => instance?.states.get(name),
    sysWord: (offset) => word('sys', offset),
    periphWord: (offset) => word('periph', offset),
    sramWord: (offset) => word('sram', offset),
    run: (durationPs) => board.runUntil(board.time + durationPs),
    dispose: () => {
      subscription.dispose();
      faultSubscription.dispose();
      board.dispose();
    },
  };
}
