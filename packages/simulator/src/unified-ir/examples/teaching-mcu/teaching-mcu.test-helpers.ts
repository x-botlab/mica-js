/**
 * Test helpers for the unified teaching MCU: M3-class instruction encoding,
 * small firmware builders and a JavaScript reference model of the legacy
 * teaching ISA used by the parity tests.
 */
import { createIRJIT } from '@mica-js/ir';
import type { IRExecutionContext } from '@mica-js/ir';
import type { TeachingMCUAccessor, IRDevice as TeachingMCUIRDevice } from './index';

/** M3-class guest opcodes mirrored from `packages/ir/bench/m3/isa.ts`. */
export const Op = Object.freeze({
  HALT: 0,
  MOVI: 1,
  MOVT: 2,
  ADD: 3,
  SUB: 4,
  AND: 5,
  ORR: 6,
  EOR: 7,
  LSL: 8,
  LSR: 9,
  ASR: 10,
  MUL: 11,
  ADDI: 12,
  SUBI: 13,
  CMP: 14,
  CMPI: 15,
  ADDS: 16,
  SUBS: 17,
  LDR: 18,
  STR: 19,
  LDRB: 20,
  STRB: 21,
  B: 22,
  BL: 23,
  BX: 24,
  WFI: 25,
  NOP: 26,
} as const);

export const Cond = Object.freeze({
  EQ: 0,
  NE: 1,
  CS: 2,
  CC: 3,
  MI: 4,
  PL: 5,
  VS: 6,
  VC: 7,
  HI: 8,
  LS: 9,
  GE: 10,
  LT: 11,
  GT: 12,
  LE: 13,
  AL: 14,
} as const);

export function encodeR(op: number, rd: number, rn: number, rm: number): number {
  return (((op & 0x3f) << 26) | ((rd & 0xf) << 22) | ((rn & 0xf) << 18) | ((rm & 0xf) << 14)) >>> 0;
}

export function encodeI(op: number, rd: number, rn: number, imm16: number): number {
  return (((op & 0x3f) << 26) | ((rd & 0xf) << 22) | ((rn & 0xf) << 18) | (imm16 & 0xffff)) >>> 0;
}

export function encodeB(cond: number, displacementWords: number): number {
  return ((Op.B << 26) | ((cond & 0xf) << 22) | (displacementWords & 0x3f_ffff)) >>> 0;
}

export function wordsToBytes(words: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word >>> 0, true));
  return bytes;
}

export function wordCount(bytes: Uint8Array): number {
  return Math.floor(bytes.byteLength / 4);
}

/** A countdown-style loop that exercises ALU, flags and a conditional branch. */
export function loopFirmware(iterations: number): Uint8Array {
  return wordsToBytes([
    encodeI(Op.MOVI, 1, 0, 0),
    encodeI(Op.MOVI, 2, 0, iterations & 0xffff),
    encodeI(Op.ADDI, 1, 1, 1),
    encodeR(Op.CMP, 0, 1, 2),
    encodeB(Cond.NE, -3),
    encodeR(Op.HALT, 0, 0, 0),
  ]);
}

/** A firmware image with a vector table, a main program and one IRQ handler. */
export function interruptFirmware(
  options: {
    readonly mainPc?: number;
    readonly handlerPc?: number;
    readonly irq?: number;
  } = {},
): Uint8Array {
  const mainPc = options.mainPc ?? 0x80;
  const handlerPc = options.handlerPc ?? 0x100;
  const irq = options.irq ?? 0;
  const words = new Array<number>(Math.ceil(0x104 / 4) + 4).fill(0);
  words[16 + irq] = handlerPc;
  words[mainPc / 4] = encodeR(Op.HALT, 0, 0, 0);
  words[handlerPc / 4] = encodeI(Op.MOVI, 0, 0, 7);
  words[handlerPc / 4 + 1] = encodeR(Op.BX, 0, 14, 0);
  return wordsToBytes(words);
}

export interface StandaloneRuntime {
  readonly jit: ReturnType<typeof createIRJIT>;
  readonly accessor: TeachingMCUAccessor;
  readonly context: IRExecutionContext;
}

/** Creates a standalone JIT instance and accessor for one device. */
export function createStandalone(device: TeachingMCUIRDevice): StandaloneRuntime {
  const jit = createIRJIT(device.module, {
    validation: device.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
  const context: IRExecutionContext = Object.freeze({
    instanceId: device.id,
    virtualTime: 0,
  });
  jit.execute(device.layout.entries.initialize, [], context);
  const accessor = device.buildAccessor(jit.storage, {
    step: () => jit.execute(device.layout.entries.tick, [], context),
  });
  return { jit, accessor, context };
}

export interface TeachingReferenceState {
  readonly r0: number;
  readonly pc: number;
  readonly gpio: boolean;
  readonly halted: boolean;
  readonly faulted: boolean;
}

/**
 * JavaScript model of the original teaching device, including its
 * "consecutive ADD instructions form one block" decode rule.
 */
export function runTeachingReference(firmware: Uint8Array, blocks: number): TeachingReferenceState {
  let r0 = 0;
  let pc = 0;
  let halted = false;
  let faulted = false;
  let gpio = false;
  for (let block = 0; block < blocks && !halted; block += 1) {
    for (;;) {
      if (pc < 0 || pc % 2 !== 0 || pc + 2 > firmware.byteLength) {
        faulted = true;
        halted = true;
        break;
      }
      const opcode = firmware[pc] as number;
      const operand = firmware[pc + 1] as number;
      if (opcode === 0x10) {
        r0 = (r0 + operand) >>> 0;
        pc += 2;
        continue;
      }
      if (opcode === 0x20) {
        pc = operand;
        break;
      }
      if (opcode === 0x30) {
        pc = r0 !== 0 ? operand : pc + 2;
        break;
      }
      if (opcode === 0x00) {
        halted = true;
        break;
      }
      faulted = true;
      halted = true;
      break;
    }
    gpio = (r0 & 1) !== 0;
  }
  return Object.freeze({ r0, pc, gpio, halted, faulted });
}
