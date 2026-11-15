import { describe, expect, it } from 'vitest';
import type { BlockIR, OperationIR, RegionIR } from '@mica-js/sdk/model';
import create from '../src/devices/iap15f2k61s2/index.ts';

/**
 * SFR 访问探针的回归：探针只能反映 CPU 指令自身的架构访问。
 *
 * 端口写入会调用外设钩子（复用驱动读 SCON/P_SW1、PCA 读 CL 等）。这些内部读取
 * 不属于这条指令的时间相关访问；若计入探针，普通的 `MOV P2,A` 会带着整段
 * `advanceDevices` 重新生成，热块从数百条 IR 膨胀到八千条。
 *
 * 这里直接用源码翻译器检查生成体积，不依赖 `dist`；同时确认 RMW/XCH/定时器
 * 配置访问在读旧值之前仍然保留结算。
 */

type Translate = (input: { pc: number; code: Uint8Array }) => unknown;

function translator(): Translate {
  let options: { translate: Translate } | undefined;
  const context = {
    props: { firmware: new Uint8Array(0), clockFrequency: 11_059_200 },
    attachJit(value: { translate: Translate }) {
      options = value;

      return { dispose() {} };
    },
    loadBytes() {},
  };

  create(context as never);

  if (options === undefined) throw new Error('attachJit was not called');

  return options.translate;
}

interface Stats {
  operations: number;
  readSamples: number;
  intents: number;
  /** `advanceDevices` → `refreshService` 写出的期限 state；结算内联的直接证据。 */
  deadlineWrites: number;
}

function collect(region: RegionIR, stats: Stats): void {
  for (const operation of region.operations as readonly OperationIR[]) {
    stats.operations += 1;

    switch (operation.kind) {
      case 'readSample':
        stats.readSamples += 1;
        break;
      case 'writeIntent':
        stats.intents += 1;
        break;
      case 'write':
        if (operation.resource === 'state' && operation.name === 'serviceDeadline')
          stats.deadlineWrites += 1;
        break;
      case 'if':
        collect(operation.yes, stats);
        if (operation.no !== undefined) collect(operation.no, stats);
        break;
      case 'match':
        for (const arm of operation.arms) collect(arm.body, stats);
        if (operation.otherwise !== undefined) collect(operation.otherwise, stats);
        break;
      case 'select':
        collect(operation.yes.body, stats);
        collect(operation.no.body, stats);
        break;
      case 'and':
      case 'or':
        collect(operation.right.body, stats);
        break;
      case 'assert':
        if (operation.message !== undefined) collect(operation.message.body, stats);
        break;
      case 'while':
        collect(operation.test.body, stats);
        collect(operation.body, stats);
        break;
      case 'loop':
        collect(operation.body, stats);
        break;
      default:
        break;
    }
  }
}

function statsOf(block: BlockIR): Stats {
  const stats: Stats = { operations: 0, readSamples: 0, intents: 0, deadlineWrites: 0 };

  for (const instruction of block.instructions) collect(instruction.body, stats);

  return stats;
}

function translateAt(pc: number, bytes: readonly number[]): BlockIR {
  const code = new Uint8Array(0x10000);

  bytes.forEach((value, index) => {
    code[(pc + index) & 0xffff] = value;
  });

  return translator()({ pc, code }) as BlockIR;
}

/** 预览固件的热 PC（见 docs/rfc 之外的性能记录）：普通 GPIO 写，不得携带外设结算。 */
const GPIO_WRITES: readonly { pc: number; bytes: readonly number[]; label: string }[] = [
  { pc: 0x08f8, bytes: [0xf5, 0xa0], label: 'MOV P2,A @08F8' },
  { pc: 0x0901, bytes: [0xf5, 0xa0], label: 'MOV P2,A @0901' },
  { pc: 0x0906, bytes: [0x75, 0x80, 0xff], label: 'MOV P0,#0FFH @0906' },
  { pc: 0x091b, bytes: [0xf5, 0x80], label: 'MOV P0,A @091B' },
  { pc: 0x0922, bytes: [0x8e, 0x80], label: 'MOV P0,R6 @0922' },
];

/** 时间相关访问：必须在第一次读旧锁存器之前结算。 */
const SETTLED_ACCESSES: readonly { pc: number; bytes: readonly number[]; label: string }[] = [
  { pc: 0x0a00, bytes: [0xc5, 0x8a], label: 'XCH A,TL0' },
  { pc: 0x0a03, bytes: [0xd2, 0x8c], label: 'SETB TR0' },
  { pc: 0x0a06, bytes: [0x75, 0x88, 0x10], label: 'MOV TCON,#10H' },
  { pc: 0x0a09, bytes: [0xe5, 0x8a], label: 'MOV A,TL0' },
];

describe('SFR 访问探针', () => {
  it('普通端口写不内联外设结算', () => {
    for (const { pc, bytes, label } of GPIO_WRITES) {
      const stats = statsOf(translateAt(pc, bytes));

      // 结算会把整段 advanceDevices 展开：引脚采样与期限写入都是它的固定产物。
      expect(stats.deadlineWrites, `${label} settled`).toBe(0);
      expect(stats.readSamples, `${label} sampled pins`).toBe(0);
      // 端口写仍然一次性发布 8 个引脚意图，优化不能省略 GPIO 本身。
      expect(stats.intents, `${label} pin intents`).toBe(8);
      expect(stats.operations, `${label} IR 操作数`).toBeLessThan(1_000);
    }
  });

  it('时间相关 SFR 的读-改-写仍在读旧值前结算', () => {
    for (const { pc, bytes, label } of SETTLED_ACCESSES) {
      const stats = statsOf(translateAt(pc, bytes));

      expect(stats.deadlineWrites, `${label} settled`).toBeGreaterThan(0);
      expect(stats.readSamples, `${label} sampled pins`).toBeGreaterThan(0);
    }
  });
});
