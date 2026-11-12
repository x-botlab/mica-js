import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { createDeviceBuilder, types, validateDeviceIR } from '@mica-js/sdk/model';
import type { DeviceIR } from '@mica-js/sdk/model';
import create from '../src/devices/iap15f2k61s2/index.ts';

/**
 * 源码级板级夹具：用 `compileDDL` 现场编译 `model.ddl`，直接装载 `src/` 里的适配器。
 *
 * 与 `harness.ts` 的区别是不依赖 `mica build` 的产物，因此外设单元测试可以在一次构建之前
 * 独立运行。集成测试仍然使用 `harness.ts`，保证交付产物本身也被验证。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..');
const MODEL_PATH = join(PACKAGE_DIR, 'src', 'devices', 'iap15f2k61s2', 'model.ddl');

let cached: Promise<DeviceIR> | undefined;

export function sourceModel(): Promise<DeviceIR> {
  cached ??= compileDDL(readFileSync(MODEL_PATH, 'utf8'));

  return cached;
}

interface Message {
  readonly value: unknown;
}

type Adapter = {
  sync(batch: { outputs: Record<string, readonly Message[]> }): void;
  dispose(): void;
};

function probeModel(name: string, periodPs: number): DeviceIR {
  const builder = createDeviceBuilder({ name });

  builder.pin({ name: 'Y', low: 1.5, high: 3.5 });
  builder.channel({
    name: 'level',
    direction: 'output',
    type: types.number,
    capacity: 1,
    overflow: types.overflow.members.drop_oldest,
  });
  builder.start((body) => {
    body.loop((loop) => {
      loop.wait(periodPs);

      const high = loop.equal(
        types.logic,
        loop.field(loop.readSample('Y'), 'level'),
        loop.constant(types.logic, types.logic.members.high),
      );

      loop.send(
        'level',
        loop.select(
          types.number,
          high,
          (inner) => inner.constant(types.number, 1),
          (inner) => inner.constant(types.number, 0),
        ),
      );
    });
  });

  return validateDeviceIR(builder.finish());
}

function driverModel(name: string): DeviceIR {
  const builder = createDeviceBuilder({ name });

  builder.pin({ name: 'Y', initial: (body) => body.returnValue(body.combineIntents()) });
  builder.pin({ name: 'supply' });
  builder.pin({ name: 'reference' });
  builder.channel({ name: 'level', direction: 'input', type: types.number, capacity: 4 });
  builder.start((body) => {
    body.loop((loop) => {
      const level = loop.receive('level', types.number);

      loop.if(
        loop.equal(types.number, level, loop.constant(types.number, 1)),
        (high) => high.writeIntent('Y', high.resistor('supply', high.constant(types.number, 25))),
        (low) => low.writeIntent('Y', low.resistor('reference', low.constant(types.number, 25))),
      );
    });
  });

  return validateDeviceIR(builder.finish());
}

function pullUpModel(name: string, resistance: number): DeviceIR {
  const builder = createDeviceBuilder({ name });

  builder.pin({ name: 'A', initial: (body) => body.returnValue(body.combineIntents()) });
  builder.pin({
    name: 'B',
    initial: (body) =>
      body.returnValue(body.resistor('A', body.constant(types.number, resistance))),
  });

  return validateDeviceIR(builder.finish());
}

export interface SourceHarnessOptions {
  readonly firmware?: Uint8Array;
  readonly clockFrequency?: number;
  /** 需要采样的引脚，例如 `['P2_0', 'P3_1']`。 */
  readonly observe?: readonly string[];
  /** 需要外部驱动的引脚；测试用 `drive()` 改变电平。 */
  readonly drive?: readonly string[];
  /** 给这些引脚加对地（5 V 参考）上拉电阻。 */
  readonly pullUp?: Readonly<Record<string, number>>;
  readonly samplePeriodPs?: number;
  readonly cpuQuantum?: number;
}

export interface SourceHarness {
  readonly board: ReturnType<typeof createBoard>;
  readonly faults: readonly string[];
  /** 最近一次采样到的电平（0/1），没有采样时为 -1。 */
  level(pin: string): number;
  /** 把某个引脚的最近 8 个采样拼成一个字节（低电平 0）。 */
  port(port: number): number;
  drive(pin: string, level: 0 | 1): void;
  dispose(): void;
}

export async function createSourceHarness(
  options: SourceHarnessOptions = {},
): Promise<SourceHarness> {
  const model = await sourceModel();
  const observe = options.observe ?? [];
  const drive = options.drive ?? [];
  const pullUps = Object.entries(options.pullUp ?? {});
  const samplePeriod = options.samplePeriodPs ?? 100_000;
  const levels = new Map<string, number[]>();
  const drivers = new Map<string, { send(value: number): void }>();
  const entries: { id: string; model: DeviceIR; create: (context: never) => Adapter }[] = [
    {
      id: 'mcu',
      model,
      create: (context: never) => create(context) as unknown as Adapter,
    },
  ];
  interface Instance {
    id: string;
    type: string;
    props?: Readonly<Record<string, number | boolean | string | null | Uint8Array>>;
  }
  const instances: Instance[] = [{ id: 'mcu', type: 'mcu' }];
  interface Net {
    id: string;
    pins: { instance: string; pin: string }[];
    voltage?: number;
  }
  const nets: Net[] = [
    { id: 'vcc', pins: [{ instance: 'mcu', pin: 'VCC' }], voltage: 5 },
    { id: 'gnd', pins: [{ instance: 'mcu', pin: 'GND' }], voltage: 0 },
  ];
  const pinNets = new Map<string, Net>();

  const slot = (pin: string): string => pin.replace('_', '');
  const pinNet = (pin: string): Net => {
    const existing = pinNets.get(pin);

    if (existing !== undefined) return existing;

    const net: Net = { id: `net${slot(pin)}`, pins: [{ instance: 'mcu', pin }] };

    pinNets.set(pin, net);
    nets.push(net);

    return net;
  };

  const netsAfterPins = nets;

  for (const pin of observe) {
    const id = `probe${slot(pin)}`;

    levels.set(pin, []);
    entries.push({
      id,
      model: probeModel(`Probe${slot(pin)}`, samplePeriod),
      create: () => ({
        sync(batch) {
          const messages = batch.outputs.level ?? [];
          const latest = messages[messages.length - 1];

          if (latest !== undefined) levels.get(pin)?.push(latest.value as number);
        },
        dispose() {},
      }),
    });
    instances.push({ id, type: id });
    pinNet(pin).pins.push({ instance: id, pin: 'Y' });
  }

  for (const pin of drive) {
    const id = `driver${slot(pin)}`;

    entries.push({
      id,
      model: driverModel(`Driver${slot(pin)}`),
      create: (context) => {
        const typed = context as unknown as { inputs: { level: { send(value: number): void } } };

        drivers.set(pin, typed.inputs.level);

        return { sync() {}, dispose() {} };
      },
    });
    instances.push({ id, type: id });
    pinNet(pin).pins.push({ instance: id, pin: 'Y' });
    netsAfterPins.push({
      id: `supply${slot(pin)}`,
      pins: [{ instance: id, pin: 'supply' }],
      voltage: 5,
    });
    netsAfterPins.push({
      id: `reference${slot(pin)}`,
      pins: [{ instance: id, pin: 'reference' }],
      voltage: 0,
    });
  }

  for (const [pin, resistance] of pullUps) {
    const id = `pullup${slot(pin)}`;

    entries.push({
      id,
      model: pullUpModel(`PullUp${slot(pin)}`, resistance),
      create: () => ({ sync() {}, dispose() {} }),
    });
    instances.push({ id, type: id });
    pinNet(pin).pins.push({ instance: id, pin: 'B' });
    netsAfterPins.push({
      id: `pullref${slot(pin)}`,
      pins: [{ instance: id, pin: 'A' }],
      voltage: 5,
    });
  }

  const props: Record<string, number | boolean | string | null | Uint8Array> = {
    clockFrequency: options.clockFrequency ?? 1_000_000,
    ...(options.firmware === undefined ? {} : { firmware: options.firmware }),
  };
  const library = createDeviceLibrary(entries as never);
  const faults: string[] = [];
  const board = createBoard(
    library,
    {
      instances: instances.map((instance) =>
        instance.id === 'mcu' ? { ...instance, props } : instance,
      ),
      nets,
    },
    { cpuQuantum: options.cpuQuantum ?? 1_000_000 },
  );

  board.onDidError((event) => faults.push(event.message));

  const level = (pin: string): number => {
    const values = levels.get(pin);

    return values === undefined || values.length === 0 ? -1 : (values[values.length - 1] as number);
  };
  const port = (index: number): number => {
    let value = 0;

    for (let bit = 0; bit < 8; bit += 1) if (level(`P${index}_${bit}`) === 1) value |= 1 << bit;

    return value;
  };

  return {
    board,
    faults,
    level,
    port,
    drive(pin, value) {
      const input = drivers.get(pin);

      if (input === undefined) throw new Error(`pin ${pin} is not driven by the harness`);

      input.send(value);
    },
    dispose() {
      board.dispose();
    },
  };
}

/** 跑一段固件并把观察到的端口读回来。 */
export async function runSource(
  options: SourceHarnessOptions & {
    readonly milliseconds?: number;
    readonly observePorts?: readonly number[];
    readonly record?: { readonly time: number; readonly port: number }[];
  } = {},
): Promise<{
  ports: Record<number, number>;
  faults: readonly string[];
  time: number;
  levels: Record<string, number>;
}> {
  const ports = options.observePorts ?? [2];
  const observe =
    options.observe ??
    ports.flatMap((port) => Array.from({ length: 8 }, (_, bit) => `P${port}_${bit}`));
  const harness: SourceHarness = await createSourceHarness({ ...options, observe });
  const milliseconds = options.milliseconds ?? 1;

  try {
    for (let step = 0; step < milliseconds; step += 1) {
      harness.board.runUntil(harness.board.time + 1_000_000_000);
      options.record?.push({ time: harness.board.time, port: harness.port(ports[0] ?? 2) });
    }

    const values: Record<number, number> = {};

    for (const port of ports) values[port] = harness.port(port);

    const pinLevels: Record<string, number> = {};

    for (const pin of observe) pinLevels[pin] = harness.level(pin);

    return { ports: values, faults: harness.faults, time: harness.board.time, levels: pinLevels };
  } finally {
    harness.dispose();
  }
}
