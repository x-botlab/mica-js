/**
 * Minimal M3-class instruction encoder used by the teaching-MCU example.
 *
 * A real project compiles C or assembly with an assembler; the example keeps a
 * handful of opcodes inline so it stays self-contained.
 */

/** Guest opcodes, mirrored from the M3-class ISA the device implements. */
export const Op = Object.freeze({
  HALT: 0,
  MOVI: 1,
  MOVT: 2,
  ADDI: 12,
  CMP: 14,
  STR: 19,
  B: 22,
} as const);

/** Condition codes used by `B`. */
export const Cond = Object.freeze({
  NE: 1,
  AL: 14,
} as const);

/** Encodes a three-register instruction. */
export function encodeR(op: number, rd: number, rn: number, rm: number): number {
  return (((op & 0x3f) << 26) | ((rd & 0xf) << 22) | ((rn & 0xf) << 18) | ((rm & 0xf) << 14)) >>> 0;
}

/** Encodes an immediate or load/store instruction. */
export function encodeI(op: number, rd: number, rn: number, imm16: number): number {
  return (((op & 0x3f) << 26) | ((rd & 0xf) << 22) | ((rn & 0xf) << 18) | (imm16 & 0xffff)) >>> 0;
}

/** Encodes a conditional branch; `displacementWords` is relative to the next word. */
export function encodeB(cond: number, displacementWords: number): number {
  return ((Op.B << 26) | ((cond & 0xf) << 22) | (displacementWords & 0x3f_ffff)) >>> 0;
}

/** Packs little-endian instruction words into a flash image. */
export function wordsToBytes(words: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word >>> 0, true));
  return bytes;
}

/**
 * Builds a blinking firmware image driving `PA0` through the GPIO MMIO window.
 *
 * ```text
 * r1 = GPIO base, r2 = delay, r3 = loop counter, r0 = output value
 *
 * on:   ODR = r0 (1)     ; delay loop
 * off:  ODR = r0 (0)     ; delay loop
 *       r0 = 1 ; B on
 * ```
 *
 * @param delayIterations - Loop iterations between toggles; each iteration is
 *   three instructions (`ADDI`, `CMP`, `BNE`).
 */
export function blinkyFirmware(delayIterations = 20): Uint8Array {
  const words: number[] = [];
  const here = (): number => words.length;
  const branchTo = (target: number): number => encodeB(Cond.NE, target - (words.length + 1));

  words.push(encodeI(Op.MOVI, 1, 0, 0x0000));
  words.push(encodeI(Op.MOVT, 1, 0, 0x4000)); // r1 = 0x4000_0000
  words.push(encodeI(Op.MOVI, 0, 0, 0x0001)); // r0 = 1
  words.push(encodeI(Op.STR, 0, 1, 0x04)); // DIR bit 0 = output
  words.push(encodeI(Op.MOVI, 2, 0, delayIterations));

  const on = here();
  words.push(encodeI(Op.MOVI, 3, 0, 0)); // reset the delay counter
  words.push(encodeI(Op.STR, 0, 1, 0x00)); // ODR = 1 -> lamp on
  const onDelay = here();
  words.push(encodeI(Op.ADDI, 3, 3, 1));
  words.push(encodeR(Op.CMP, 0, 3, 2));
  words.push(branchTo(onDelay));

  words.push(encodeI(Op.MOVI, 0, 0, 0)); // r0 = 0
  words.push(encodeI(Op.MOVI, 3, 0, 0));
  words.push(encodeI(Op.STR, 0, 1, 0x00)); // ODR = 0 -> lamp off
  const offDelay = here();
  words.push(encodeI(Op.ADDI, 3, 3, 1));
  words.push(encodeR(Op.CMP, 0, 3, 2));
  words.push(branchTo(offDelay));

  words.push(encodeI(Op.MOVI, 0, 0, 1));
  words.push(encodeB(Cond.AL, on - (words.length + 1)));

  return wordsToBytes(words);
}
