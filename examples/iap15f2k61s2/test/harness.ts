import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, types, validateDeviceIR } from '@mica-js/sdk/model';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * 板级测试夹具：把 `dist/` 里的器件实现装进真实的 `@mica-js/simulator` 板，
 * 用最小的「探针」「上拉」器件把引脚电平和端口消息读回来。器件实现本身不被 mock。
 */

export interface Message {
  readonly time: number;
  readonly value: unknown;
}

export interface DeviceContext {
  readonly props: Readonly<Record<string, unknown>>;
  readonly topics: {
    publish(topic: string, payload: unknown): void;
    onDidReceive(listener: (message: { topic: string; payload: unknown }) => void): {
      dispose(): void;
    };
  };
  readonly attachJit: (options: unknown) => { dispose(): void };
  readonly loadBytes: (memory: string, bytes: Uint8Array, offset?: number) => void;
}

export interface DeviceAdapter {
  sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }): void;
  dispose(): void;
}

export interface DeviceModule {
  readonly model: DeviceIR;
  readonly create: (context: DeviceContext) => DeviceAdapter;
}

const PACKAGE_DIR = join(import.meta.dirname, '..');

/** 同级的理想 LED 器件包：闪烁用例把真实的 LED 接到 P1.1 上。 */
export const SIBLING_DEVICES = join(PACKAGE_DIR, '..', 'ideal-led');

const cache = new Map<string, Promise<DeviceModule>>();

/** 加载 `dist/devices/<id>/device.js`：测试针对交付产物，而不是另一份源码副本。 */
export function loadDevice(deviceId: string, packageDir = PACKAGE_DIR): Promise<DeviceModule> {
  const key = `${packageDir}\0${deviceId}`;
  const cached = cache.get(key);

  if (cached !== undefined) return cached;

  const loaded = import(
    pathToFileURL(join(packageDir, 'dist', 'devices', deviceId, 'device.js')).href
  ) as Promise<DeviceModule>;

  cache.set(key, loaded);

  return loaded;
}

/** 读取产物里的元数据，用于校验端口/引脚声明。 */
export function readMetadata(deviceId: string): {
  readonly kind: string;
  readonly ports?: Readonly<Record<string, { readonly direction: string; readonly type: string }>>;
  readonly pins?: Readonly<Record<string, unknown>>;
} {
  return JSON.parse(
    readFileSync(join(PACKAGE_DIR, 'dist', 'devices', deviceId, 'device.json'), 'utf8'),
  );
}

/** 探针：把 `Y` 的电平按 50 µs 周期摊成 0/1 输出消息，队列满时保留最新一条。 */
function probeModel(name: string): DeviceIR {
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
      loop.wait(50_000_000);

      const level = loop.field(loop.readSample('Y'), 'level');
      const high = loop.equal(
        types.logic,
        level,
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

/** 上拉：`B` 经指定电阻接到 `A`，测试把 `A` 接到 5 V 参考网络。 */
function pullUpModel(resistance: number): DeviceIR {
  const builder = createDeviceBuilder({ name: `PullUp${resistance}` });

  builder.pin({ name: 'A', initial: (body) => body.returnValue(body.combineIntents()) });
  builder.pin({
    name: 'B',
    initial: (body) =>
      body.returnValue(body.resistor('A', body.constant(types.number, resistance))),
  });

  return validateDeviceIR(builder.finish());
}

const probeModels = new Map<string, DeviceIR>();
const pullUpModels = new Map<number, DeviceIR>();

function probe(slot: string): DeviceIR {
  const cached = probeModels.get(slot);

  if (cached !== undefined) return cached;

  const model = probeModel(`Probe${slot}`);
  probeModels.set(slot, model);

  return model;
}

function pullUp(resistance: number): DeviceIR {
  const cached = pullUpModels.get(resistance);

  if (cached !== undefined) return cached;

  const model = pullUpModel(resistance);
  pullUpModels.set(resistance, model);

  return model;
}

export interface HarnessOptions {
  /** `P1_1` 上的上拉电阻，用于区分「释放」与「驱动低」。 */
  readonly pullUpOhm?: number;
  /** 是否把理想 LED 接在 `P1_1` 与地之间。 */
  readonly led?: boolean;
  /** 是否额外观察 `P3`（结果与 PSW 一起读回时才需要）。 */
  readonly observeP3?: boolean;
}

export interface HarnessResult {
  /** `P2` 的八个探针读数。 */
  readonly p2: number;
  /** `P3` 的八个探针读数（未观察时为 0）。 */
  readonly p3: number;
  /** `P1_1` 的探针读数（未接线时为 -1）。 */
  readonly signal: number;
  /** LED 端口最后一次发布的亮度。 */
  readonly brightness: number | undefined;
  readonly faults: readonly string[];
  /** 诊断：JIT 是否走直接路径、缓存块数与直接程序数。 */
  readonly jit: {
    readonly direct: boolean;
    readonly cache: number;
    readonly programs: number;
    /** 已翻译的 PC 及其 `polling` 标记。 */
    readonly blocks: readonly { readonly pc: number; readonly polling: boolean }[];
  };
  /** 板级搭建 + 预热（含首次翻译）的墙钟时间。 */
  readonly coldMs: number;
  /** 推进 `milliseconds` 的墙钟时间（不含预热）；未推进时为 0。 */
  readonly wallMs: number;
}

interface Fixture {
  readonly library: ReturnType<typeof createDeviceLibrary>;
  readonly instances: readonly { readonly id: string; readonly type: string }[];
  readonly nets: readonly {
    readonly id: string;
    readonly pins: readonly { readonly instance: string; readonly pin: string }[];
    readonly voltage?: number;
  }[];
  readonly levels: readonly number[][];
  readonly brightness: number[];
}

interface Pin {
  readonly instance: string;
  readonly pin: string;
}

interface Net {
  readonly id: string;
  readonly pins: readonly Pin[];
  readonly voltage?: number;
}

async function createFixture(options: HarnessOptions): Promise<Fixture> {
  const mcu = await loadDevice('iap15f2k61s2');
  const levels = Array.from({ length: 17 }, () => [] as number[]);
  const brightness: number[] = [];

  const entries: {
    id: string;
    model: DeviceIR;
    create: (context: DeviceContext) => DeviceAdapter;
  }[] = [{ id: 'mcu', model: mcu.model, create: mcu.create }];
  const instances: { id: string; type: string }[] = [{ id: 'mcu', type: 'mcu' }];

  const addProbe = (slot: string): void => {
    entries.push({
      id: `probe${slot}`,
      model: probe(slot),
      create: () => ({
        sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }) {
          const messages = batch.outputs.level ?? [];
          const latest = messages[messages.length - 1];

          if (latest !== undefined) {
            const index = slotIndex(slot);
            levels[index]?.push(latest.value as number);
          }
        },
        dispose() {},
      }),
    });
    instances.push({ id: `probe${slot}`, type: `probe${slot}` });
  };

  const nets: Net[] = [
    { id: 'vcc', pins: [{ instance: 'mcu', pin: 'VCC' }], voltage: 5 },
    { id: 'gnd', pins: [{ instance: 'mcu', pin: 'GND' }], voltage: 0 },
  ];

  const ports: { readonly port: number; readonly prefix: string; readonly observe: boolean }[] = [
    { port: 2, prefix: '2', observe: true },
    { port: 3, prefix: '3', observe: options.observeP3 === true },
  ];

  for (const { port, prefix, observe } of ports) {
    if (!observe) continue;

    for (let bit = 0; bit < 8; bit += 1) {
      const slot = `${prefix}${bit}`;
      addProbe(slot);
      nets.push({
        id: `p${port}_${bit}`,
        pins: [
          { instance: 'mcu', pin: `P${port}_${bit}` },
          { instance: `probe${slot}`, pin: 'Y' },
        ],
      });
    }
  }

  const signalPins: Pin[] = [{ instance: 'mcu', pin: 'P1_1' }];

  if (options.pullUpOhm !== undefined) {
    entries.push({
      id: 'pullup',
      model: pullUp(options.pullUpOhm),
      create: () => ({ sync() {}, dispose() {} }),
    });
    instances.push({ id: 'pullup', type: 'pullup' });
    nets.push({ id: 'pullup_vcc', pins: [{ instance: 'pullup', pin: 'A' }], voltage: 5 });
    signalPins.push({ instance: 'pullup', pin: 'B' });
    addProbe('signal');
    signalPins.push({ instance: 'probesignal', pin: 'Y' });
  }

  if (options.led === true) {
    const led = await loadDevice('ideal-led', SIBLING_DEVICES);

    entries.push({
      id: 'led',
      model: led.model,
      create: (context) =>
        led.create({
          ...context,
          topics: {
            onDidReceive: context.topics.onDidReceive,
            publish(topic: string, payload: unknown) {
              if (topic === 'brightness' && typeof payload === 'number') brightness.push(payload);

              context.topics.publish(topic, payload);
            },
          },
        }),
    });
    instances.push({ id: 'led', type: 'led' });
    signalPins.push({ instance: 'led', pin: 'anode' });
    nets.push({ id: 'led_cathode', pins: [{ instance: 'led', pin: 'cathode' }], voltage: 0 });
  }

  nets.push({ id: 'signal', pins: signalPins });

  return { library: createDeviceLibrary(entries), instances, nets, levels, brightness };
}

/** 探针槽位：`20`…`27` 是 P2，`30`…`37` 是 P3，`signal` 是 P1_1。 */
function slotIndex(slot: string): number {
  if (slot === 'signal') return 16;

  return (Number(slot[0]) - 2) * 8 + Number(slot[1]);
}

export interface RunOptions extends HarnessOptions {
  /** 固件映像；省略表示不装载固件（空固件空转）。 */
  readonly firmware?: Uint8Array;
  /** 推进的毫秒数（可以是小数），默认 1 ms。 */
  readonly milliseconds?: number;
  /** 计时前先空跑的毫秒数：把首次翻译与直接后端编译排除在基准之外。 */
  readonly warmUpMilliseconds?: number;
  /** 系统时钟频率（Hz），默认 1 MHz：测试固件只有十几条指令，低频可压低仿真开销。 */
  readonly clockFrequency?: number;
  /** 每次推进后记录 LED 亮度与时刻。 */
  readonly trace?: readonly { readonly time: number; readonly brightness: number }[];
}

/** 跑一段固件并读回引脚与端口。 */
export async function run(options: RunOptions = {}): Promise<HarnessResult> {
  const constructed = performance.now();
  const fixture = await createFixture(options);
  const milliseconds = options.milliseconds ?? 1;
  const props: Record<string, number | string | boolean | null | Uint8Array> = {
    clockFrequency: options.clockFrequency ?? 1_000_000,
    ...(options.firmware === undefined ? {} : { firmware: options.firmware }),
  };

  const faults: string[] = [];
  const board = createBoard(
    fixture.library,
    {
      instances: fixture.instances.map((instance) =>
        instance.id === 'mcu' ? { ...instance, props } : instance,
      ),
      nets: fixture.nets,
      // 1 µs 的 CPU 量子：端口写入后一次求解即可被随后的读口看见，测试断言不依赖调度合并。
    },
    { cpuQuantum: 1_000_000 },
  );
  const subscription = board.onDidError((event) => faults.push(event.message));

  try {
    if ((options.warmUpMilliseconds ?? 0) > 0)
      board.runUntil(board.time + Math.round((options.warmUpMilliseconds as number) * 1e9));

    const coldMs = performance.now() - constructed;
    const started = performance.now();
    const whole = Math.floor(milliseconds);

    for (let step = 0; step < whole; step += 1) {
      board.runUntil(board.time + 1_000_000_000);

      if (options.trace !== undefined) {
        (options.trace as { time: number; brightness: number }[]).push({
          time: board.time,
          brightness: fixture.brightness[fixture.brightness.length - 1] ?? 0,
        });
      }
    }

    const remainder = Math.round((milliseconds - whole) * 1_000_000_000);

    if (remainder > 0) board.runUntil(board.time + remainder);

    const wallMs = performance.now() - started;
    const jit = (board as unknown as { jits?: readonly unknown[] }).jits?.[0] as
      | { direct?: unknown; cache?: Map<number, unknown>; directPrograms?: Map<string, unknown> }
      | undefined;
    const cache = jit?.cache;
    const blocks: { pc: number; polling: boolean }[] = [];

    if (cache !== undefined)
      for (const [pc, entry] of cache)
        blocks.push({ pc, polling: (entry as { polling?: boolean }).polling === true });

    blocks.sort((left, right) => left.pc - right.pc);

    return {
      p2: readBits(fixture.levels, 0),
      p3: readBits(fixture.levels, 8),
      signal: latest(fixture.levels[16]),
      brightness: fixture.brightness[fixture.brightness.length - 1],
      faults,
      jit: {
        direct: jit?.direct !== undefined,
        cache: jit?.cache?.size ?? 0,
        programs: jit?.directPrograms?.size ?? 0,
        blocks,
      },
      coldMs,
      wallMs,
    };
  } finally {
    subscription.dispose();
    board.dispose();
  }
}

function readBits(levels: readonly number[][], offset: number): number {
  let value = 0;

  for (let bit = 0; bit < 8; bit += 1) if (latest(levels[offset + bit]) === 1) value |= 1 << bit;

  return value;
}

function latest(values: readonly number[] | undefined): number {
  return values === undefined || values.length === 0 ? -1 : (values[values.length - 1] as number);
}

/** 常用固件片段：把 P2、P3 切成推挽输出。 */
export const PUSH_PULL_OUTPUTS = [
  0x75,
  0x96,
  0xff, // MOV P2M0,#0FFH
  0x75,
  0x95,
  0x00, // MOV P2M1,#00H
  0x75,
  0xb2,
  0xff, // MOV P3M0,#0FFH
  0x75,
  0xb1,
  0x00, // MOV P3M1,#00H
];

/** 只把 P2 切成推挽输出（大多数用例只观察 P2）。 */
export const PUSH_PULL_P2 = [
  0x75,
  0x96,
  0xff, // MOV P2M0,#0FFH
  0x75,
  0x95,
  0x00, // MOV P2M1,#00H
];

/** `MOV P2,A` 与 `MOV P3,PSW`：把结果送到两个探针口。 */
export const DUMP_RESULT = [
  0xf5,
  0xa0, // MOV P2,A
  0x85,
  0xd0,
  0xb0, // MOV P3,PSW
  0x80,
  0xfe, // SJMP $
];
