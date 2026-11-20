import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { describe, expect, it } from 'vitest';
import { adaptDevice } from './harness';
import { systemBoard } from './system-harness';
import { SystemThumb, vectorOf } from './system-thumb';
import { TIM_PROBE_MODEL, TIM_SOURCE_MODEL } from './tim-rig';

/**
 * 真实 MCU 路径的 TIM 固件回归：通过 device adapter、bus、GPIO 复用、SERVICE_TICK
 * 和 SRAM 结果验证计数溢出与 PA15/TIM2_CH1 输入捕获。固件是手写的 Thumb-2 子集，
 * 不使用宿主直接写 CCR。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');

let loaded:
  | Promise<{
      readonly module: { readonly create: unknown };
      readonly model: Awaited<ReturnType<typeof compileDDL>>;
      readonly sourceModel: Awaited<ReturnType<typeof compileDDL>>;
    }>
  | undefined;

/** 延迟到用例体内；中央集成进行中时，跳过用例不应触发 index.ts 的加载。 */
function load() {
  loaded ??= Promise.all([
    import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{ create: unknown }>,
    compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
      uri: 'mica:devices/stm32g431rbt6/model.ddl',
    }),
    compileDDL(TIM_SOURCE_MODEL),
  ]).then(([deviceModule, deviceModel, sourceModel]) => ({
    module: deviceModule,
    model: deviceModel,
    sourceModel,
  }));

  return loaded;
}

const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

interface InstanceView {
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

const instanceOf = (board: Board): InstanceView =>
  (board as unknown as { readonly instances: readonly InstanceView[] }).instances[0]!;

function vddVssNets(): {
  id: string;
  voltage: number;
  pins: { instance: string; pin: string }[];
}[] {
  return [
    { id: 'vdd', voltage: 3.3, pins: VDD.map((pin) => ({ instance: 'mcu', pin })) },
    { id: 'vss', voltage: 0, pins: VSS.map((pin) => ({ instance: 'mcu', pin })) },
  ];
}

interface Fixup {
  readonly at: number;
  readonly label: string;
  readonly condition: number;
}

/** 带标签的 Thumb-16/Thumb-2 最小汇编器；只发射本文件用到的确定编码。 */
class Thumb {
  readonly #halves: number[] = [];
  readonly #labels = new Map<string, number>();
  readonly #fixups: Fixup[] = [];

  label(name: string): this {
    this.#labels.set(name, this.#halves.length);

    return this;
  }

  #half(value: number): this {
    this.#halves.push(value & 0xffff);

    return this;
  }

  #dword(first: number, second: number): this {
    return this.#half(first).#half(second);
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
    return this.#half(0x2000 | (rd << 8) | (immediate & 0xff));
  }

  ands(rd: number, rm: number): this {
    return this.#half(0x4000 | (rm << 3) | rd);
  }

  cmp(rd: number, immediate: number): this {
    return this.#half(0x2800 | (rd << 8) | (immediate & 0xff));
  }

  strWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8c0 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8d0 | rn, (rt << 12) | (offset & 0xfff));
  }

  strSp(rt: number, offset: number): this {
    return this.#half(0x9000 | (rt << 8) | ((offset >>> 2) & 0xff));
  }

  branch(label: string, condition = 0xe): this {
    const at = this.#halves.length;

    this.#half(0);
    this.#fixups.push({ at, label, condition });

    return this;
  }

  spin(): this {
    return this.#half(0xe7fe);
  }

  build(): Uint8Array {
    for (const fixup of this.#fixups) {
      const target = this.#labels.get(fixup.label);

      if (target === undefined) throw new Error(`missing label ${fixup.label}`);
      const displacement = target - fixup.at - 2;

      if (fixup.condition === 0xe) {
        if (displacement < -1024 || displacement > 1023)
          throw new Error('B displacement out of range');
        this.#halves[fixup.at] = 0xe000 | (displacement & 0x7ff);
      } else {
        if (displacement < -128 || displacement > 127)
          throw new Error('conditional branch displacement out of range');
        this.#halves[fixup.at] = 0xd000 | (fixup.condition << 8) | (displacement & 0xff);
      }
    }

    const image = new Uint8Array(8 + this.#halves.length * 2);
    const view = new DataView(image.buffer);

    view.setUint32(0, 0x2000_5000, true);
    view.setUint32(4, 0x0800_0009, true);
    this.#halves.forEach((value, index) => view.setUint16(8 + index * 2, value, true));

    return image;
  }
}

const TIM2 = 0x40000000;
const TIM6 = 0x40001000;
const GPIOA = 0x48000000;

const CR1 = 0x00;
const DIER = 0x0c;
const SR = 0x10;
const CCMR1 = 0x18;
const CCER = 0x20;
const CNT = 0x24;
const PSC = 0x28;
const ARR = 0x2c;
const CCR1 = 0x34;

function address(code: Thumb, register: number, base: number): Thumb {
  return code.movw(register, base & 0xffff).movt(register, base >>> 16);
}

function pwmFirmware(): Uint8Array {
  const code = address(new Thumb(), 0, 0x40021000);

  code.movs(1, 1).strWord(1, 0, 0x4c); // AHB2ENR.GPIOAEN
  code.movs(1, 1).strWord(1, 0, 0x58); // APB1ENR1.TIM2EN
  address(code, 0, GPIOA);
  code.movs(1, 2).strWord(1, 0, 0x00); // PA0 alternate function
  code.movs(1, 1).strWord(1, 0, 0x20); // PA0 AF1 (TIM2_CH1)
  address(code, 0, TIM2);
  code.movs(1, 15).strWord(1, 0, ARR);
  code.movs(1, 0).strWord(1, 0, PSC);
  code.movs(1, 0x60).strWord(1, 0, CCMR1); // PWM mode 1
  code.movs(1, 7).strWord(1, 0, CCR1);
  code.movs(1, 1).strWord(1, 0, CCER);
  code.movs(1, 1).strWord(1, 0, CR1);
  code.spin();

  return code.build();
}

function countOverflowFirmware(): Uint8Array {
  const code = address(new Thumb(), 0, 0x40021000);

  code.movs(1, 1).strWord(1, 0, 0x58); // APB1ENR1.TIM2EN
  address(code, 0, TIM2);
  address(code, 1, 0xffffffff);
  code.strWord(1, 0, ARR);
  code.movs(1, 0).strWord(1, 0, PSC);
  address(code, 1, 0xfffffffe);
  code.strWord(1, 0, CNT);
  code.movs(1, 1).strWord(1, 0, DIER);
  code.movs(1, 1).strWord(1, 0, CR1);
  code.label('wait');
  code.ldrWord(1, 0, SR);
  code.movs(2, 1).ands(1, 2).cmp(1, 0).branch('wait', 0x0);
  code.ldrWord(2, 0, CNT).strSp(2, 0);
  code.ldrWord(2, 0, SR).strSp(2, 4);
  code.movs(1, 0).strWord(1, 0, SR);
  code.ldrWord(2, 0, SR).strSp(2, 8);
  code.spin();

  return code.build();
}

function captureFirmware(pinName: 'PA15' | 'PB4' = 'PA15', afrValue?: number): Uint8Array {
  const pb4 = pinName === 'PB4';
  const code = address(new Thumb(), 0, 0x40021000);

  code.movs(1, pb4 ? 2 : 1).strWord(1, 0, 0x4c); // AHB2ENR: GPIOA/GPIOB
  code.movs(1, pb4 ? 2 : 1).strWord(1, 0, 0x58); // APB1ENR1: TIM2/TIM3
  address(code, 0, pb4 ? 0x48000400 : GPIOA);
  address(code, 1, pb4 ? 0x00000200 : 0x80000000); // PB4/PA15 alternate function
  code.strWord(1, 0, 0x00);
  address(code, 1, afrValue ?? (pb4 ? 0x00020000 : 0x10000000)); // PB4 AF2 / PA15 AF1
  code.strWord(1, 0, pb4 ? 0x20 : 0x24);
  address(code, 0, pb4 ? 0x40000400 : TIM2);
  address(code, 1, 0xffffffff);
  code.strWord(1, 0, ARR);
  code.movs(1, 0).strWord(1, 0, PSC);
  code.movs(1, 1).strWord(1, 0, CCMR1);
  code.movs(1, 1).strWord(1, 0, CCER);
  code.movs(1, 2).strWord(1, 0, DIER);
  code.movs(1, 1).strWord(1, 0, CR1);
  code.label('first');
  code.ldrWord(1, 0, SR);
  code.movs(2, 2).ands(1, 2).cmp(1, 0).branch('first', 0x0);
  code.ldrWord(2, 0, CCR1).strSp(2, 0);
  code.label('second');
  code.ldrWord(1, 0, SR);
  code.movs(2, 2).ands(1, 2).cmp(1, 0).branch('second', 0x0);
  code.ldrWord(2, 0, CCR1).strSp(2, 4);
  code.spin();

  return code.build();
}

interface CapturePulseResult {
  readonly first: number;
  readonly second: number;
  readonly status: string;
  readonly head: number;
  readonly tail: number;
  readonly snapshots: readonly {
    readonly head: number;
    readonly tail: number;
    readonly first: number;
    readonly second: number;
  }[];
  readonly cpuFaults: readonly number[];
  readonly errors: readonly string[];
}

async function capturePulseAt(
  highAt: number,
  lowAt: number,
  secondHighAt: number,
  endAt: number,
  pinName: 'PA15' | 'PB4' = 'PA15',
  afrValue?: number,
  extra: readonly { readonly at: number; readonly level: number }[] = [],
): Promise<CapturePulseResult> {
  const { module, model, sourceModel } = await load();
  let send: ((value: unknown) => void) | undefined;
  const createSource = (context: {
    readonly inputs: Readonly<Record<string, { send(value: unknown): void }>>;
  }) => {
    send = context.inputs.level?.send;

    return { sync() {}, dispose() {} };
  };
  const firmware = captureFirmware(pinName, afrValue);
  const cpuFaults: number[] = [];
  const errors: string[] = [];
  const board = createBoard(
    createDeviceLibrary([
      { id: 'mcu', model, create: adaptDevice(module, { firmware }) as never },
      { id: 'src', model: sourceModel, create: createSource as never },
    ]),
    {
      instances: [
        { id: 'mcu', type: 'mcu', props: { clockFrequency: 16_000_000 } },
        { id: 'src', type: 'src' },
      ],
      nets: [
        ...vddVssNets().map((net) =>
          net.id === 'vdd'
            ? { ...net, pins: [...net.pins, { instance: 'src', pin: 'vcc' }] }
            : { ...net, pins: [...net.pins, { instance: 'src', pin: 'gnd' }] },
        ),
        {
          id: pinName,
          pins: [
            { instance: 'mcu', pin: pinName },
            { instance: 'src', pin: 'y' },
          ],
        },
      ],
    } as never,
  );

  expect(send).toBeDefined();
  const faultSubscription = board.topics.onDidReceive((message) => {
    if (message.topic === 'fault') cpuFaults.push(Number(message.payload));
  });
  const errorSubscription = board.onDidError((error) => errors.push(error.message));

  try {
    board.runUntil(0);
    send?.(0);
    board.runUntil(0);
    board.runUntil(highAt);
    send?.(1);
    board.runUntil(lowAt);
    send?.(0);
    board.runUntil(secondHighAt);
    send?.(1);
    const inst = (
      board as unknown as {
        readonly instances: readonly { readonly states: ReadonlyMap<string, unknown> }[];
      }
    ).instances[0]!;
    const snapshots: { head: number; tail: number; first: number; second: number }[] = [];

    for (const event of extra) {
      board.runUntil(event.at);
      send?.(event.level);
      board.runUntil(event.at);
      const sram = new DataView(instanceOf(board).memories.get('sram')!.buffer);

      snapshots.push({
        head: inst.states.get('captureHead') as number,
        tail: inst.states.get('captureTail') as number,
        first: sram.getUint32(0x5000, true),
        second: sram.getUint32(0x5004, true),
      });
    }
    board.runUntil(endAt);
    const sram = new DataView(instanceOf(board).memories.get('sram')!.buffer);

    return {
      first: sram.getUint32(0x5000, true),
      second: sram.getUint32(0x5004, true),
      status: board.status,
      head: inst.states.get('captureHead') as number,
      tail: inst.states.get('captureTail') as number,
      snapshots,
      cpuFaults,
      errors,
    };
  } finally {
    faultSubscription.dispose();
    errorSubscription.dispose();
    board.dispose();
  }
}

// 真实适配器路径已恢复；capture 用例等中央把 PA15/PB4 的引脚边沿接到
// 已接入中央 capture FIFO 与 observeTimerInputByPin。
describe('STM32G431 TIM firmware path', () => {
  it('TIM2 32 位计数在真实 bus/JIT/SERVICE_TICK 路径跨过 0xFFFFFFFF', async () => {
    const { module, model } = await load();
    const board = createBoard(
      createDeviceLibrary([
        {
          id: 'mcu',
          model,
          create: adaptDevice(module, { firmware: countOverflowFirmware() }) as never,
        },
      ]),
      {
        instances: [{ id: 'mcu', type: 'mcu', props: { clockFrequency: 16_000_000 } }],
        nets: vddVssNets(),
      } as never,
    );

    try {
      board.runUntil(0);
      board.runUntil(100_000_000);
      const sram = new DataView(instanceOf(board).memories.get('sram')!.buffer);
      // 轮询循环发现 UIF 到读回 CNT 之间还有几条 CPU 指令，16 MHz 下会多计几十个数；
      // 关键断言是已回绕（远小于 0xFFFFFFFE）、UIF 置位、清 SR 后归零。
      expect(sram.getUint32(0x5000, true)).toBeLessThan(200);
      expect(sram.getUint32(0x5004, true) & 1).toBe(1);
      expect(sram.getUint32(0x5008, true)).toBe(0);
      expect(board.status).toBe('ready');
    } finally {
      board.dispose();
    }
  });

  // 回归用例保持启用。历史故障：2026-11-16 22:01 index.ts 改动后曾在
  // 8_312_500 ps (8.3125 µs) 报 `JIT_FAILED: Translated first pc does not match`；
  // 22:28 后父已独验正式 id 的该 case 与 PWM 均 pass。底层 dynamic elapse 重放
  // 仍由 compiler owner 根修，不作为当前 TIM 失败根因。
  it('TIM6 IRQ54(bank1) 与 TIM2 IRQ28(bank0) 在真实 NVIC 上分别进入 handler', async () => {
    const t = new SystemThumb();
    const at = (base: number): SystemThumb => t.movw(0, base & 0xffff).movt(0, base >>> 16);
    const increment = (base: number): void => {
      at(base);
      t.ldrWord(1, 0, 0).adds(1, 1).strWord(1, 0, 0);
    };

    t.vector(vectorOf(28), 'irq28').vector(vectorOf(54), 'irq54');
    t.mark('start');
    at(0x40021000);
    t.movs(1, 0x11).strWord(1, 0, 0x58); // APB1ENR1.TIM2EN | TIM6EN
    at(TIM2);
    t.movs(1, 9).strWord(1, 0, ARR);
    t.movs(1, 0).strWord(1, 0, PSC);
    t.movs(1, 1).strWord(1, 0, DIER);
    t.movs(1, 1).strWord(1, 0, CR1);
    at(TIM6);
    t.movs(1, 49).strWord(1, 0, ARR);
    t.movs(1, 0).strWord(1, 0, PSC);
    t.movs(1, 1).strWord(1, 0, DIER);
    t.movs(1, 1).strWord(1, 0, CR1);
    at(0xe000_e41c);
    t.movs(1, 0x80).strByte(1, 0, 0); // IRQ28 低优先级，避免同优先级饥饿
    at(0xe000_e100);
    t.movw(1, 0x0000).movt(1, 0x1000).strWord(1, 0, 0); // ISER0 bit28
    at(0xe000_e104);
    t.movw(1, 0x0000).movt(1, 0x0040).strWord(1, 0, 0); // ISER1 bit22 = IRQ54
    t.spin();

    t.mark('irq28');
    increment(0x2000_5000);
    at(TIM2);
    t.movs(1, 0).strWord(1, 0, SR).bx(14);

    t.mark('irq54');
    increment(0x2000_5004);
    at(TIM6);
    t.movs(1, 0).strWord(1, 0, SR).bx(14);

    const board = await systemBoard({ firmware: t.build(), clockFrequency: 16_000_000 });

    try {
      board.run(30_000_000);
      expect(board.faults).toEqual([]);
      expect(board.sramWord(0x5000)).toBeGreaterThan(0);
      expect(board.sramWord(0x5004)).toBeGreaterThan(0);
    } finally {
      board.dispose();
    }
  });

  // 中央 peripherals.ts 仍以 `module.id === 'tim'` 跳过 TIM 的 AlternateDriver；
  // 缓存已在 tim.ts 实现；中央 TIM AF skip 已删除。
  it('真实主 MCU 固件通过 PA0/TIM2_CH1 AF1 输出 1 MHz PWM', async () => {
    const { module, model } = await load();
    const probeModel = await compileDDL(TIM_PROBE_MODEL);
    const history: number[] = [];
    const createProbe = () => (context: unknown) => {
      void context;

      return {
        sync(batch: { readonly outputs: Readonly<Record<string, readonly { value: unknown }[]>> }) {
          for (const message of batch.outputs.level ?? []) history.push(message.value as number);
        },
        dispose() {},
      };
    };
    const board = createBoard(
      createDeviceLibrary([
        { id: 'mcu', model, create: adaptDevice(module, { firmware: pwmFirmware() }) as never },
        { id: 'probe', model: probeModel, create: createProbe() as never },
      ]),
      {
        instances: [
          { id: 'mcu', type: 'mcu', props: { clockFrequency: 16_000_000 } },
          { id: 'probe', type: 'probe', props: { period: 62_500 } },
        ],
        nets: [
          ...vddVssNets(),
          {
            id: 'PA0',
            pins: [
              { instance: 'mcu', pin: 'PA0' },
              { instance: 'probe', pin: 'p' },
            ],
          },
        ],
      } as never,
    );

    try {
      board.runUntil(0);
      board.runUntil(10_000_000);
      const levels = history.filter((value) => value === 0 || value === 1);
      const rising: number[] = [];

      for (let index = 1; index < levels.length; index += 1)
        if (levels[index - 1] === 0 && levels[index] === 1) rising.push(index);
      const duty = levels.filter((value) => value === 1).length / levels.length;

      expect(rising.length).toBeGreaterThanOrEqual(5);
      if (rising.length >= 2) expect(rising[1]! - rising[0]!).toBeGreaterThanOrEqual(14);
      if (rising.length >= 2) expect(rising[1]! - rising[0]!).toBeLessThanOrEqual(18);
      expect(duty).toBeGreaterThan(0.35);
      expect(duty).toBeLessThan(0.55);
      expect(board.status).toBe('ready');
    } finally {
      board.dispose();
    }
  });

  // 真实 PA15/PB4 边沿经中央 16B FIFO + observeTimerInputByPin 捕获。
  // 两套 TIM 初始化在 16 MHz 下约 5.75 us；本用例在 8 us 同一 timestamp 发两脚，
  // 验证两个 reaction 都按真实边沿入队，而不是在 TIM3 尚未 CEN 时提前发边沿。
  it('同一 quantum PA15/PB4 多脚真实边沿按 reaction 到达顺序入队', async () => {
    const { module, model, sourceModel } = await load();
    let sendA: ((value: unknown) => void) | undefined;
    let sendB: ((value: unknown) => void) | undefined;
    const createSource =
      (slot: 'a' | 'b') =>
      (context: { readonly inputs: Readonly<Record<string, { send(value: unknown): void }>> }) => {
        if (slot === 'a') sendA = context.inputs.level?.send;
        else sendB = context.inputs.level?.send;

        return { sync() {}, dispose() {} };
      };
    const code = address(new Thumb(), 0, 0x40021000);

    code.movs(1, 3).strWord(1, 0, 0x4c); // GPIOA/GPIOB clock
    code.movs(1, 3).strWord(1, 0, 0x58); // TIM2/TIM3 clock
    address(code, 0, GPIOA);
    address(code, 1, 0x80000000);
    code.strWord(1, 0, 0x00);
    address(code, 1, 0x10000000);
    code.strWord(1, 0, 0x24);
    address(code, 0, 0x48000400);
    address(code, 1, 0x00000200);
    code.strWord(1, 0, 0x00);
    address(code, 1, 0x00020000);
    code.strWord(1, 0, 0x20);
    for (const timer of [TIM2, 0x40000400]) {
      address(code, 0, timer);
      address(code, 1, 0xffffffff);
      code.strWord(1, 0, ARR);
      code.movs(1, 0).strWord(1, 0, PSC);
      code.movs(1, 1).strWord(1, 0, CCMR1);
      code.movs(1, 1).strWord(1, 0, CCER);
      code.movs(1, 2).strWord(1, 0, DIER);
      code.movs(1, 1).strWord(1, 0, CR1);
    }
    code.spin();
    const dualFirmware = code.build();
    expect(dualFirmware.length).toBe(194);
    expect(new DataView(dualFirmware.buffer).getUint32(0, true)).toBe(0x2000_5000);
    expect(new DataView(dualFirmware.buffer).getUint32(4, true)).toBe(0x0800_0009);
    expect(dualFirmware[0xc0]).toBe(0xfe);
    expect(dualFirmware[0xc1]).toBe(0xe7);
    const board = createBoard(
      createDeviceLibrary([
        { id: 'mcu', model, create: adaptDevice(module, { firmware: dualFirmware }) as never },
        { id: 'srcA', model: sourceModel, create: createSource('a') as never },
        { id: 'srcB', model: sourceModel, create: createSource('b') as never },
      ]),
      {
        instances: [
          { id: 'mcu', type: 'mcu', props: { clockFrequency: 16_000_000 } },
          { id: 'srcA', type: 'srcA' },
          { id: 'srcB', type: 'srcB' },
        ],
        nets: [
          ...vddVssNets().map((net) =>
            net.id === 'vdd'
              ? {
                  ...net,
                  pins: [
                    ...net.pins,
                    { instance: 'srcA', pin: 'vcc' },
                    { instance: 'srcB', pin: 'vcc' },
                  ],
                }
              : {
                  ...net,
                  pins: [
                    ...net.pins,
                    { instance: 'srcA', pin: 'gnd' },
                    { instance: 'srcB', pin: 'gnd' },
                  ],
                },
          ),
          {
            id: 'PA15',
            pins: [
              { instance: 'mcu', pin: 'PA15' },
              { instance: 'srcA', pin: 'y' },
            ],
          },
          {
            id: 'PB4',
            pins: [
              { instance: 'mcu', pin: 'PB4' },
              { instance: 'srcB', pin: 'y' },
            ],
          },
        ],
      } as never,
    );

    const cpuFaults: number[] = [];
    const errors: string[] = [];
    const faultSubscription = board.topics.onDidReceive((message) => {
      if (message.topic === 'fault') cpuFaults.push(Number(message.payload));
    });
    const errorSubscription = board.onDidError((error) => errors.push(error.message));
    const inst = (
      board as unknown as {
        readonly instances: readonly {
          readonly states: ReadonlyMap<string, unknown>;
          readonly memories: ReadonlyMap<string, Uint8Array>;
        }[];
      }
    ).instances[0]!;
    const state = (name: string): unknown => inst.states.get(name);
    const tim = inst.memories.get('tim')!;
    const timView = new DataView(tim.buffer, tim.byteOffset, tim.byteLength);
    const timerRegister = (base: number, offset: number): number =>
      timView.getUint32(base + offset, true);

    try {
      board.runUntil(0);
      expect(sendA).toBeDefined();
      expect(sendB).toBeDefined();
      sendA?.(0);
      sendB?.(0);

      // 194 B 双 TIM 固件在 16 MHz 下约 5.75 us 才完成 spin 前配置。5 us 时 TIM3 的
      // DIER/CR1 还没执行，PB4 gate 不 armed；8 us 是在等真实初始化完成，不是提高 timeout。
      board.runUntil(8_000_000);
      expect(board.time).toBe(8_000_000);
      expect(state('captureHead')).toBe(0);
      expect(state('captureTail')).toBe(0);
      expect(Number(state('timCenMask')) & 0x6).toBe(0x6);
      for (const base of [0x48, 0x90] as const) {
        expect(timerRegister(base, 0x00)).toBe(1); // CR1.CEN
        expect(timerRegister(base, 0x18)).toBe(1); // CCMR1.CC1S=01
        expect(timerRegister(base, 0x20)).toBe(1); // CCER.CC1E，上升沿
      }
      expect((Number(state('gpioModer0')) >>> 30) & 0x3).toBe(2);
      expect((Number(state('gpioAfr10')) >>> 28) & 0xf).toBe(1);
      expect((Number(state('gpioModer1')) >>> 8) & 0x3).toBe(2);
      expect((Number(state('gpioAfr01')) >>> 16) & 0xf).toBe(2);

      sendA?.(1);
      sendB?.(1);
      board.runUntil(9_000_000);
      expect(board.time).toBe(9_000_000);

      expect(state('captureHead')).toBe(2);
      expect(state('captureTail')).toBe(2);
      expect(state('halted')).toBe(false);
      expect(cpuFaults).toEqual([]);
      expect(errors).toEqual([]);
      expect(board.status).toBe('ready');

      const fifo = inst.memories.get('captureFifo')!;
      const fifoView = new DataView(fifo.buffer, fifo.byteOffset, fifo.byteLength);
      const entry = (index: number) => {
        const at = index * 16;

        return {
          time: fifoView.getUint32(at, true) + fifoView.getUint32(at + 4, true) * 4_294_967_296,
          pinId: fifo[at + 8],
          level: fifo[at + 9],
        };
      };

      expect(entry(0)).toEqual({ time: 8_000_000, pinId: 0, level: 1 });
      expect(entry(1)).toEqual({ time: 8_000_000, pinId: 1, level: 1 });
    } finally {
      faultSubscription.dispose();
      errorSubscription.dispose();
      board.dispose();
    }
  });

  it('PA15/TIM2_CH1 AF1 在真实引脚上捕获 0.2 µs 短脉冲', async () => {
    // 5 µs 起点避开固件约 1.6 µs 的 TIM/GPIO 初始化；脉冲宽度仍是 0.2 µs。
    const result = await capturePulseAt(5_000_000, 5_200_000, 6_000_000, 16_000_000);

    expect(result.first).toBeGreaterThan(0);
    expect(result.second - result.first).toBe(16);
    expect(result.status).toBe('ready');
  });

  it('PB4/TIM3_CH1 AF2 正向捕获；PB0 AF=0 不误命中', async () => {
    const result = await capturePulseAt(
      5_000_000,
      5_200_000,
      6_000_000,
      16_000_000,
      'PB4',
      0x0002_0000,
    );

    expect(result.first).toBeGreaterThan(0);
    expect(result.second - result.first).toBe(16);
    expect(result.status).toBe('ready');
    expect(result.cpuFaults).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('PB4 AF=0 / PB0 AF=2 时不得捕获', async () => {
    const result = await capturePulseAt(
      5_000_000,
      5_200_000,
      6_000_000,
      16_000_000,
      'PB4',
      0x0000_0002,
    );

    expect(result.first).toBe(0);
    expect(result.second).toBe(0);
    expect(result.status).toBe('ready');
    expect(result.cpuFaults).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('未配置的 PA15/PB4 高频真实切换不入队、不 fault、不抢普通 GPIO', async () => {
    const board = await systemBoard({
      firmware: pwmFirmware(),
      pins: ['PA0', 'PA15', 'PB4'],
    });

    try {
      expect(board.inputs.PA15).toBeDefined();
      expect(board.inputs.PB4).toBeDefined();
      board.run(1_000_000);

      for (let index = 0; index < 100; index += 1) {
        board.inputs.PA15?.send(index & 1);
        board.inputs.PB4?.send((index + 1) & 1);
        board.run(1_000_000);
      }

      expect(board.state('captureHead')).toBe(0);
      expect(board.state('captureTail')).toBe(0);
      expect(board.faults).toEqual([]);
      expect(board.cpuFaults).toEqual([]);
      expect(board.history.PA0?.some((value) => value === 1)).toBe(true);
    } finally {
      board.dispose();
    }
  });

  it('真实 pin probe 证明 unknown 不产生 capture，known low/high 可继续', async () => {
    const board = await systemBoard({
      firmware: captureFirmware('PA15'),
      pins: ['PA15'],
      initialLevels: { PA15: 0 },
    });

    try {
      expect(board.inputs.PA15).toBeDefined();
      board.run(5_000_000);
      const baseline = board.state('captureHead') as number;

      board.inputs.PA15?.send(1);
      board.run(1_000_000);
      const afterRise = board.state('captureHead') as number;
      expect(afterRise).toBeGreaterThan(baseline);

      board.inputs.PA15?.send(2);
      board.run(1_000_000);
      expect(board.state('captureHead')).toBe(afterRise);
      expect(board.history.PA15).toContain(2);

      board.inputs.PA15?.send(1);
      board.run(1_000_000);
      expect(board.state('captureHead')).toBe(afterRise);

      board.inputs.PA15?.send(0);
      board.run(1_000_000);
      const afterFall = board.state('captureHead') as number;
      expect(afterFall).toBe(afterRise + 1);

      board.inputs.PA15?.send(1);
      board.run(1_000_000);
      expect(board.state('captureHead')).toBe(afterFall + 1);
      expect(board.cpuFaults).toEqual([]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('known→unknown→known 只在真实 known 边沿入队（FIFO 记录所有已知边沿）', async () => {
    const armed = await capturePulseAt(5_000_000, 5_200_000, 6_000_000, 16_000_000);
    expect(armed.first).toBeGreaterThan(0);
    expect(armed.head).toBe(3);
    expect(armed.cpuFaults).toEqual([]);
    expect(armed.errors).toEqual([]);

    const unknown = await capturePulseAt(
      5_000_000,
      5_200_000,
      6_000_000,
      20_000_000,
      'PA15',
      undefined,
      [
        { at: 7_000_000, level: 2 },
        { at: 9_000_000, level: 1 },
        { at: 11_000_000, level: 0 },
        { at: 13_000_000, level: 1 },
      ],
    );

    // unknown 不产生边沿；之后真实 high→low→high 两条已知边沿各入队一次。
    // FIFO 记录所有 known 边沿（含 falling），不按捕获极性过滤。
    expect(unknown.head).toBe(armed.head + 2);
    expect(unknown.tail).toBe(armed.tail + 2);
    expect(unknown.first).toBe(armed.first);
    expect(unknown.second).toBe(armed.second);
    expect(unknown.status).toBe('ready');
    expect(unknown.cpuFaults).toEqual([]);
    expect(unknown.errors).toEqual([]);
  });

  it('NRST 清空 capture FIFO 并从向量表恢复捕获', async () => {
    const board = await systemBoard({
      firmware: captureFirmware('PA15'),
      pins: ['PA15', 'NRST'],
      initialLevels: { NRST: 1, PA15: 0 },
    });

    try {
      expect(board.inputs.PA15).toBeDefined();
      expect(board.inputs.NRST).toBeDefined();
      board.run(5_000_000);
      board.inputs.PA15?.send(0);
      board.run(1_000_000);
      board.inputs.PA15?.send(1);
      board.run(1_000_000);
      expect(board.state('captureHead')).toBeGreaterThan(0);

      board.inputs.NRST?.send(0);
      board.run(1_000_000);
      board.inputs.NRST?.send(1);
      board.run(5_000_000);

      expect(board.state('halted')).toBe(false);
      expect(board.state('captureHead')).toBe(0);
      expect(board.state('captureTail')).toBe(0);
      expect(board.state('captureOverflow')).toBe(0);

      board.inputs.PA15?.send(0);
      board.run(1_000_000);
      board.inputs.PA15?.send(1);
      board.run(1_000_000);
      expect(board.state('captureHead')).toBeGreaterThan(0);
      expect(board.faults).toEqual([]);
      expect(board.cpuFaults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('PA15/TIM2_CH1 AF1 在 6 ms 后捕获两个上升沿（1 µs = 16 ticks）', async () => {
    // 超过 2^32 ps (4.294967296 ms) 后仍用安全整数绝对时间。
    const result = await capturePulseAt(6_000_000_000, 6_000_200_000, 6_001_000_000, 6_011_000_000);

    expect(result.first).toBeGreaterThan(0);
    expect(result.second - result.first).toBe(16);
    expect(result.status).toBe('ready');
  });

  it('PA15/TIM2_CH1 AF1 跨 2^32 ps 边界捕获（1 µs = 16 ticks）', async () => {
    // 2^32 = 4_294_967_296 ps；first 在阈值下 500_000 ps，second 在阈值上 500_000 ps。
    // high=first，low=first+200_000 ps (0.2 µs)，second=first+1_000_000 ps (1 µs)。
    // second 后再留 10_000_000 ps = 10 µs 给 guest 读取 CCR。
    const result = await capturePulseAt(4_294_467_296, 4_294_667_296, 4_295_467_296, 4_305_467_296);

    expect(result.first).toBeGreaterThan(0);
    expect(result.second - result.first).toBe(16);
    expect(result.status).toBe('ready');
  });
});
