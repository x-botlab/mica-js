/**
 * Translation tests for the teaching MCU superblock translator.
 *
 * The translator turns one decoded window into a *unit*: guest basic blocks
 * inside the window become IR blocks, so a branch back into the window is a
 * plain IR loop instead of another provider dispatch. These tests pin the unit
 * shape, the fallback path (`superblock: false`, `MICA_DISABLE_SUPERBLOCK=1`)
 * and the instruction-for-instruction parity of both paths.
 */
import { createIRJIT } from '@mica-js/ir';
import type { IRExecutionContext } from '@mica-js/ir';
import { afterEach, describe, expect, it } from 'vitest';
import { createTeachingMCUIR, type TeachingMCUISAType } from './index';
import { decodeGuestProgram } from './teaching-mcu';
import {
  Cond,
  Op,
  encodeB,
  encodeI,
  encodeR,
  loopFirmware,
  wordsToBytes,
} from './teaching-mcu.test-helpers';

const LEGACY_FIRMWARE = Uint8Array.from([0x10, 1, 0x10, 2, 0x30, 8, 0x00, 0x00, 0x10, 4, 0x20, 0]);

function windowOf(firmware: Uint8Array, pc: number, isa: TeachingMCUISAType, fuse: boolean) {
  return decodeGuestProgram(firmware, pc, 4096, isa, fuse);
}

afterEach(() => {
  delete (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.MICA_DISABLE_SUPERBLOCK;
});

describe('superblock translation', () => {
  it('fuses a guest loop into one unit with an internal back edge', () => {
    const firmware = loopFirmware(50);
    const program = windowOf(firmware, 0, 'm3', true);
    // setup (MOVI, MOVI) | loop body (ADDI, CMP, Bcc) | HALT
    expect(program.nodes.map((node) => node.pc)).toEqual([0, 8, 20]);
    const [setup, body, halt] = program.nodes;
    expect(setup!.terminator).toBe('fallthrough');
    expect(setup!.checksSlice).toBe(false);
    expect(body!.terminator).toBe('branch');
    expect(body!.checksSlice).toBe(true);
    // The conditional branch target (0x8) is inside the window: a real back edge.
    expect(program.byPc.get(body!.takenPc)).toBe(1);
    expect(program.byPc.get(body!.fallthroughPc)).toBe(2);
    expect(halt!.terminator).toBe('halt');
    expect(program.instructionCount).toBe(6);
    expect(program.mayStop).toBe(true);
    // No store in this guest program, so no peripheral sync is needed.
    expect(program.syncAfterBlock).toBe(false);
  });

  it('keeps one unit per dispatch when fusion is disabled', () => {
    const firmware = loopFirmware(50);
    const program = windowOf(firmware, 0, 'm3', false);
    expect(program.nodes).toHaveLength(1);
    const [block] = program.nodes;
    expect(block!.pc).toBe(0);
    expect(block!.instructions).toHaveLength(5);
    expect(block!.terminator).toBe('branch');
    // The branch target is outside the window: the unit ends with a dispatch.
    expect(program.byPc.get(block!.takenPc)).toBeUndefined();
  });

  it('dispatches instead of jumping when the loop target is outside the window', () => {
    const firmware = loopFirmware(50);
    // A four-instruction window starting inside the loop cannot reach 0x8.
    const program = decodeGuestProgram(firmware, 8, 2, 'm3', true);
    expect(program.nodes.map((node) => node.pc)).toEqual([8]);
    expect(program.byPc.get(program.nodes[0]!.takenPc)).toBeUndefined();
  });

  it('decodes the teaching ISA loop with the folded ADD block rule', () => {
    const fused = windowOf(LEGACY_FIRMWARE, 0, 'teaching', true);
    expect(fused.nodes.map((node) => node.pc)).toEqual([0, 6, 8]);
    expect(fused.nodes[0]!.instructions).toHaveLength(3);
    expect(fused.nodes[0]!.terminator).toBe('branch');
    expect(fused.nodes[0]!.takenPc).toBe(8);
    expect(fused.byPc.get(8)).toBe(2);
    // Teaching units always publish `r0 & 1` to the GPIO port.
    expect(fused.syncAfterBlock).toBe(true);

    const plain = windowOf(LEGACY_FIRMWARE, 0, 'teaching', false);
    expect(plain.nodes).toHaveLength(1);
    expect(plain.nodes[0]!.instructions).toHaveLength(3);
  });

  it('marks a program with MMIO stores for the peripheral sync', () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 0, 0, 1),
      encodeI(Op.MOVT, 0, 0, 0x4001),
      encodeI(Op.STR, 0, 0, 0x0c),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    expect(windowOf(firmware, 0, 'm3', true).syncAfterBlock).toBe(true);
  });
});

interface MachineResult {
  readonly cycles: number;
  readonly pc: number;
  readonly registers: readonly number[];
  readonly flags: readonly boolean[];
  readonly halted: boolean;
  readonly faulted: boolean;
}

/** Runs `ticks` ticks of a fresh instance and snapshots the observable state. */
function runMachine(
  isa: TeachingMCUISAType,
  firmware: Uint8Array,
  ticks: number,
  superblock: boolean,
): MachineResult {
  const device = createTeachingMCUIR('mcu', {
    isa,
    firmware,
    ports: ['A'],
    portWidth: 1,
    instructionsPerTick: 8,
    maxBlockInstructions: 8,
    superblock,
  });
  const jit = createIRJIT(device.module, {
    validation: device.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
  const context: IRExecutionContext = { instanceId: 'parity', virtualTime: 0 };
  jit.execute(device.layout.entries.initialize, [], context);
  for (let index = 0; index < ticks; index += 1) {
    jit.execute(device.layout.entries.tick, [], context);
  }
  return {
    cycles: Number(jit.storage.loadState(device.layout.cycles)),
    pc: Number(jit.storage.loadState(device.layout.pc)),
    registers: [0, 1, 2, 3].map((index) =>
      Number(jit.storage.loadArray(device.layout.registers, index)),
    ),
    flags: [
      Boolean(jit.storage.loadState(device.layout.flags.n)),
      Boolean(jit.storage.loadState(device.layout.flags.z)),
      Boolean(jit.storage.loadState(device.layout.flags.c)),
      Boolean(jit.storage.loadState(device.layout.flags.v)),
    ],
    halted: Boolean(jit.storage.loadState(device.layout.halted)),
    faulted: Boolean(jit.storage.loadState(device.layout.fault)),
  };
}

describe('superblock parity', () => {
  const programs: readonly {
    readonly name: string;
    readonly isa: TeachingMCUISAType;
    readonly firmware: Uint8Array;
  }[] = [
    { name: 'countdown loop', isa: 'm3', firmware: loopFirmware(50) },
    {
      name: 'flags and memory',
      isa: 'm3',
      firmware: wordsToBytes([
        encodeI(Op.MOVI, 1, 0, 0x0000),
        encodeI(Op.MOVT, 1, 0, 0x2000),
        encodeI(Op.MOVI, 0, 0, 0),
        encodeI(Op.ADDS, 0, 0, 3),
        encodeI(Op.STR, 0, 1, 0),
        encodeI(Op.LDR, 2, 1, 0),
        encodeR(Op.SUBS, 2, 2, 1),
        encodeB(Cond.NE, -4),
        encodeR(Op.HALT, 0, 0, 0),
      ]),
    },
    { name: 'legacy teaching loop', isa: 'teaching', firmware: LEGACY_FIRMWARE },
  ];

  it.each(programs)('retires identical state for $name', ({ isa, firmware }) => {
    for (const ticks of [1, 2, 3, 7, 40]) {
      expect(runMachine(isa, firmware, ticks, true)).toEqual(
        runMachine(isa, firmware, ticks, false),
      );
    }
  });

  it('honours MICA_DISABLE_SUPERBLOCK', () => {
    const firmware = loopFirmware(50);
    const enabled = runMachine('m3', firmware, 12, true);
    process.env.MICA_DISABLE_SUPERBLOCK = '1';
    const device = createTeachingMCUIR('mcu', { isa: 'm3', firmware });
    expect(device.config.superblock).toBe(false);
    const disabled = runMachine('m3', firmware, 12, false);
    expect(disabled).toEqual(enabled);
    delete process.env.MICA_DISABLE_SUPERBLOCK;
    expect(createTeachingMCUIR('mcu', { isa: 'm3', firmware }).config.superblock).toBe(true);
  });
});
