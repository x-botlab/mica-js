/**
 * Guest firmware for the M3 DBT benchmark.
 *
 * The image is a ring of `blockCount` basic blocks, each exactly eight guest
 * instructions long. Every block ends with `CMP rd, rd` (Z=1) followed by
 * `BEQ next`, so the taken path is deterministic while still exercising the
 * NZCV flags. A separate in-block mix of ALU and RAM traffic gives the
 * translator something representative to lower.
 */
import { Assembler } from './asm';
import { Cond } from './isa';

/** The emitted block body always contains this many instructions. */
export const BLOCK_INSTRUCTIONS = 8;

/** Size of one block in bytes (fixed-width 32-bit instructions). */
export const BLOCK_BYTES = BLOCK_INSTRUCTIONS * 4;

export interface FirmwareImage {
  readonly bytes: Uint8Array;
  readonly blockCount: number;
  readonly blockInstructions: number;
  readonly entryPc: number;
  readonly blockPcs: readonly number[];
  /** Guest instructions in one lap around the ring. */
  readonly loopInstructions: number;
}

/**
 * Build a ring of `blockCount` basic blocks. Block `i` ends with a conditional
 * branch to block `i + 1` (mod `blockCount`), so executing the whole image is
 * an unbounded guest loop driven by tail dispatches between translated blocks.
 */
export function buildRingFirmware(blockCount = 16): FirmwareImage {
  if (!Number.isInteger(blockCount) || blockCount < 2 || blockCount > 64) {
    throw new Error('M3 benchmark blockCount must be an integer in [2, 64]');
  }
  const assembler = new Assembler();
  const labels = Array.from({ length: blockCount }, (_, index) => `block${index}`);
  for (let index = 0; index < blockCount; index += 1) {
    assembler.label(labels[index]!);
    emitBlock(assembler, index, labels[(index + 1) % blockCount]!);
  }
  const program = assembler.finish();
  return {
    bytes: program.bytes,
    blockCount,
    blockInstructions: BLOCK_INSTRUCTIONS,
    entryPc: 0,
    blockPcs: Object.freeze(labels.map((_, index) => index * BLOCK_BYTES)),
    loopInstructions: blockCount * BLOCK_INSTRUCTIONS,
  };
}

function emitBlock(assembler: Assembler, index: number, next: string): void {
  const left = index % 10;
  const right = (index + 3) % 10;
  const accumulator = (index + 1) % 10;
  const mix = (index + 5) % 10;
  const address = index * 8;

  assembler
    .add(left, left, right)
    .eor(accumulator, accumulator, mix)
    .ldr(11, 15, address)
    .mul(12, 11, left)
    .str(12, 15, address + 4);

  switch (index % 6) {
    case 0:
      assembler.lsl(4, 4, 13);
      break;
    case 1:
      assembler.asr(5, 5, 13);
      break;
    case 2:
      assembler.and(6, 6, 7);
      break;
    case 3:
      assembler.orr(8, 8, 9);
      break;
    case 4:
      assembler.sub(2, 2, 3);
      break;
    default:
      assembler.addi(1, 1, 0x20);
      break;
  }

  assembler.cmp(12, 12).b(next, Cond.EQ);
}
