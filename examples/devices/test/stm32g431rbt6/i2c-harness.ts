import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '@mica-js/sdk/device';
import type { DeviceFactory } from '@mica-js/sdk/device';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';
import { loadSourceDevice, resistorModel } from '../harness.ts';

/**
 * STM32G431 + AT24C02 + MCP4017 的真实板级夹具。
 *
 * 固件、中央 `PERIPHERALS`（含 I2C/SPI）、GPIO 开漏、外部上拉、EEPROM 与电位器
 * 都走真实 board/solver/JIT；夹具只捕获各实例的公共方法，不修改注册表或模型 profile。
 */

const MCU_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');

interface McuModule {
  readonly model: DeviceIR;
  readonly create: unknown;
}

let mcuCache: Promise<McuModule> | undefined;

function loadMcu(): Promise<McuModule> {
  mcuCache ??= (async () => {
    const ddl = readFileSync(join(MCU_DIR, 'model.ddl'), 'utf8');

    const [model, adapter] = await Promise.all([
      compileDDL(ddl, {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      import(pathToFileURL(join(MCU_DIR, 'index.ts')).href) as Promise<{ create: unknown }>,
    ]);

    return { model, create: adapter.create };
  })();

  return mcuCache;
}


export interface BusMethods {
  readonly methods: Readonly<Record<string, (params: never) => unknown>>;
}

export interface I2cCircuitOptions {
  readonly firmware: Uint8Array;
  readonly clockFrequency?: number;
  readonly pullup?: number;
  readonly eepromAddress?: number;
}

export interface I2cCircuit {
  readonly board: Board;
  readonly faults: readonly string[];
  readonly serial2: readonly number[];
  memory(name: string): Uint8Array | undefined;
  state(name: string): unknown;
  run(durationPs: number): void;
  query(instance: string, method: string, params?: unknown): Promise<unknown>;
  dispose(): void;
}

interface Captured {
  readonly methods: Readonly<Record<string, (params: never) => unknown>>;
}

export async function createI2cCircuit(options: I2cCircuitOptions): Promise<I2cCircuit> {
  const [mcu, eeprom, pot, clock] = await Promise.all([
    loadMcu(),
    loadSourceDevice('at24c02'),
    loadSourceDevice('mcp4017'),
    Promise.resolve(options.clockFrequency ?? 16_000_000),
  ]);
  const image = firmwareImage([
    {
      addressSpace: 'code',
      address: 0x0800_0000,
      data: new Uint8Array(options.firmware),
    },
  ]);
  const pullup = options.pullup ?? 10_000;
  const [pullModel, resistorW] = await Promise.all([resistorModel(pullup), resistorModel(10_000)]);
  const captured = new Map<string, Captured>();
  const faults: string[] = [];
  const serial2: number[] = [];

  const capture =
    (id: string, factory: DeviceFactory): DeviceFactory =>
    (context) => {
      const adapter = factory(context) as ReturnType<DeviceFactory> & Captured;

      captured.set(id, adapter);

      return adapter;
    };
  const idle = () => ({ sync() {}, dispose() {} });
  const mcuFactory = adaptModelFactory(
    mcu.create as never,
    {
      props: {
        clockFrequency: clock,
        firmware: image,
      },
      events: {
        onDidUart2Tx: {
          topic: 'serial2.tx',
          transform: (value: unknown) =>
            value !== null && typeof value === 'object' && 'data' in value
              ? (value as { readonly data: Uint8Array }).data
              : new Uint8Array(),
        },
        onDidFault: 'fault',
      },
    },
  );
  const eepromFactory = adaptModelFactory(eeprom.create as never, {});
  const potFactory = adaptModelFactory(pot.create as never, {});

  const entries = [
    {
      id: 'mcu',
      model: mcu.model,
      create: capture('mcu', mcuFactory as unknown as DeviceFactory),
    },
    {
      id: 'eeprom',
      model: eeprom.model,
      create: capture('eeprom', eepromFactory as unknown as DeviceFactory),
    },
    {
      id: 'pot',
      model: pot.model,
      create: capture('pot', potFactory as unknown as DeviceFactory),
    },
    {
      id: 'pullScl',
      model: pullModel,
      create: idle as unknown as DeviceFactory,
    },
    {
      id: 'pullSda',
      model: pullModel,
      create: idle as unknown as DeviceFactory,
    },
    {
      id: 'rW',
      model: resistorW,
      create: idle as unknown as DeviceFactory,
    },
  ];
  const vddPins = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'];
  const vssPins = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'];
  const nets = [
    {
      id: 'vdd',
      pins: [
        ...vddPins.map((pin) => ({ instance: 'mcu', pin })),
        { instance: 'eeprom', pin: 'vcc' },
        { instance: 'pot', pin: 'vdd' },
        { instance: 'pullScl', pin: 'b' },
        { instance: 'pullSda', pin: 'b' },
        { instance: 'rW', pin: 'b' },
      ],
      voltage: 3.3,
    },
    {
      id: 'vss',
      pins: [
        ...vssPins.map((pin) => ({ instance: 'mcu', pin })),
        { instance: 'eeprom', pin: 'gnd' },
        { instance: 'eeprom', pin: 'a0' },
        { instance: 'eeprom', pin: 'a1' },
        { instance: 'eeprom', pin: 'a2' },
        { instance: 'eeprom', pin: 'wp' },
        { instance: 'pot', pin: 'vss' },
        { instance: 'pot', pin: 'b' },
      ],
      voltage: 0,
    },
    {
      id: 'scl',
      pins: [
        { instance: 'mcu', pin: 'PB8' },
        { instance: 'eeprom', pin: 'scl' },
        { instance: 'pot', pin: 'scl' },
        { instance: 'pullScl', pin: 'a' },
      ],
    },
    {
      id: 'sda',
      pins: [
        { instance: 'mcu', pin: 'PB7' },
        { instance: 'eeprom', pin: 'sda' },
        { instance: 'pot', pin: 'sda' },
        { instance: 'pullSda', pin: 'a' },
      ],
    },
    {
      id: 'potW',
      pins: [
        { instance: 'pot', pin: 'w' },
        { instance: 'rW', pin: 'a' },
      ],
    },
  ];
  const library = createDeviceLibrary(entries as never);
  const board = createBoard(library, {
    instances: [
      { id: 'mcu', type: 'mcu', props: { clockFrequency: clock } },
      { id: 'eeprom', type: 'eeprom' },
      { id: 'pot', type: 'pot' },
      { id: 'pullScl', type: 'pullScl' },
      { id: 'pullSda', type: 'pullSda' },
      { id: 'rW', type: 'rW' },
    ],
    nets,
  } as never);
  const subscription = board.topics.onDidReceive((message) => {
    if (message.topic === 'serial2.tx') {
      const data = message.payload as Uint8Array;

      serial2.push(...data);
    }
  });
  const errorSubscription = board.onDidError((error) => faults.push(error.message));
  const mcuInstance = (
    board as unknown as {
      readonly instances?: readonly {
        readonly states?: ReadonlyMap<string, unknown>;
        readonly memories?: ReadonlyMap<string, Uint8Array>;
      }[];
    }
  ).instances?.[0];

  return {
    board,
    faults,
    serial2,
    memory: (name) => mcuInstance?.memories?.get(name),
    state: (name) => mcuInstance?.states?.get(name),
    run: (durationPs) => board.runUntil(board.time + durationPs),
    async query(instance, method, params = null) {
      const target = captured.get(instance)?.methods[method];

      if (target === undefined) throw new Error(`未知方法：${instance}.${method}`);

      return await target(params as never);
    },
    dispose: () => {
      subscription.dispose();
      errorSubscription.dispose();
      board.dispose();
    },
  };
}
