import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firmwareImage } from '../support/legacy-model-bridge.mjs';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';
import { createBoardWith, loadSourceDevice } from '../harness';
import type { DeviceInstance, DeviceModule, Manifest, TestBoard } from '../harness';

/**
 * USART 专属板级夹具。
 *
 * 被测器件是真实的 `examples/devices/stm32g431rbt6`（DDL + 统一适配器）；RX 由
 * `uart-probe` 的 TXD 或可编程位源通过真实引脚网络驱动，TX 由 `uart-probe` 的 RXD
 * 复原。没有第二条「直接写 RDR」的旁路。
 */

const DEVICE_ROOT = join(import.meta.dirname, '..', '..', 'stm32g431rbt6');
const DEVICE_DIR = join(DEVICE_ROOT, 'src');

const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

let mcuModule: Promise<DeviceModule> | undefined;
let probeModule: Promise<DeviceModule> | undefined;
let bitSourceModule: Promise<DeviceModule> | undefined;
let levelProbeModule: Promise<DeviceModule> | undefined;
let mcuConfig:
  | {
      readonly firmware: ReturnType<typeof firmwareImage>;
      readonly clockFrequency: number;
    }
  | undefined;

function loadMcu(): Promise<DeviceModule> {
  mcuModule ??= (async () => {
    const [model, adapter] = await Promise.all([
      compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{
        create: (context: Record<string, unknown>) => unknown;
      }>,
    ]);

    return {
      model,
      create: ((context: Record<string, unknown>) => {
        if (mcuConfig === undefined) throw new Error('USART rig: missing MCU config');
        const merged = {
          ...context,
          props: {
            ...(context.props as object),
            clockFrequency: mcuConfig.clockFrequency,
            firmware: mcuConfig.firmware,
          },
        };

        return adapter.create(merged);
      }) as DeviceModule['create'],
      manifest: JSON.parse(readFileSync(join(DEVICE_ROOT, 'package.json'), 'utf8')) as Manifest,
    };
  })();

  return mcuModule;
}

/** 真实 uart-probe 器件模块；用于 8N1 注入/复原。 */
function loadProbe(): Promise<DeviceModule> {
  probeModule ??= loadSourceDevice('uart-probe');

  return probeModule;
}

const BIT_SOURCE_DDL = `
device UsartBitSource(baud: number default 115200) {
  const bitTime = round(1e12 / baud);
  assert isSafeInteger(bitTime) && bitTime >= 2,
    "baud must produce an integer bit time of at least 2 ps";

  pin y;
  pin vcc;
  pin gnd;
  input channel frame: bytes(maxLength: 64, capacity: 8, overflow: Overflow.drop_oldest);
  memory bits[64];
  state length: number = 0;
  state sequence: number = 0;

  fn drive(high: bool) {
    if high {
      y.intent <- [resistor(to: vcc, resistance: 25)];
    } else {
      y.intent <- [resistor(to: gnd, resistance: 25)];
    }
  }

  fn load(value: bytes) {
    let index = 0;
    while index < value.length {
      store8(bits, index, value[index]);
      index = index + 1;
    }
    length = value.length;
    sequence = sequence + 1;
  }

  process start {
    drive(true);
    loop {
      const value = await frame.receive();
      load(value);
    }
  }

  process emit on sequence {
    const token = sequence;
    const count = length;
    let index = 0;
    while index < count {
      drive(load8(bits, index) != 0);
      await ticks(bitTime);
      if token != sequence {
        return;
      }
      index = index + 1;
    }
  }
}
`;

const LEVEL_PROBE_DDL = `
device UsartLevelProbe {
  pin y(low: 0.8, high: 2.0);
  output channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
  pure fn code(sampled: Logic) -> number {
    if sampled == Logic.high {
      return 1;
    } else if sampled == Logic.low {
      return 0;
    }
    return 2;
  }
  derived current: number = code(y.sample.level);
  process start {
    level.send(current);
  }
  process changed on current {
    level.send(current);
  }
}
`;

function loadLevelProbe(): Promise<DeviceModule> {
  levelProbeModule ??= (async () => {
    const model: DeviceIR = await compileDDL(LEVEL_PROBE_DDL, {
      uri: 'mica:test/usart-level-probe.ddl',
    });

    return {
      model,
      create: () => ({ sync() {}, dispose() {} }),
      manifest: {
        publisher: 'test',
        name: 'usart-level-probe',
        version: '1.0.0',
        engines: { mica: '^0.3.0' },
        displayName: 'USART level probe',
        model: { entry: 'model.js', types: {}, methods: {}, events: {} },
      },
    };
  })();

  return levelProbeModule;
}

function loadBitSource(): Promise<DeviceModule> {
  bitSourceModule ??= (async () => {
    const model: DeviceIR = await compileDDL(BIT_SOURCE_DDL, {
      uri: 'mica:test/usart-bit-source.ddl',
    });

    return {
      model,
      create: () => ({ sync() {}, dispose() {} }),
      manifest: {
        publisher: 'test',
        name: 'usart-bit-source',
        version: '1.0.0',
        engines: { mica: '^0.3.0' },
        displayName: 'USART bit source',
        model: { entry: 'model.js', types: {}, methods: {}, events: {} },
      },
    };
  })();

  return bitSourceModule;
}

export type UsartWiring = 'rx' | 'rx2' | 'tx' | 'loopback' | 'rx-trigger';

export interface UsartBoardOptions {
  readonly firmware: Uint8Array;
  readonly baud?: number;
  readonly clockFrequency?: number;
  readonly wiring: UsartWiring;
  readonly rxPin?: 'PA10' | 'PA3' | 'PB11';
}

export interface UsartBoard extends TestBoard {
  readonly received: () => number[];
  readonly injected: (bytes: readonly number[]) => void;
  readonly injected2: (bytes: readonly number[]) => void;
  readonly received2: () => number[];
  readonly injectBits: (bits: readonly number[]) => void;
  readonly trigger: (high: boolean) => void;
  readonly runFor: (durationPs: number, slicePs?: number) => void;
}

export async function usartBoard(options: UsartBoardOptions): Promise<UsartBoard> {
  const [mcu, probe, bits, levelProbe] = await Promise.all([
    loadMcu(),
    loadProbe(),
    loadBitSource(),
    loadLevelProbe(),
  ]);
  const baud = options.baud ?? 115200;
  const image = firmwareImage([
    { addressSpace: 'code', address: 0x0800_0000, data: options.firmware },
  ]);
  const devices: DeviceInstance[] = [
    {
      id: 'mcu',
      type: 'stm32g431rbt6',
      device: mcu,
      props: { clockFrequency: options.clockFrequency ?? 16_000_000 },
    },
    {
      id: 'ready',
      type: 'usart-level-probe',
      device: levelProbe,
    },
  ];
  const nets: {
    id: string;
    voltage?: number;
    pins: { instance: string; pin: string }[];
  }[] = [
    {
      id: 'vdd',
      voltage: 3.3,
      pins: [...VDD.map((pin) => ({ instance: 'mcu', pin }))],
    },
    {
      id: 'vss',
      voltage: 0,
      pins: [...VSS.map((pin) => ({ instance: 'mcu', pin }))],
    },
  ];

  const rxPin = options.rxPin ?? 'PA10';
  const rxNet: { instance: string; pin: string }[] = [{ instance: 'mcu', pin: rxPin }];
  const needsTxPullup = options.wiring === 'tx' || options.wiring === 'loopback';

  if (needsTxPullup) nets[0]!.pins.push({ instance: 'tx-pull', pin: 'b' });

  if (options.wiring === 'loopback') {
    rxNet.push({ instance: 'mcu', pin: 'PA9' });
    rxNet.push({ instance: 'tx-pull', pin: 'a' });
  } else if (options.wiring === 'rx2') {
    devices.push(
      { id: 'uart1', type: 'uart-probe', device: probe, props: { baud } },
      { id: 'uart2', type: 'uart-probe', device: probe, props: { baud } },
    );
    nets.push(
      {
        id: 'rx1',
        pins: [
          { instance: 'mcu', pin: 'PA10' },
          { instance: 'uart1', pin: 'txd' },
        ],
      },
      {
        id: 'rx2',
        pins: [
          { instance: 'mcu', pin: 'PA3' },
          { instance: 'uart2', pin: 'txd' },
        ],
      },
      { id: 'uart1-vdd', voltage: 3.3, pins: [{ instance: 'uart1', pin: 'vcc' }] },
      { id: 'uart1-vss', voltage: 0, pins: [{ instance: 'uart1', pin: 'gnd' }] },
      { id: 'uart2-vdd', voltage: 3.3, pins: [{ instance: 'uart2', pin: 'vcc' }] },
      { id: 'uart2-vss', voltage: 0, pins: [{ instance: 'uart2', pin: 'gnd' }] },
    );
  } else if (options.wiring === 'rx' || options.wiring === 'rx-trigger') {
    devices.push({ id: 'uart', type: 'uart-probe', device: probe, props: { baud } });
    rxNet.push({ instance: 'uart', pin: 'txd' });
    nets.push(
      { id: 'uart-vdd', voltage: 3.3, pins: [{ instance: 'uart', pin: 'vcc' }] },
      { id: 'uart-vss', voltage: 0, pins: [{ instance: 'uart', pin: 'gnd' }] },
    );
  }

  if (options.wiring === 'tx') {
    devices.push({ id: 'uart', type: 'uart-probe', device: probe, props: { baud } });
    nets.push(
      {
        id: 'tx',
        pins: [
          { instance: 'mcu', pin: 'PA9' },
          { instance: 'uart', pin: 'rxd' },
          { instance: 'tx-pull', pin: 'a' },
        ],
      },
      { id: 'uart-vdd', voltage: 3.3, pins: [{ instance: 'uart', pin: 'vcc' }] },
      { id: 'uart-vss', voltage: 0, pins: [{ instance: 'uart', pin: 'gnd' }] },
    );
  }

  if (options.wiring === 'rx-trigger') {
    devices.push({
      id: 'bits',
      type: 'usart-bit-source',
      device: bits,
      props: { baud },
    });
    nets.push(
      { id: 'bits-vdd', voltage: 3.3, pins: [{ instance: 'bits', pin: 'vcc' }] },
      { id: 'bits-vss', voltage: 0, pins: [{ instance: 'bits', pin: 'gnd' }] },
    );
    rxNet.push({ instance: 'bits', pin: 'y' });
    nets.push(
      {
        id: 'trigger',
        pins: [
          { instance: 'mcu', pin: 'PA1' },
          { instance: 'trigger', pin: 'y' },
        ],
      },
      { id: 'trigger-vdd', voltage: 3.3, pins: [{ instance: 'trigger', pin: 'vcc' }] },
      { id: 'trigger-vss', voltage: 0, pins: [{ instance: 'trigger', pin: 'gnd' }] },
    );
  }

  if (options.wiring !== 'rx2') nets.push({ id: 'rx', pins: rxNet });
  nets.push({
    id: 'ready',
    pins: [
      { instance: 'mcu', pin: 'PA0' },
      { instance: 'ready', pin: 'y' },
    ],
  });
  mcuConfig = { firmware: image, clockFrequency: options.clockFrequency ?? 16_000_000 };
  const board = await createBoardWith(devices, {
    nets,
    resistors: needsTxPullup ? [{ id: 'tx-pull', resistance: 100_000 }] : [],
    sources: options.wiring === 'rx-trigger' ? ['trigger'] : [],
  });

  mcuConfig = undefined;

  const injectViaUart = (bytes: readonly number[]): void => {
    board.send(options.wiring === 'rx2' ? 'uart1' : 'uart', 'send', new Uint8Array(bytes));
  };
  const injectViaUart2 = (bytes: readonly number[]): void => {
    board.send('uart2', 'send', new Uint8Array(bytes));
  };
  const injectBits = (values: readonly number[]): void => {
    board.injectInput('bits', 'frame', new Uint8Array(values));
  };
  const trigger = (high: boolean): void => {
    board.injectInput('trigger', 'level', high ? 1 : 0);
  };

  return {
    ...board,
    get time() {
      return board.time;
    },
    received: () => {
      const values: number[] = [];

      for (const entry of board.events) {
        if (entry.name !== 'onDidUart1Tx') continue;
        const payload = entry.value as { readonly data?: Uint8Array };
        if (payload.data !== undefined) values.push(...payload.data);
      }

      return values;
    },
    injected: injectViaUart,
    injected2: injectViaUart2,
    received2: () => {
      const values: number[] = [];

      for (const entry of board.events) {
        if (entry.name !== 'onDidUart2Tx') continue;
        const payload = entry.value as { readonly data?: Uint8Array };
        if (payload.data !== undefined) values.push(...payload.data);
      }

      return values;
    },
    injectBits,
    trigger,
    runFor: (durationPs, slicePs = 10_000_000) => {
      const end = board.time + durationPs;

      while (board.time < end) board.runUntil(Math.min(board.time + slicePs, end));
    },
  };
}
