import { describe, expect, it } from 'vitest';
import { createSourceHarness } from './source-harness.ts';

/**
 * IAP / EEPROM 的源码级用例。
 *
 * 等待完成的做法：固件反复读同一个地址，读到期望值才继续——真实硬件里 CPU 在执行 IAP
 * 命令期间停顿，这里用轮询表达同一语义。`flash` 在模型里零初始化，所以写用例统一先擦除
 * 再编程（只有空字节才能写入）。
 */

const HALT = [0x80, 0xfe]; // SJMP $

/** 板级时间单位：皮秒。 */
const US = 1_000_000;
const MS = 1_000_000_000;

const PUSH_PULL_P2 = [0x75, 0x96, 0xff, 0x75, 0x95, 0x00];

const IAP_DATA = 0xc2;
const IAP_ADDRH = 0xc3;
const IAP_ADDRL = 0xc4;
const IAP_CMD = 0xc5;
const IAP_TRIG = 0xc6;
const IAP_CONTR = 0xc7;

const CMD_READ = 1;
const CMD_PROGRAM = 2;
const CMD_ERASE = 3;

const ISPEN = 0x80;
/** 1 MHz 下 WT=111：编程 55 个时钟、擦除 21012 个时钟。 */
const WT_FASTEST = 0x07;
/** WT=000：编程 1760 个时钟、擦除 672384 个时钟。 */
const WT_SLOWEST = 0x00;

const movDirect = (address: number, value: number): number[] => [0x75, address, value];

const setAddress = (address: number): number[] => [
  ...movDirect(IAP_ADDRH, (address >> 8) & 0xff),
  ...movDirect(IAP_ADDRL, address & 0xff),
];

/** 先写 5AH 再写 A5H：两次写入完成一次触发。 */
const trigger = [0x75, IAP_TRIG, 0x5a, 0x75, IAP_TRIG, 0xa5];

/**
 * 20 字节轮询块：反复读 `address`，直到读到 `value` 才往下走，退出时 A 就是读到的值。
 *
 * MOV IAP_ADDRH,#hi / MOV IAP_ADDRL,#lo / MOV IAP_CMD,#1 /
 * MOV IAP_TRIG,#5AH / MOV IAP_TRIG,#0A5H / MOV A,IAP_DATA / CJNE A,#value,$-20
 */
const waitForValue = (address: number, value: number): number[] => [
  ...setAddress(address),
  ...movDirect(IAP_CMD, CMD_READ),
  ...trigger,
  0xe5,
  IAP_DATA, // MOV A,IAP_DATA
  0xb4,
  value,
  0xec, // CJNE A,#value,$-20
];

/** 从 `address` 读一个字节到 A。 */
const readByte = (address: number): number[] => [
  ...setAddress(address),
  ...movDirect(IAP_CMD, CMD_READ),
  ...trigger,
  0xe5,
  IAP_DATA, // MOV A,IAP_DATA
];

/** 约 510 个时钟的忙等：MOV R7,#0FFH; DJNZ R7,$。 */
const busyWait = [0x7f, 0xff, 0xdf, 0xfe];

interface PortRunOptions {
  readonly firmware: readonly number[];
  readonly until: number;
  readonly step: number;
}

/** 分步推进并把每步的 P2 记下来。 */
async function runPort(
  options: PortRunOptions,
): Promise<{ ports: { time: number; value: number }[]; faults: readonly string[] }> {
  const harness = await createSourceHarness({
    firmware: Uint8Array.from(options.firmware),
    observe: Array.from({ length: 8 }, (_, bit) => `P2_${bit}`),
  });
  const ports: { time: number; value: number }[] = [];

  try {
    for (let time = options.step; time <= options.until; time += options.step) {
      harness.board.runUntil(time);
      ports.push({ time, value: harness.port(2) });
    }

    return { ports, faults: [...harness.faults] };
  } finally {
    harness.dispose();
  }
}

/** 跑到指定虚拟时间后读回 P2。 */
async function finalPort(firmware: readonly number[], milliseconds: number): Promise<number> {
  const harness = await createSourceHarness({
    firmware: Uint8Array.from(firmware),
    observe: Array.from({ length: 8 }, (_, bit) => `P2_${bit}`),
  });

  try {
    harness.board.runUntil(milliseconds * MS);

    return harness.port(2);
  } finally {
    harness.dispose();
  }
}

const firstTimePortIs = (
  samples: readonly { time: number; value: number }[],
  expected: number,
): number => samples.find((sample) => sample.value === expected)?.time ?? Infinity;

describe('IAP 字节读 / 编程', () => {
  it('擦除后写入 5AH，再读回同一个字节', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      // 扇区擦除：地址 0000H
      ...movDirect(IAP_CONTR, ISPEN | WT_FASTEST),
      ...movDirect(IAP_CMD, CMD_ERASE),
      ...setAddress(0x0000),
      ...trigger,
      ...waitForValue(0x0000, 0xff),
      // 字节编程：0000H = 5AH
      ...movDirect(IAP_DATA, 0x5a),
      ...movDirect(IAP_CMD, CMD_PROGRAM),
      ...setAddress(0x0000),
      ...trigger,
      ...movDirect(IAP_DATA, 0xa5), // 数据在触发时已锁存，这里换成哨兵值
      ...waitForValue(0x0000, 0x5a),
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    expect(await finalPort(firmware, 120)).toBe(0x5a);
  });

  it('编程只能把 1 写成 0：0FFH 与 5AH 得 5AH，再与 0FH 得 0AH', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      ...movDirect(IAP_CONTR, ISPEN | WT_FASTEST),
      ...movDirect(IAP_CMD, CMD_ERASE),
      ...setAddress(0x0000),
      ...trigger,
      ...waitForValue(0x0000, 0xff),
      ...movDirect(IAP_DATA, 0x5a),
      ...movDirect(IAP_CMD, CMD_PROGRAM),
      ...setAddress(0x0000),
      ...trigger,
      ...movDirect(IAP_DATA, 0x00),
      ...waitForValue(0x0000, 0x5a),
      // 第二次编程与现有内容按位与。
      ...movDirect(IAP_DATA, 0x0f),
      ...movDirect(IAP_CMD, CMD_PROGRAM),
      ...setAddress(0x0000),
      ...trigger,
      ...movDirect(IAP_DATA, 0x00),
      ...waitForValue(0x0000, 0x0a),
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    expect(await finalPort(firmware, 120)).toBe(0x0a);
  });
});

describe('IAP 扇区擦除', () => {
  it('扇区内任意地址都能触发整段擦除', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      ...movDirect(IAP_CONTR, ISPEN | WT_FASTEST),
      // 先擦一次，得到可编程状态。
      ...movDirect(IAP_CMD, CMD_ERASE),
      ...setAddress(0x0000),
      ...trigger,
      ...waitForValue(0x0000, 0xff),
      // 编程扇区最后一个字节。
      ...movDirect(IAP_DATA, 0x00),
      ...movDirect(IAP_CMD, CMD_PROGRAM),
      ...setAddress(0x01ff),
      ...trigger,
      ...movDirect(IAP_DATA, 0xff),
      ...waitForValue(0x01ff, 0x00),
      // 用扇区首地址再次擦除，末尾字节应回到 0FFH。
      ...movDirect(IAP_CMD, CMD_ERASE),
      ...setAddress(0x0000),
      ...trigger,
      ...waitForValue(0x01ff, 0xff),
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    expect(await finalPort(firmware, 120)).toBe(0xff);
  });

  it('擦除一个扇区不影响另一个扇区', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      ...movDirect(IAP_CONTR, ISPEN | WT_FASTEST),
      // 擦除扇区 0，并把 0000H 写成 3CH。
      ...movDirect(IAP_CMD, CMD_ERASE),
      ...setAddress(0x0000),
      ...trigger,
      ...waitForValue(0x0000, 0xff),
      ...movDirect(IAP_DATA, 0x3c),
      ...movDirect(IAP_CMD, CMD_PROGRAM),
      ...setAddress(0x0000),
      ...trigger,
      ...movDirect(IAP_DATA, 0x00),
      ...waitForValue(0x0000, 0x3c),
      // 擦除扇区 1（用它的首地址 0200H）。
      ...movDirect(IAP_CMD, CMD_ERASE),
      ...setAddress(0x0200),
      ...trigger,
      ...waitForValue(0x0200, 0xff),
      // 扇区 0 的内容不受影响。
      ...readByte(0x0000),
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    expect(await finalPort(firmware, 120)).toBe(0x3c);
  });
});

describe('IAP 使能与错误', () => {
  it('ISPEN=0 时命令不执行', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      // 先擦除，得到全 0FFH 的扇区。
      ...movDirect(IAP_CONTR, ISPEN | WT_FASTEST),
      ...movDirect(IAP_CMD, CMD_ERASE),
      ...setAddress(0x0000),
      ...trigger,
      ...waitForValue(0x0000, 0xff),
      // 关闭 ISPEN 后写一个字，应当完全无效。
      ...movDirect(IAP_CONTR, WT_FASTEST),
      ...movDirect(IAP_DATA, 0x5a),
      ...movDirect(IAP_CMD, CMD_PROGRAM),
      ...setAddress(0x0000),
      ...trigger,
      ...busyWait,
      ...busyWait,
      // 重新允许 IAP，读回同一个字节。
      ...movDirect(IAP_CONTR, ISPEN | WT_FASTEST),
      ...readByte(0x0000),
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    expect(await finalPort(firmware, 60)).toBe(0xff);
  });

  it('地址越界（>= 0400H）时置 CMD_FAIL', async () => {
    const firmware = [
      ...PUSH_PULL_P2,
      0x75,
      0xa0,
      0x00, // MOV P2,#00H
      ...movDirect(IAP_CONTR, ISPEN | WT_FASTEST),
      ...movDirect(IAP_DATA, 0x00),
      ...movDirect(IAP_CMD, CMD_PROGRAM),
      ...setAddress(0x0400),
      ...trigger,
      0xe5,
      IAP_CONTR, // MOV A,IAP_CONTR
      0xf5,
      0xa0, // MOV P2,A
      ...HALT,
    ];

    // CMD_FAIL 是 IAP_CONTR.3；WT 与 ISPEN 位保持不变。
    expect(await finalPort(firmware, 1)).toBe(ISPEN | WT_FASTEST | 0x08);
  });

  it('等待时间由 IAP_CONTR 的 WT2:WT0 决定', async () => {
    const duration = async (wait: number): Promise<number> => {
      const firmware = [
        ...PUSH_PULL_P2,
        0x75,
        0xa0,
        0x00, // MOV P2,#00H
        ...movDirect(IAP_CONTR, ISPEN | wait),
        ...movDirect(IAP_DATA, 0x00),
        ...movDirect(IAP_CMD, CMD_PROGRAM),
        ...setAddress(0x0000),
        ...trigger,
        ...movDirect(IAP_DATA, 0x5a), // 哨兵：编程完成前读不到 00H
        ...waitForValue(0x0000, 0x00),
        0x75,
        0xa0,
        0xa5, // MOV P2,#0A5H（完成标记）
        ...HALT,
      ];
      const result = await runPort({ firmware, until: 3 * MS, step: 20 * US });

      expect(result.faults).toEqual([]);

      return firstTimePortIs(result.ports, 0xa5);
    };

    const fastest = await duration(WT_FASTEST);
    const slowest = await duration(WT_SLOWEST);

    // 55 个时钟 vs 1760 个时钟：1 MHz 下约 55us 与 1.76ms。
    expect(fastest).toBeLessThan(300 * US);
    expect(slowest).toBeGreaterThan(1_200 * US);
    expect(slowest).toBeGreaterThan(fastest * 4);
  });
});
