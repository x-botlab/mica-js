import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '../support/legacy-model-bridge.mjs';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';

/** 真实器件 DDL + src/index.ts 适配器的板级夹具；额外暴露 SRAM 供固件写结果。 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');

export interface McuRunOptions {
  readonly firmware: Uint8Array;
  readonly durationPs?: number;
  readonly clockFrequency?: number;
  /** 在 PB6/PB4 上挂真实 Type-C fixture：5 V→56 k 源、5.1 k 下拉。 */
  readonly ucpd?: {
    readonly cc1Source?: boolean;
    readonly cc1Load?: boolean;
    readonly cc2Source?: boolean;
  };
}

export interface McuRunView {
  readonly board: ReturnType<typeof createBoard>;
  memory(name: string): Uint8Array;
  u32(offset: number): number;
  state(name: string): unknown;
  time(): number;
  run(durationPs: number): void;
  faults: readonly string[];
  voltageHistory(pin: string): readonly number[];
  dispose(): void;
}

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

const FIXTURE_MODEL = `
device UcpdFixture(resistance: number default 56000, toVcc: bool default true, initialOn: bool default false) {
  pin y;
  pin vcc;
  pin gnd;
  input channel enable: number(capacity: 8, overflow: Overflow.drop_oldest);
  state enabled: number = 0;
  fn apply() {
    if enabled == 1 {
      if toVcc {
        y.intent <- [resistor(to: vcc, resistance: resistance)];
      } else {
        y.intent <- [resistor(to: gnd, resistance: resistance)];
      }
    } else {
      y.intent <- [];
    }
  }
  process start {
    if initialOn { enabled = 1; }
    apply();
    loop {
      enabled = await enable.receive();
      apply();
    }
  }
}
`;

const VOLTMETER_MODEL = `
device UcpdVoltmeter {
  pin p;
  output channel voltage: number(capacity: 64, overflow: Overflow.drop_oldest);
  fn report() {
    const v = p.sample.voltage;
    if v != none { voltage.send(v); } else { voltage.send(-1); }
  }
  process start { report(); }
  reaction changed on p.sample.voltage as (previous, current) { report(); }
}
`;

let deviceCache: Promise<{ model: DeviceIR; create: unknown }> | undefined;

function loadDevice(): Promise<{ model: DeviceIR; create: unknown }> {
  deviceCache ??= (async () => {
    const [model, adapter] = await Promise.all([
      compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{ create: unknown }>,
    ]);

    return { model, create: adapter.create };
  })();

  return deviceCache;
}

export async function runMcu(options: McuRunOptions): Promise<McuRunView> {
  const device = await loadDevice();
  const faults: string[] = [];
  const voltageHistory = new Map<string, number[]>();
  const fixtures =
    options.ucpd === undefined
      ? undefined
      : await Promise.all([compileDDL(FIXTURE_MODEL), compileDDL(VOLTMETER_MODEL)]);
  const fixture = fixtures?.[0];
  const voltmeter = fixtures?.[1];
  const image = firmwareImage([
    { addressSpace: 'code', address: 0x0800_0000, data: new Uint8Array(options.firmware) },
  ]);
  const create = adaptModelFactory(device.create as never, {
    props: {
      clockFrequency: options.clockFrequency ?? 16_000_000,
      firmware: image,
    },
    events: {
      onDidFault: {
        topic: 'fault',
        transform: (value) => {
          faults.push(String(value));

          return value;
        },
      },
    },
  }) as unknown as (context: never) => { sync(batch: never): void; dispose(): void };

  const extraEntries: {
    id: string;
    model: DeviceIR;
    create: (context: never) => { sync(batch: never): void; dispose(): void };
  }[] = [];

  if (fixture !== undefined) {
    for (const id of ['cc1_source', 'cc1_load', 'cc2_source']) {
      extraEntries.push({
        id,
        model: fixture,
        create: () => ({ sync() {}, dispose() {} }),
      });
    }
  }
  if (voltmeter !== undefined) {
    for (const id of ['volt_cc1', 'volt_cc2']) {
      extraEntries.push({
        id,
        model: voltmeter,
        create: () => ({
          sync(batch: {
            readonly outputs: Readonly<Record<string, readonly { value: unknown }[]>>;
          }) {
            const pin = id === 'volt_cc1' ? 'cc1' : 'cc2';
            const values = batch.outputs.voltage ?? [];

            for (const message of values) {
              const value = message.value as number;

              (voltageHistory.get(pin) ?? voltageHistory.set(pin, []).get(pin)!).push(value);
            }
          },
          dispose() {},
        }),
      });
    }
  }

  const entries = [
    {
      id: 'mcu',
      model: device.model,
      create: (context: never) => {
        const adapter = create(context);

        return {
          sync(batch: never) {
            adapter.sync(batch);
          },
          dispose() {
            adapter.dispose();
          },
        };
      },
    },
    ...extraEntries,
  ];
  const vddPins = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'];
  const vssPins = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'];
  const instances: unknown[] = [
    { id: 'mcu', type: 'mcu', props: { clockFrequency: options.clockFrequency ?? 16_000_000 } },
  ];
  const nets: unknown[] = [
    {
      id: 'vdd',
      pins: vddPins.map((pin) => ({ instance: 'mcu', pin })),
      voltage: 3.3,
    },
    {
      id: 'vss',
      pins: vssPins.map((pin) => ({ instance: 'mcu', pin })),
      voltage: 0,
    },
  ];

  if (options.ucpd !== undefined && fixture !== undefined && voltmeter !== undefined) {
    instances.push(
      {
        id: 'cc1_source',
        type: 'cc1_source',
        props: {
          resistance: 56_000,
          toVcc: true,
          initialOn: options.ucpd.cc1Source !== false,
        },
      },
      {
        id: 'cc1_load',
        type: 'cc1_load',
        props: {
          resistance: 5_100,
          toVcc: false,
          initialOn: options.ucpd.cc1Load === true,
        },
      },
      {
        id: 'cc2_source',
        type: 'cc2_source',
        props: {
          resistance: 56_000,
          toVcc: true,
          initialOn: options.ucpd.cc2Source === true,
        },
      },
      { id: 'volt_cc1', type: 'volt_cc1' },
      { id: 'volt_cc2', type: 'volt_cc2' },
    );
    nets.push(
      {
        id: 'cc1_5v',
        pins: [{ instance: 'cc1_source', pin: 'vcc' }],
        voltage: 5,
      },
      {
        id: 'cc2_5v',
        pins: [{ instance: 'cc2_source', pin: 'vcc' }],
        voltage: 5,
      },
      {
        id: 'fixture_gnd',
        pins: [
          { instance: 'cc1_source', pin: 'gnd' },
          { instance: 'cc1_load', pin: 'gnd' },
          { instance: 'cc2_source', pin: 'gnd' },
        ],
        voltage: 0,
      },
      {
        id: 'cc1',
        pins: [
          { instance: 'mcu', pin: 'PB6' },
          { instance: 'cc1_source', pin: 'y' },
          { instance: 'cc1_load', pin: 'y' },
          { instance: 'volt_cc1', pin: 'p' },
        ],
      },
      {
        id: 'cc2',
        pins: [
          { instance: 'mcu', pin: 'PB4' },
          { instance: 'cc2_source', pin: 'y' },
          { instance: 'volt_cc2', pin: 'p' },
        ],
      },
    );
  }

  const board = createBoard(createDeviceLibrary(entries as never), {
    instances: instances as never,
    nets: nets as never,
  });
  const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;
  const memories = new Map<string, Uint8Array>();

  try {
    board.runUntil(0);
    board.runUntil(options.durationPs ?? 10_000_000_000);
  } catch (cause) {
    board.dispose();
    throw cause;
  }

  for (const [name, bytes] of instance.memories) memories.set(name, bytes);

  const memory = (name: string): Uint8Array => {
    const bytes = memories.get(name);

    if (bytes === undefined) throw new Error(`mcu-harness: unknown memory ${name}`);

    return bytes;
  };

  return {
    board,
    memory,
    u32: (offset) =>
      new DataView(memory('sram').buffer, memory('sram').byteOffset).getUint32(offset, true),
    state: (name) => instance.states.get(name),
    time: () => board.time,
    run: (durationPs) => board.runUntil(board.time + durationPs),
    faults,
    voltageHistory: (pin) => voltageHistory.get(pin) ?? [],
    dispose: () => board.dispose(),
  };
}
