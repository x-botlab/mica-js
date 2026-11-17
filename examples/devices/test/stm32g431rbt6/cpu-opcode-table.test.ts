import { describe, expect, it } from 'vitest';
import { decode } from '@mica-js/stm32g431rbt6-core/decode';
import { codeOf } from './cpu-rig';

interface Row {
  readonly name: string;
  readonly bytes: readonly number[];
  readonly size: 2 | 4;
  readonly endsBatch: boolean;
  readonly mayService?: boolean;
}

/**
 * 明确的 opcode 支持表：每一行都必须被译码器识别为指定长度与批处理语义。
 * 这不是完整 ARM 编码表，而是「本模拟器实际支持/明确 fault」的回归清单。
 */
const SUPPORTED: readonly Row[] = [
  // Thumb-16
  { name: 'nop', bytes: [0x00, 0xbf], size: 2, endsBatch: false },
  { name: 'it eq', bytes: [0x08, 0xbf], size: 2, endsBatch: false },
  { name: 'lsls r0,r1,#1', bytes: [0x48, 0x00], size: 2, endsBatch: false },
  { name: 'adds r0,r1,r2', bytes: [0x88, 0x18], size: 2, endsBatch: false },
  { name: 'movs r0,#1', bytes: [0x01, 0x20], size: 2, endsBatch: false },
  { name: 'cmp r0,#1', bytes: [0x01, 0x28], size: 2, endsBatch: false },
  { name: 'ands r0,r1', bytes: [0x08, 0x40], size: 2, endsBatch: false },
  { name: 'bx lr', bytes: [0x70, 0x47], size: 2, endsBatch: true },
  { name: 'ldr r0,[pc,#4]', bytes: [0x01, 0x48], size: 2, endsBatch: false },
  { name: 'str r0,[r1,#4]', bytes: [0x48, 0x60], size: 2, endsBatch: false },
  { name: 'add r0,sp,#4', bytes: [0x01, 0xa8], size: 2, endsBatch: false },
  { name: 'sxth r0,r1', bytes: [0x08, 0xb2], size: 2, endsBatch: false },
  { name: 'rev r0,r1', bytes: [0x08, 0xba], size: 2, endsBatch: false },
  { name: 'push {r0}', bytes: [0x01, 0xb4], size: 2, endsBatch: false },
  { name: 'pop {r0}', bytes: [0x01, 0xbc], size: 2, endsBatch: false },
  { name: 'pop {pc}', bytes: [0x00, 0xbd], size: 2, endsBatch: true },
  { name: 'ldm r0!,{r1}', bytes: [0x02, 0xc8], size: 2, endsBatch: true },
  { name: 'b .', bytes: [0xfe, 0xe7], size: 2, endsBatch: true },
  { name: 'bne .', bytes: [0xfe, 0xd1], size: 2, endsBatch: true },
  { name: 'svc', bytes: [0x00, 0xdf], size: 2, endsBatch: true },
  { name: 'udf', bytes: [0x00, 0xde], size: 2, endsBatch: true },
  { name: 'bkpt', bytes: [0x00, 0xbe], size: 2, endsBatch: true },
  { name: 'cpsid i', bytes: [0x72, 0xb6], size: 2, endsBatch: false, mayService: true },
  { name: 'cpsid f', bytes: [0x71, 0xb6], size: 2, endsBatch: false, mayService: true },
  { name: 'wfi', bytes: [0x30, 0xbf], size: 2, endsBatch: true },
  { name: 'wfe', bytes: [0x20, 0xbf], size: 2, endsBatch: true },
  { name: 'sev', bytes: [0x40, 0xbf], size: 2, endsBatch: false },
  { name: 'yield', bytes: [0x10, 0xbf], size: 2, endsBatch: false },

  // Thumb-2
  { name: 'bl', bytes: [0x00, 0xf0, 0x00, 0xf8], size: 4, endsBatch: true },
  { name: 'b.w', bytes: [0x00, 0xf0, 0x00, 0xb8], size: 4, endsBatch: true },
  { name: 'movw r0,#0', bytes: [0x40, 0xf2, 0x00, 0x00], size: 4, endsBatch: false },
  { name: 'addw r0,r1,#1', bytes: [0x01, 0xf2, 0x01, 0x00], size: 4, endsBatch: false },
  { name: 'lsl.w r0,r1,r2', bytes: [0x01, 0xfa, 0x02, 0xf0], size: 4, endsBatch: false },
  { name: 'clz r0,r1', bytes: [0xb1, 0xfa, 0x81, 0xf0], size: 4, endsBatch: false },
  { name: 'sdiv r0,r1,r2', bytes: [0x91, 0xfb, 0xf2, 0xf0], size: 4, endsBatch: false },
  { name: 'mrs r0,apsr', bytes: [0xef, 0xf3, 0x00, 0x80], size: 4, endsBatch: false },
  { name: 'msr primask,r0', bytes: [0x80, 0xf3, 0x10, 0x88], size: 4, endsBatch: false, mayService: true },
  { name: 'dmb sy', bytes: [0xbf, 0xf3, 0x5f, 0x8f], size: 4, endsBatch: false },
  { name: 'ldr.w r0,[r1]', bytes: [0xd1, 0xf8, 0x00, 0x00], size: 4, endsBatch: false, mayService: true },
  { name: 'str.w r0,[r1,#-4]', bytes: [0x41, 0xf8, 0x04, 0x0c], size: 4, endsBatch: false, mayService: true },
  { name: 'pop.w {r0,pc}', bytes: [0xbd, 0xe8, 0x01, 0x80], size: 4, endsBatch: true },
  { name: 'ldrd r0,r1,[r2,#8]', bytes: [0xd2, 0xe9, 0x02, 0x01], size: 4, endsBatch: false },
  { name: 'strex r0,r2,[r1]', bytes: [0x41, 0xe8, 0x00, 0x20], size: 4, endsBatch: false },
  { name: 'tbb [r0,r1]', bytes: [0xd0, 0xe8, 0x01, 0xf0], size: 4, endsBatch: true },
  { name: 'qadd r0,r1,r2', bytes: [0x82, 0xfa, 0x81, 0xf0], size: 4, endsBatch: false },
  { name: 'ssat r0,#8,r1', bytes: [0x01, 0xf3, 0x07, 0x00], size: 4, endsBatch: false },
  { name: 'smlad r0,r1,r2,r3', bytes: [0x21, 0xfb, 0x02, 0x30], size: 4, endsBatch: false },
];

const FAULTS: readonly Row[] = [
  { name: '0xb7xx reserved', bytes: [0x00, 0xb7], size: 2, endsBatch: true },
  { name: 'setend', bytes: [0x50, 0xb6], size: 2, endsBatch: true },
  { name: '0xb663 reserved', bytes: [0x63, 0xb6], size: 2, endsBatch: true },
  { name: 'vldr', bytes: [0x90, 0xed, 0x00, 0x0a], size: 4, endsBatch: true },
  { name: 'mrs reserved sysm', bytes: [0xef, 0xf3, 0x12, 0x80], size: 4, endsBatch: true },
  { name: 'unallocated 0xffffffff', bytes: [0xff, 0xff, 0xff, 0xff], size: 4, endsBatch: true },
];

function check(row: Row): void {
  const code = codeOf(row.bytes);
  const instruction = decode(code, 0, undefined, code.byteLength);

  expect(instruction.size, `${row.name} size`).toBe(row.size);
  expect(instruction.endsBatch, `${row.name} endsBatch`).toBe(row.endsBatch);
  if (row.mayService !== undefined)
    expect(instruction.mayService, `${row.name} mayService`).toBe(row.mayService);
}

describe('CPU opcode 支持表', () => {
  it('已支持编码的长度与批处理/服务分类', () => {
    for (const row of SUPPORTED) check(row);
  });

  it('明确 fault 的编码终止批次，不会静默穿透', () => {
    for (const row of FAULTS) check(row);
  });
});
