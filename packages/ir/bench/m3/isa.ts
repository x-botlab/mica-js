/**
 * A tiny 32-bit guest ISA for the Cortex-M3 class DBT benchmark.
 *
 * The encoding intentionally mirrors the fixed-width layout described by
 * issue #150: R/I instructions put `op` in `[31:26]`, `rd` in `[25:22]`,
 * `rn` in `[21:18]`, `rm` in `[17:14]` (R) or the immediate in `[15:0]` (I).
 * Branch instructions use `[31:26]` for the opcode, `[25:22]` for the
 * condition and a signed displacement relative to `pc + 4`.
 *
 * The benchmark only executes in-bounds RAM accesses; the decoder is still
 * complete enough to translate the firmware used by the benchmark bodies
 * without special cases.
 */

/** Guest register count (r0–r15). `r15` is a general register, not `pc`. */
export const REGISTER_COUNT = 16;

/** Guest RAM size (256 KiB) and base address. */
export const RAM_SIZE = 256 * 1024;
export const RAM_BASE = 0x2000_0000;

/** Guest opcodes. */
export const Op = {
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
} as const;

/** ARM condition codes 0–14 (AL is 14). */
export const Cond = {
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
} as const;

export interface DecodedInstruction {
  /** Absolute guest pc of this instruction. */
  readonly pc: number;
  readonly word: number;
  readonly op: number;
  readonly rd: number;
  readonly rn: number;
  readonly rm: number;
  readonly imm16: number;
  readonly cond: number;
  /** Sign-extended 22-bit word displacement (B). */
  readonly simm22: number;
  /** Sign-extended 26-bit word displacement (BL). */
  readonly simm26: number;
}

export function encodeR(op: number, rd: number, rn: number, rm: number): number {
  return (((op & 0x3f) << 26) | ((rd & 0xf) << 22) | ((rn & 0xf) << 18) | ((rm & 0xf) << 14)) >>> 0;
}

export function encodeI(op: number, rd: number, rn: number, imm16: number): number {
  return (((op & 0x3f) << 26) | ((rd & 0xf) << 22) | ((rn & 0xf) << 18) | (imm16 & 0xffff)) >>> 0;
}

export function encodeB(cond: number, displacementWords: number): number {
  return ((Op.B << 26) | ((cond & 0xf) << 22) | (displacementWords & 0x3f_ffff)) >>> 0;
}

export function encodeBL(displacementWords: number): number {
  return ((Op.BL << 26) | (displacementWords & 0x3ff_ffff)) >>> 0;
}

export function decodeWord(word: number, pc: number): DecodedInstruction {
  const op = word >>> 26;
  let simm22 = word & 0x3f_ffff;
  if ((simm22 & 0x20_0000) !== 0) simm22 -= 0x40_0000;
  let simm26 = word & 0x3ff_ffff;
  if ((simm26 & 0x200_0000) !== 0) simm26 -= 0x400_0000;
  return {
    pc,
    word,
    op,
    rd: (word >>> 22) & 0xf,
    rn: (word >>> 18) & 0xf,
    rm: (word >>> 14) & 0xf,
    imm16: word & 0xffff,
    cond: (word >>> 22) & 0xf,
    simm22,
    simm26,
  };
}

/** Instruction kinds that end a guest basic block. */
export function isBlockTerminator(op: number): boolean {
  return op === Op.B || op === Op.BL || op === Op.BX || op === Op.HALT;
}

/** Taken branch target in bytes. */
export function branchTarget(instruction: DecodedInstruction): number {
  if (instruction.op === Op.B) return instruction.pc + 4 + instruction.simm22 * 4;
  if (instruction.op === Op.BL) return instruction.pc + 4 + instruction.simm26 * 4;
  throw new Error('branchTarget expects B or BL');
}

/**
 * Decode a guest basic block from an image slice that starts at `pc`.
 * Stops after a B/BL/BX/HALT or after `maxInstructions`.
 */
export function decodeBlock(
  bytes: Uint8Array,
  pc: number,
  maxInstructions: number,
): readonly DecodedInstruction[] {
  const available = Math.floor(bytes.byteLength / 4);
  const count = Math.min(maxInstructions, available);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const instructions: DecodedInstruction[] = [];
  for (let index = 0; index < count; index += 1) {
    const instruction = decodeWord(view.getUint32(index * 4, true), pc + index * 4);
    instructions.push(instruction);
    if (isBlockTerminator(instruction.op)) break;
  }
  return instructions;
}
