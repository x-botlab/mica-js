/**
 * Translation tests for the teaching MCU block decoder.
 *
 * The provider translates exactly one guest basic block per artifact: decoding
 * stops at the first terminator, and every successor leaves through the
 * dispatch cache. Closing guest loops on the host side is the JIT region
 * compiler's job (see `region-performance.test.ts`), so these tests pin the
 * decoded block shape — instructions, terminator, successors, peripheral sync —
 * and check that a loop still retires correctly across dispatched blocks.
 */
import { describe, expect, it } from 'vitest';
import { createTeachingMCUIR, type TeachingMCUISAType } from './index';
import { decodeGuestBlock } from './teaching-mcu';
import {
  Cond,
  createStandalone,
  encodeB,
  encodeI,
  encodeR,
  loopFirmware,
  Op,
  wordsToBytes,
} from './teaching-mcu.test-helpers';

const LEGACY_FIRMWARE = Uint8Array.from([0x10, 1, 0x10, 2, 0x30, 8, 0x00, 0x00, 0x10, 4, 0x20, 0]);

function blockOf(
  firmware: Uint8Array,
  pc: number,
  isa: TeachingMCUISAType,
  maxInstructions = 4096,
) {
  return decodeGuestBlock(firmware, pc, maxInstructions, isa);
}

describe('block translation', () => {
  it('decodes one guest basic block per dispatch', () => {
    const block = blockOf(loopFirmware(50), 0, 'm3');
    // MOVI, MOVI, ADDI, CMP, BNE — the branch ends the block.
    expect(block.pc).toBe(0);
    expect(block.instructions.map((instruction) => instruction.pc)).toEqual([0, 4, 8, 12, 16]);
    expect(block.terminator).toBe('branch');
    // The loop target is another block, so this one dispatches after the branch.
    expect(block.takenPc).toBe(8);
    expect(block.fallthroughPc).toBe(20);
    expect(block.mayStop).toBe(false);
    // No store in this guest block, so no peripheral sync is needed.
    expect(block.syncAfterBlock).toBe(false);
  });

  it('starts at the requested pc and ends at the first terminator', () => {
    // The decoder receives the instruction slice that starts at `pc`, exactly
    // like the provider hands it a flash window.
    const block = blockOf(loopFirmware(50).subarray(8), 8, 'm3');
    expect(block.instructions.map((instruction) => instruction.pc)).toEqual([8, 12, 16]);
    expect(block.terminator).toBe('branch');
    // A backward branch inside the block becomes the self-loop of the artifact.
    expect(block.takenPc).toBe(block.pc);
    expect(block.fallthroughPc).toBe(20);
  });

  it('stops at the decode budget when no terminator appears', () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 0, 0, 1),
      encodeI(Op.MOVI, 0, 0, 2),
      encodeI(Op.MOVI, 0, 0, 3),
    ]);
    const block = blockOf(firmware, 0, 'm3', 2);
    expect(block.instructions).toHaveLength(2);
    expect(block.terminator).toBe('fallthrough');
    expect(block.fallthroughPc).toBe(8);
  });

  it('decodes the teaching ISA loop', () => {
    const block = blockOf(LEGACY_FIRMWARE, 0, 'teaching');
    // TADD, TADD, TJNZ — the folded teaching "block" rule is unchanged.
    expect(block.instructions).toHaveLength(3);
    expect(block.terminator).toBe('branch');
    expect(block.takenPc).toBe(8);
    expect(block.fallthroughPc).toBe(6);
    // Teaching blocks always publish `r0 & 1` to the GPIO port.
    expect(block.syncAfterBlock).toBe(true);
  });

  it('marks a block with MMIO stores for the peripheral sync', () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 0, 0, 1),
      encodeI(Op.MOVT, 0, 0, 0x4001),
      encodeI(Op.STR, 0, 0, 0x0c),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    expect(blockOf(firmware, 0, 'm3').syncAfterBlock).toBe(true);
  });

  it('decodes a halt block without successors', () => {
    const firmware = wordsToBytes([encodeR(Op.HALT, 0, 0, 0)]);
    const block = blockOf(firmware, 0, 'm3');
    expect(block.terminator).toBe('halt');
    expect(block.mayStop).toBe(true);
    expect(block.takenPc).toBe(4);
  });

  it('reports a fault block for an empty slice', () => {
    const block = blockOf(new Uint8Array(0), 0x100, 'm3');
    expect(block.instructions).toHaveLength(0);
    expect(block.terminator).toBe('fault');
    expect(block.mayStop).toBe(true);
  });

  it('runs a guest loop across dispatched blocks', () => {
    const device = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware: loopFirmware(50),
      ports: ['A'],
      portWidth: 1,
      instructionsPerTick: 10_000,
    });
    const { accessor } = createStandalone(device);
    accessor.step(1);
    expect(accessor.readRegister('r1')).toBe(50n);
    expect(accessor.readRegister('r2')).toBe(50n);
    // The loop falls through to the HALT at 0x14, which retires to 0x18.
    expect(accessor.getPC()).toBe(24);
    expect(accessor.isHalted()).toBe(true);
  });

  it('keeps a conditional branch inside one block', () => {
    // SUBS r2, r2, #1 then BNE back to the SUBS: one artifact, one self-loop.
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 2, 0, 3),
      encodeR(Op.SUBS, 2, 2, 1),
      encodeB(Cond.NE, -2),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const block = blockOf(firmware.subarray(4), 4, 'm3');
    expect(block.terminator).toBe('branch');
    expect(block.takenPc).toBe(4);
    expect(block.fallthroughPc).toBe(12);
  });
});
