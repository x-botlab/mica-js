import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '../../devices/test/support/legacy-model-bridge.mjs';
import type { DeviceIR } from '@mica-js/sdk/model';
import { loadFirmware } from './firmware';
import { createHarness } from './harness';

/**
 * CT117E-M4 §4：U7/U8 XL555 输出反馈型无稳态。
 *
 * 只装载构建产物 `dist/model.js`。真实 Thumb/MMIO 夹具配置 GPIO 复用、TIM2/TIM3
 * 输入捕获、NVIC 与 WFI；测试从 SRAM 结果槽、夹具 FIFO/状态和公共事件断言，不直接
 * 改写融合模型的定时器状态。
 *
 * 555 片段合同：
 * - id=1 U7/R39/PB4(TIM3_CH1)，id=2 U8/R40/PA15(TIM2_CH1)。
 * - t_half = ln2 × (100 Ω + position × 10 kΩ) × 100 nF，输出推挽、约 50 % 占空比。
 * - 改 position 不取消已挂起的 `ticks`；当前边沿仍按旧 deadline，随后从该边沿按新
 *   position 重新锚定绝对相位。因此频率切换最多延迟一个旧半周期。
 * - FIFO 满沿用 standalone 合同：captureOverflow=1、fault(0xffffffff)、halted=true。
 * - `timerEdge` 仅用于观测；同一 sync 批次超过容量时只丢最老观测事件。
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

export interface TimerHarness {
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
    readonly name: 'timer.edge' | 'timer.potentiometer' | 'fault';
    readonly time: number;
    readonly value: unknown;
  }[];
  readonly errors: readonly string[];
  run(spanPs: number): void;
  runTo(targetPs: number): void;
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

export async function createTimerHarness(firmware: Uint8Array): Promise<TimerHarness> {
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
        onDidTimerEdge: 'timer.edge',
        onDidTimerPotentiometer: 'timer.potentiometer',
      },
    });
    const adapter = adapted(context);
    methods = adapter.methods as Readonly<Record<string, (params: unknown) => unknown>>;

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
        { id: 'vdd', voltage: 3.3, pins: [{ instance: 'ct117e-m4', pin: 'VDD1' }] },
        { id: 'vss', voltage: 0, pins: [{ instance: 'ct117e-m4', pin: 'VSS1' }] },
      ],
    } as never,
    { execution: 'precise' },
  );

  const instance = findInstance((board as unknown as { instances?: unknown }).instances);
  if (instance === undefined) {
    board.dispose();
    throw new Error('ct117e-m4 board did not expose its single instance');
  }

  const events: {
    name: 'timer.edge' | 'timer.potentiometer' | 'fault';
    time: number;
    value: unknown;
  }[] = [];
  const errors: string[] = [];
  const subscription = board.topics.onDidReceive((message) => {
    if (
      message.topic === 'timer.edge' ||
      message.topic === 'timer.potentiometer' ||
      message.topic === 'fault'
    )
      events.push({ name: message.topic, time: board.time, value: message.payload });
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
    runTo(targetPs) {
      board.runUntil(targetPs);
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

/* ---------------------------------------------------------------------------------------
 * 真实 Thumb 夹具
 * ------------------------------------------------------------------------------------- */

const GPIOA = 0x4800_0000;
const GPIOB = 0x4800_0400;
const RCC_AHB2ENR = 0x4002_104c;
const RCC_APB1ENR1 = 0x4002_1058;
const TIM2 = 0x4000_0000;
const TIM3 = 0x4000_0400;
const NVIC_ISER0 = 0xe000_e100;
const RESULT_BASE = 0x2000_1000;
const CODE_BASE = 0x200;

const CR1 = 0x00;
const DIER = 0x0c;
const SR = 0x10;
const CCMR1 = 0x18;
const CCER = 0x20;
const PSC = 0x28;
const ARR = 0x2c;
const CCR1 = 0x34;

type PinName = 'PA15' | 'PB4';

interface CapturePin {
  readonly pin: PinName;
  readonly timer: number;
  readonly timerBit: number;
  readonly gpioBase: number;
  readonly gpioClockBit: number;
  readonly moderShift: number;
  readonly afrOffset: number;
  readonly afrShift: number;
  readonly correctAf: number;
}

const PINS: Record<PinName, CapturePin> = {
  PA15: {
    pin: 'PA15',
    timer: TIM2,
    timerBit: 1 << 0,
    gpioBase: GPIOA,
    gpioClockBit: 1 << 0,
    moderShift: 30,
    afrOffset: 0x24,
    afrShift: 28,
    correctAf: 1,
  },
  PB4: {
    pin: 'PB4',
    timer: TIM3,
    timerBit: 1 << 1,
    gpioBase: GPIOB,
    gpioClockBit: 1 << 1,
    moderShift: 8,
    afrOffset: 0x20,
    afrShift: 16,
    correctAf: 2,
  },
};

/** 带 IRQ 向量的最小 Thumb-1/Thumb-2 汇编器；代码从镜像偏移 0x200 开始。 */
class Thumb {
  readonly #halves: number[] = [];
  readonly #labels = new Map<string, number>();
  readonly #patches: { at: number; label: string; condition: number }[] = [];

  #half(value: number): this {
    this.#halves.push(value & 0xffff);
    return this;
  }

  #dword(first: number, second: number): this {
    return this.#half(first).#half(second);
  }

  label(name: string): this {
    this.#labels.set(name, this.#halves.length * 2);
    return this;
  }

  movw(rd: number, immediate: number): this {
    const value = immediate & 0xffff;
    return this.#dword(
      0xf240 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  movt(rd: number, immediate: number): this {
    const value = immediate & 0xffff;
    return this.#dword(
      0xf2c0 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  movs(rd: number, immediate: number): this {
    if (!Number.isInteger(immediate) || immediate < 0 || immediate > 0xff)
      throw new RangeError(`movs immediate out of range: ${immediate}`);
    return this.#half(0x2000 | (rd << 8) | immediate);
  }

  adds(rd: number, immediate: number): this {
    if (!Number.isInteger(immediate) || immediate < 0 || immediate > 0xff)
      throw new RangeError(`adds immediate out of range: ${immediate}`);
    return this.#half(0x3000 | (rd << 8) | immediate);
  }

  ands(rd: number, rm: number): this {
    return this.#half(0x4000 | (rm << 3) | rd);
  }

  cmp(rd: number, immediate: number): this {
    if (!Number.isInteger(immediate) || immediate < 0 || immediate > 0xff)
      throw new RangeError(`cmp immediate out of range: ${immediate}`);
    return this.#half(0x2800 | (rd << 8) | immediate);
  }

  strWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8c0 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8d0 | rn, (rt << 12) | (offset & 0xfff));
  }

  b(condition: number, label: string): this {
    this.#patches.push({ at: this.#halves.length, label, condition });
    return this.#half(0xd000 | ((condition & 0xf) << 8));
  }

  bx(lr: boolean): this {
    return this.#half(lr ? 0x4770 : 0x4700);
  }

  wfi(): this {
    return this.#half(0xbf30);
  }

  spin(): this {
    return this.#half(0xe7fe);
  }

  build(vectors: readonly { readonly irq: number; readonly label: string }[] = []): Uint8Array {
    for (const patch of this.#patches) {
      const target = this.#labels.get(patch.label);
      if (target === undefined) throw new Error(`Missing label ${patch.label}`);
      const half = (target - (patch.at * 2 + 4)) / 2;
      if (!Number.isInteger(half) || half < -128 || half > 127)
        throw new Error(`Branch to ${patch.label} out of range`);
      this.#halves[patch.at] = 0xd000 | ((patch.condition & 0xf) << 8) | (half & 0xff);
    }

    const code = new Uint8Array(this.#halves.length * 2);
    const codeView = new DataView(code.buffer);
    this.#halves.forEach((value, index) => codeView.setUint16(index * 2, value, true));

    const image = new Uint8Array(CODE_BASE + code.length);
    const view = new DataView(image.buffer);
    view.setUint32(0, 0x2000_5000, true);
    view.setUint32(4, FLASH_BASE + CODE_BASE + 1, true);
    for (const vector of vectors) {
      const label = this.#labels.get(vector.label);
      if (label === undefined) throw new Error(`Missing vector label ${vector.label}`);
      view.setUint32((16 + vector.irq) * 4, FLASH_BASE + CODE_BASE + label + 1, true);
    }
    image.set(code, CODE_BASE);
    return image;
  }
}

interface ProgramOptions {
  readonly pins: readonly PinName[];
  readonly mode: 'spin' | 'wfi';
  readonly af?: Partial<Record<PinName, number>>;
  readonly gpioClock?: boolean;
  readonly timerClock?: boolean;
  readonly cen?: boolean;
  readonly cc1s?: boolean;
  readonly cc1e?: boolean;
  readonly bothEdges?: boolean;
  readonly irqCount?: number;
}

/** 只通过 MMIO 配置 GPIO/TIM/NVIC 的真实固件。 */
class TimerProgram {
  readonly #code = new Thumb();
  readonly #options: ProgramOptions;

  constructor(options: ProgramOptions) {
    this.#options = options;
    this.#configure();
    if (options.mode === 'wfi') this.#wfi();
    else this.#code.spin();
  }

  #writeWord(address: number, value: number): void {
    const word = value >>> 0;
    this.#code.movw(0, address & 0xffff).movt(0, address >>> 16);
    if (word <= 0xff) this.#code.movs(1, word);
    else this.#code.movw(1, word & 0xffff).movt(1, word >>> 16);
    this.#code.strWord(1, 0, 0);
  }

  #configure(): void {
    const options = this.#options;
    let gpioClock = 0;
    let timerClock = 0;

    for (const name of options.pins) {
      const pin = PINS[name];
      if (options.gpioClock !== false) gpioClock |= pin.gpioClockBit;
      if (options.timerClock !== false) timerClock |= pin.timerBit;
    }
    if (options.gpioClock !== false) this.#writeWord(RCC_AHB2ENR, gpioClock);
    if (options.timerClock !== false) this.#writeWord(RCC_APB1ENR1, timerClock);

    for (const group of [GPIOA, GPIOB]) {
      const pins = options.pins.map((name) => PINS[name]).filter((pin) => pin.gpioBase === group);
      if (pins.length === 0) continue;

      let moder = 0;
      let afr0 = 0;
      let afr1 = 0;
      for (const pin of pins) {
        moder = (moder | ((2 << pin.moderShift) >>> 0)) >>> 0;
        const af = options.af?.[pin.pin] ?? pin.correctAf;
        if (pin.afrOffset === 0x20) afr0 = (afr0 | ((af << pin.afrShift) >>> 0)) >>> 0;
        else afr1 = (afr1 | ((af << pin.afrShift) >>> 0)) >>> 0;
      }
      this.#writeWord(group, moder);
      if (afr0 !== 0) this.#writeWord(group + 0x20, afr0);
      if (afr1 !== 0) this.#writeWord(group + 0x24, afr1);
    }

    for (const name of options.pins) {
      const pin = PINS[name];
      const ccmr = options.cc1s === false ? 0 : 1;
      let ccer = options.cc1e === false ? 0 : 1;
      if (options.bothEdges) ccer |= (1 << 1) | (1 << 3);
      if (options.mode === 'wfi') ccer |= 1;
      this.#code.movw(0, pin.timer & 0xffff).movt(0, pin.timer >>> 16);
      this.#code.movw(1, 0xffff).movt(1, 0xffff).strWord(1, 0, ARR);
      this.#code.movs(1, 0).strWord(1, 0, PSC);
      this.#code.movs(1, ccmr).strWord(1, 0, CCMR1);
      this.#code.movs(1, ccer).strWord(1, 0, CCER);
      this.#code.movs(1, options.mode === 'wfi' ? 2 : 0).strWord(1, 0, DIER);
      this.#code.movs(1, options.cen === false ? 0 : 1).strWord(1, 0, CR1);
    }
  }

  #wfi(): void {
    if (this.#options.pins.length !== 1) throw new Error('wfi mode needs exactly one pin');
    const pin = PINS[this.#options.pins[0]!];
    const count = this.#options.irqCount ?? 3;
    this.#code.movw(6, RESULT_BASE & 0xffff).movt(6, RESULT_BASE >>> 16);
    this.#code.movw(0, NVIC_ISER0 & 0xffff).movt(0, NVIC_ISER0 >>> 16);
    this.#code
      .movw(1, 0)
      .movt(1, pin.timer === TIM2 ? 0x1000 : 0x2000)
      .strWord(1, 0, 0);

    const loop = 'wait';
    this.#code.label(loop).wfi().ldrWord(0, 6, 0).cmp(0, count).b(3, loop).spin();

    // handler: 记录本次 CCR1，计数 +1；达到目标后关掉 CC1IE，避免后续边沿覆盖结果。
    this.#code.label('handler');
    this.#code.movw(0, pin.timer & 0xffff).movt(0, pin.timer >>> 16);
    this.#code.ldrWord(2, 0, CCR1).strWord(2, 6, 4);
    this.#code.ldrWord(1, 6, 0).adds(1, 1).strWord(1, 6, 0);
    this.#code.cmp(1, count).b(1, 'handled');
    this.#code.movs(1, 0).strWord(1, 0, DIER);
    this.#code.label('handled').bx(true);
  }

  build(): Uint8Array {
    return this.#code.build(this.#options.mode === 'wfi' ? [{ irq: 28, label: 'handler' }] : []);
  }
}

/* ---------------------------------------------------------------------------------------
 * 公式与断言辅助
 * ------------------------------------------------------------------------------------- */

const LN2 = 0.6931471805599453;
const BASE_R = 100;
const POT_R = 10_000;
const CAP = 100e-9;

const halfPeriodPs = (position: number): number => LN2 * (BASE_R + position * POT_R) * CAP * 1e12;
const frequencyHz = (position: number): number => 1e12 / (2 * halfPeriodPs(position));

interface Edge {
  readonly time: number;
  readonly level: boolean;
  readonly id: number;
}

function edges(harness: TimerHarness): Edge[] {
  return harness.events
    .filter((event) => event.name === 'timer.edge')
    .map((event) => event.value as Edge);
}

function potEvents(harness: TimerHarness): { id: number; position: number }[] {
  return harness.events
    .filter((event) => event.name === 'timer.potentiometer')
    .map((event) => event.value as { id: number; position: number });
}

function spinFirmware(): Uint8Array {
  return new TimerProgram({ pins: [], mode: 'spin' }).build();
}

async function setTimer(harness: TimerHarness, id: number, position: number): Promise<void> {
  harness.methods.setTimerPotentiometer!({ id, position });
  harness.run(0);
}

function fifoEntries(harness: TimerHarness, count: number) {
  const fifo = harness.memory('captureFifo');
  const view = new DataView(fifo.buffer, fifo.byteOffset, fifo.byteLength);
  return Array.from({ length: count }, (_, index) => {
    const at = index * 16;
    return {
      time: view.getUint32(at, true) + view.getUint32(at + 4, true) * 4_294_967_296,
      pinId: fifo[at + 8]!,
      level: fifo[at + 9]!,
    };
  });
}

function timerRegister(harness: TimerHarness, timer: number, offset: number): number {
  const tim = harness.memory('tim');
  const view = new DataView(tim.buffer, tim.byteOffset, tim.byteLength);
  return view.getUint32((timer === TIM2 ? 0x48 : 0x90) + offset, true);
}

/* ---------------------------------------------------------------------------------------
 * 用例
 * ------------------------------------------------------------------------------------- */

describe('CT117E-M4 板载 555 定时器', () => {
  it('dist 产物公开 set/get 方法与两个观测事件', async () => {
    const harness = await createTimerHarness(spinFirmware());
    try {
      for (const name of ['setTimerPotentiometer', 'getTimerPotentiometer', 'getTimerFrequency'])
        expect(typeof harness.methods[name], name).toBe('function');
      harness.run(0);
      expect(potEvents(harness)).toEqual([
        { id: 1, position: 0.5 },
        { id: 2, position: 0.5 },
      ]);
    } finally {
      harness.dispose();
    }
  });

  it('端点频率按 R=100..10100 Ω、C=100 nF 计算，重复位置不发事件', async () => {
    const harness = await createTimerHarness(spinFirmware());
    try {
      harness.run(0);
      const before = potEvents(harness).length;

      await setTimer(harness, 1, 0);
      expect(harness.methods.getTimerPotentiometer!({ id: 1 })).toBe(0);
      expect(harness.methods.getTimerFrequency!({ id: 1 })).toBeCloseTo(frequencyHz(0), 6);

      await setTimer(harness, 2, 1);
      expect(harness.methods.getTimerFrequency!({ id: 2 })).toBeCloseTo(frequencyHz(1), 6);

      const afterSet = potEvents(harness).length;
      await setTimer(harness, 1, 0);
      await setTimer(harness, 2, 1);
      expect(potEvents(harness)).toHaveLength(afterSet);
      expect(afterSet).toBe(before + 2);
      expect(harness.errors).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('相位按绝对目标取整：200 个半周期无累计误差，分段推进不改变边沿', async () => {
    const firmware = spinFirmware();
    const first = await createTimerHarness(firmware);
    const second = await createTimerHarness(firmware);
    try {
      for (const harness of [first, second]) {
        harness.run(0);
        await setTimer(harness, 1, 0);
        await setTimer(harness, 2, 0);
      }

      const end = 2_200_000_000;
      const chunks = [7_000_000, 13_000_000, 31_000_000, 47_000_000, 100_000_000];
      let at = 0;
      let chunk = 0;
      while (at < end) {
        const span = Math.min(chunks[chunk++ % chunks.length]!, end - at);
        first.run(span);
        at += span;
      }
      second.runTo(end);

      expect(edges(first)).toEqual(edges(second));

      const u7 = edges(first).filter((edge) => edge.id === 1);
      expect(u7.length).toBeGreaterThan(150);
      const transition = Math.round(halfPeriodPs(0.5));
      expect(u7[0]!.time).toBe(transition);
      for (let index = 1; index < u7.length; index += 1)
        expect(u7[index]!.time).toBe(Math.round(transition + index * halfPeriodPs(0)));

      const u8 = edges(first).filter((edge) => edge.id === 2);
      expect(u8[0]!.time).toBe(transition);
      for (let index = 1; index < u8.length; index += 1)
        expect(u8[index]!.time).toBe(Math.round(transition + index * halfPeriodPs(0)));
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('改电位器后：当前旧 deadline 保留，下一段从该边沿按新周期绝对定位', async () => {
    const harness = await createTimerHarness(spinFirmware());
    try {
      harness.run(0);
      await setTimer(harness, 1, 0);
      const changeAt = 700_000_000;
      harness.runTo(changeAt);
      const before = edges(harness).filter((edge) => edge.id === 1);
      expect(before.length).toBeGreaterThanOrEqual(50);

      const transition = Math.round(halfPeriodPs(0.5));
      const oldDeadline =
        transition + Math.ceil((changeAt - transition) / halfPeriodPs(0)) * halfPeriodPs(0);
      const nextOld = Math.round(oldDeadline);

      await setTimer(harness, 1, 1);
      expect(potEvents(harness).at(-1)).toEqual({ id: 1, position: 1 });
      harness.runTo(2_200_000_000);

      const after = edges(harness)
        .filter((edge) => edge.id === 1 && edge.time >= changeAt)
        .sort((left, right) => left.time - right.time);
      expect(after[0]!.time).toBe(nextOld);
      expect(after[1]!.time).toBe(Math.round(nextOld + halfPeriodPs(1)));
      expect(after[2]!.time).toBe(Math.round(nextOld + 2 * halfPeriodPs(1)));

      const potCount = potEvents(harness).length;
      await setTimer(harness, 1, 1);
      expect(potEvents(harness)).toHaveLength(potCount);
    } finally {
      harness.dispose();
    }
  });

  it('真实固件通过 PA15/TIM2_CH1 与 PB4/TIM3_CH1 捕获 IRQ 并记录 CCR，间隔符合半周期', async () => {
    for (const pin of ['PA15', 'PB4'] as const) {
      const id = pin === 'PA15' ? 2 : 1;
      const captureAt = async (target: number): Promise<number> => {
        const harness = await createTimerHarness(
          new TimerProgram({ pins: [pin], mode: 'wfi', irqCount: target }).build(),
        );
        try {
          harness.run(0);
          await setTimer(harness, id, 1);
          harness.run(5_000_000_000);
          const sram = new DataView(harness.memory('sram').buffer);
          expect(harness.errors, `${pin} errors`).toEqual([]);
          expect(
            harness.events.filter((event) => event.name === 'fault'),
            `${pin} fault`,
          ).toEqual([]);
          return sram.getUint32(RESULT_BASE - 0x2000_0000 + 4, true);
        } finally {
          harness.dispose();
        }
      };

      const first = await captureAt(1);
      const second = await captureAt(2);
      // 两个上升沿相差一个完整周期：2 × 700 078.652 ps / 12 500 ps ≈ 112 012.58 tick。
      expect(second - first, `${pin} CCR delta`).toBeGreaterThanOrEqual(112_012);
      expect(second - first, `${pin} CCR delta`).toBeLessThanOrEqual(112_013);
    }
  });

  it('错误 AF 与缺门控不捕获：真实固件初始化后 FIFO/SR 保持空', async () => {
    const cases: { readonly label: string; readonly firmware: Uint8Array }[] = [
      {
        label: 'PA15 AF2 不是 TIM2_CH1',
        firmware: new TimerProgram({ pins: ['PA15'], mode: 'spin', af: { PA15: 2 } }).build(),
      },
      {
        label: 'PB4 AF1 不是 TIM3_CH1',
        firmware: new TimerProgram({ pins: ['PB4'], mode: 'spin', af: { PB4: 1 } }).build(),
      },
      {
        label: 'CEN=0',
        firmware: new TimerProgram({ pins: ['PA15'], mode: 'spin', cen: false }).build(),
      },
      {
        label: 'CC1S=00',
        firmware: new TimerProgram({ pins: ['PA15'], mode: 'spin', cc1s: false }).build(),
      },
      {
        label: 'CC1E=0',
        firmware: new TimerProgram({ pins: ['PB4'], mode: 'spin', cc1e: false }).build(),
      },
    ];

    for (const item of cases) {
      const harness = await createTimerHarness(item.firmware);
      try {
        harness.run(2_000_000_000);
        expect(harness.state('captureTail'), item.label).toBe(0);
        expect(harness.state('captureHead'), item.label).toBe(0);
        expect(
          timerRegister(harness, TIM2, SR) & 2 || timerRegister(harness, TIM3, SR) & 2,
          item.label,
        ).toBe(0);
        // 振荡器本身仍在运行，证明不是把 555 停掉来通过。
        expect(edges(harness).length, item.label).toBeGreaterThan(0);
        expect(harness.errors).toEqual([]);
      } finally {
        harness.dispose();
      }
    }
  });

  it('真实边沿按精确 now 写入 16 B FIFO，两路同刻顺序稳定', async () => {
    const harness = await createTimerHarness(
      new TimerProgram({
        pins: ['PA15', 'PB4'],
        mode: 'spin',
        bothEdges: true,
      }).build(),
    );
    try {
      harness.run(0);
      await setTimer(harness, 1, 0);
      await setTimer(harness, 2, 0);
      harness.run(450_000_000);

      const count = harness.state('captureTail') as number;
      expect(count).toBeGreaterThanOrEqual(6);
      const entries = fifoEntries(harness, Math.min(count, 6));
      expect(entries[0]!.pinId).toBe(1); // U7/PB4 进程先于 U8/PA15
      expect(entries[1]!.pinId).toBe(0);
      expect(entries[0]!.time).toBe(Math.round(halfPeriodPs(0.5)));
      expect(entries[2]!.time).toBe(Math.round(halfPeriodPs(0.5) + halfPeriodPs(0)));
      expect(entries[1]!.time).toBe(entries[0]!.time);
      expect(entries[0]!.level).toBe(0);
      expect(harness.errors).toEqual([]);
      expect(harness.events.filter((event) => event.name === 'fault')).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('FIFO 满沿用 captureOverflow + fault(0xffffffff) + halted 合同', async () => {
    const harness = await createTimerHarness(
      new TimerProgram({ pins: ['PA15', 'PB4'], mode: 'spin' }).build(),
    );
    try {
      harness.run(0);
      await setTimer(harness, 1, 0);
      await setTimer(harness, 2, 0);
      harness.run(2_000_000_000);

      expect(harness.state('captureOverflow')).toBe(1);
      expect(harness.state('halted')).toBe(true);
      const faults = harness.events
        .filter((event) => event.name === 'fault')
        .map((event) => event.value);
      expect(faults).toContain(0xffffffff);
      expect(harness.state('captureTail')).toBe(64);
    } finally {
      harness.dispose();
    }
  });

  it('真实 WFI：TIM2_CH1 捕获 IRQ 唤醒休眠 CPU 并递增 SRAM 计数', async () => {
    const harness = await createTimerHarness(
      new TimerProgram({ pins: ['PA15'], mode: 'wfi', irqCount: 3 }).build(),
    );
    try {
      harness.run(0);
      await setTimer(harness, 2, 1);
      harness.run(5_000_000_000);

      const sram = new DataView(harness.memory('sram').buffer);
      expect(sram.getUint32(RESULT_BASE - 0x2000_0000, true)).toBe(3);
      expect(harness.state('halted')).toBe(false);
      expect(harness.errors).toEqual([]);
      expect(harness.events.filter((event) => event.name === 'fault')).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('555 运行不改变 LCD frameInfo 时间线（120 ms 与分立 oracle 对账）', async () => {
    const image = loadFirmware();
    const actual = await createHarness({ firmware: image.bytes });
    const jointSpecifier = new URL('../../devices/test/ili9325/joint-harness.ts', import.meta.url)
      .href;
    const oracleModule = (await import(jointSpecifier as string)) as unknown as {
      createJointBoard(options: { firmware: Uint8Array }): Promise<{
        board: { runUntil(target: number): void; dispose(): void };
        frameTimes: readonly number[];
        dispose(): void;
      }>;
    };
    const oracle = await oracleModule.createJointBoard({ firmware: image.bytes });
    try {
      actual.board.runUntil(0);
      oracle.board.runUntil(0);
      actual.advanceTo(120_000_000_000);
      oracle.board.runUntil(120_000_000_000);

      expect(actual.frameTimes).toEqual(oracle.frameTimes);
      expect(actual.frameTimes.length).toBeGreaterThan(0);
      expect(Number(actual.state('fusedTimerPhase1'))).toBeGreaterThan(0);
      expect(Number(actual.state('fusedTimerPhase2'))).toBeGreaterThan(0);
    } finally {
      actual.dispose();
      oracle.dispose();
    }
  });
});
