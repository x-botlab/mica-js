import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * 板级夹具：现场编译 `model.ddl`，装载 `src/` 里的适配器，再配一个只观察引脚电平的
 * 探针器件和电源网络。固件、电气求解、JIT 全部走真实 `@mica-js/simulator` 板。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', 'src', 'devices', 'stm32g431rbt6');

const PROBE_MODEL = `
device TestProbe {
  pin p(low: 0.8, high: 2.0);
  output channel level: number(capacity: 64, overflow: Overflow.drop_oldest);
  fn report() {
    if p.sample.level == Logic.high {
      level.send(1);
    } else if p.sample.level == Logic.low {
      level.send(0);
    } else {
      level.send(2);
    }
  }
  process start { report(); }
  reaction changed on p.sample.level as (previous, next) { report(); }
}
`;

const SOURCE_MODEL = `
device TestSource(outputResistance: number default 25) {
  pin y;
  pin vcc;
  pin gnd;
  input channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
  state wanted: number = 2;
  fn apply() {
    if wanted == 1 {
      y.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else if wanted == 0 {
      y.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y.intent <- [];
    }
  }
  process start {
    apply();
    loop {
      wanted = await level.receive();
      apply();
    }
  }
}
`;

export interface Message {
  readonly value: unknown;
  readonly time: number;
}

export interface Adapter {
  sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }): void;
  dispose(): void;
}

export interface SourceHandle {
  send(value: unknown): void;
}

export interface CircuitOptions {
  readonly firmware?: Uint8Array;
  readonly clockFrequency?: number;
  readonly pins?: readonly string[];
  /** `artifact` 装载构建产物，默认装载 `src/`。 */
  readonly variant?: 'source' | 'artifact';
}

export interface Circuit {
  readonly levels: Readonly<Record<string, number>>;
  readonly history: Readonly<Record<string, readonly number[]>>;
  readonly topics: Readonly<Record<string, unknown[]>>;
  readonly faults: readonly string[];
  readonly inputs: Readonly<Record<string, SourceHandle>>;
  /** 诊断：JIT 是否走直接路径、缓存块数与直接程序数。 */
  readonly jit: () => { direct: boolean; cache: number; programs: number };
  run(durationPs: number): void;
  dispose(): void;
}

let moduleCache: Promise<{ model: DeviceIR; create: (context: never) => Adapter }> | undefined;
let artifactCache: Promise<{ model: DeviceIR; create: (context: never) => Adapter }> | undefined;
let probeCache: Promise<DeviceIR> | undefined;
let sourceCache: Promise<DeviceIR> | undefined;

function loadDevice(): Promise<{ model: DeviceIR; create: (context: never) => Adapter }> {
  moduleCache ??= (async () => {
    const [model, adapter] = await Promise.all([
      compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{
        default: (context: never) => Adapter;
      }>,
    ]);

    return { model, create: adapter.default };
  })();

  return moduleCache;
}

const ARTIFACT_JS = join(
  DEVICE_DIR,
  '..',
  '..',
  '..',
  'dist',
  'devices',
  'stm32g431rbt6',
  'device.js',
);

/** 装载构建产物；未构建时返回 undefined，调用方跳过用例。 */
export function artifactAvailable(): boolean {
  return existsSync(ARTIFACT_JS);
}

function loadArtifact(): Promise<{ model: DeviceIR; create: (context: never) => Adapter }> {
  artifactCache ??= (async () => {
    const module = (await import(pathToFileURL(ARTIFACT_JS).href)) as {
      model: DeviceIR;
      create: (context: never) => Adapter;
    };

    return { model: module.model, create: module.create };
  })();

  return artifactCache;
}

function probeModel(): Promise<DeviceIR> {
  probeCache ??= compileDDL(PROBE_MODEL);
  return probeCache;
}

function sourceModel(): Promise<DeviceIR> {
  sourceCache ??= compileDDL(SOURCE_MODEL);
  return sourceCache;
}

const PROBE_PINS = [
  'PA0',
  'PA1',
  'PA2',
  'PA3',
  'PA4',
  'PA5',
  'PA6',
  'PA7',
  'PA8',
  'PA9',
  'PA10',
] as const;

export async function circuit(options: CircuitOptions = {}): Promise<Circuit> {
  const [device, probe, source] = await Promise.all([
    options.variant === 'artifact' ? loadArtifact() : loadDevice(),
    probeModel(),
    sourceModel(),
  ]);
  const levels: Record<string, number> = {};
  const history: Record<string, number[]> = {};
  const topics: Record<string, unknown[]> = {};
  const faults: string[] = [];
  const inputs: Record<string, SourceHandle> = {};
  const pins = options.pins ?? PROBE_PINS;

  const instrument = (context: {
    readonly topics: { publish(topic: string, payload: unknown): void };
  }) => {
    const adapter = device.create(context as never);

    return {
      sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }) {
        adapter.sync(batch);
      },
      dispose: () => adapter.dispose(),
    };
  };

  const createProbe = (pin: string) => () => ({
    sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }) {
      const messages = batch.outputs.level;
      const latest = messages?.[messages.length - 1];

      if (latest !== undefined) {
        (history[pin] ??= []).push(latest.value as number);
        levels[pin] = latest.value as number;
      }
    },
    dispose() {},
  });

  const createSource =
    (pin: string) => (context: { readonly inputs: Record<string, SourceHandle> }) => {
      const level = context.inputs.level;

      if (level !== undefined) inputs[pin] = level;

      return { sync() {}, dispose() {} };
    };

  const entries = [
    { id: 'mcu', model: device.model, create: instrument as never },
    ...pins.map((pin) => ({ id: `probe_${pin}`, model: probe, create: createProbe(pin) as never })),
    ...pins.map((pin) => ({ id: `src_${pin}`, model: source, create: createSource(pin) as never })),
  ];

  const instances = [
    {
      id: 'mcu',
      type: 'mcu',
      props: {
        firmware: options.firmware ?? new Uint8Array(),
        clockFrequency: options.clockFrequency ?? 16_000_000,
      },
    },
    ...pins.map((pin) => ({ id: `probe_${pin}`, type: `probe_${pin}` })),
    ...pins.map((pin) => ({ id: `src_${pin}`, type: `src_${pin}` })),
  ];

  const vddPins = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'];
  const vssPins = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'];
  const nets = [
    {
      id: 'vdd',
      pins: [
        ...vddPins.map((pin) => ({ instance: 'mcu', pin })),
        ...pins.map((pin) => ({ instance: `src_${pin}`, pin: 'vcc' })),
      ],
      voltage: 3.3,
    },
    {
      id: 'vss',
      pins: [
        ...vssPins.map((pin) => ({ instance: 'mcu', pin })),
        ...pins.map((pin) => ({ instance: `src_${pin}`, pin: 'gnd' })),
      ],
      voltage: 0,
    },
    ...pins.map((pin) => ({
      id: pin,
      pins: [
        { instance: 'mcu', pin },
        { instance: `probe_${pin}`, pin: 'p' },
        { instance: `src_${pin}`, pin: 'y' },
      ],
    })),
  ];

  const board = createBoard(createDeviceLibrary(entries as never), {
    instances,
    nets,
  } as never);

  // 话题只记录，供需要时检查；装置的诊断通过板级错误列表暴露。
  const topicSubscription = board.topics.onDidReceive((message) => {
    (topics[message.topic] ??= []).push(message.payload);
  });
  board.onDidError((error) => faults.push(error.message));

  board.runUntil(0);

  return {
    levels,
    history,
    topics,
    faults,
    inputs,
    jit: () => {
      const jit = (board as unknown as { jits?: readonly unknown[] }).jits?.[0] as
        | { direct?: unknown; cache?: Map<number, unknown>; directPrograms?: Map<string, unknown> }
        | undefined;

      return {
        direct: jit?.direct !== undefined,
        cache: jit?.cache?.size ?? 0,
        programs: jit?.directPrograms?.size ?? 0,
      };
    },
    run: (durationPs) => board.runUntil(board.time + durationPs),
    dispose: () => {
      topicSubscription.dispose();
      board.dispose();
    },
  };
}

/** 读取测试文件里的裸二进制固件。 */
export function firmware(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)));
}
