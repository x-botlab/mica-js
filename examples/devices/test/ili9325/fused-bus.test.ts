import { expect, it } from 'vitest';
import { types } from '@mica-js/sdk/model';
import type { JitInstructionBuilder } from '@mica-js/sdk/model';
import type { JitTranslate } from '@mica-js/sdk/device';
import { createFusedBoard } from './fused-harness';

type Drives = Readonly<Record<string, 0 | 1 | null>>;
const bus = (value: number | null): Drives =>
  Object.fromEntries(
    Array.from({ length: 16 }, (_, bit) => [
      `PC${bit}`,
      value === null ? null : (((value >> bit) & 1) as 0 | 1),
    ]),
  );

function waveform(
  steps: readonly Drives[],
  read?: (pc: number, b: JitInstructionBuilder) => void,
): JitTranslate {
  return ({ pc }, builder) => {
    builder.instruction({ pc, nextPc: pc + 1 }, (b) => {
      for (const [pin, level] of Object.entries(steps[pc] ?? {})) {
        b.writeIntent(
          pin,
          level === null
            ? b.combineIntents()
            : b.resistor(level ? 'VDD1' : 'VSS1', b.constant(types.number, 25)),
        );
      }
      read?.(pc, b);
      b.elapse(b.constant(types.number, pc < steps.length ? 1 : 1_000_000));
    });
    return builder.finish();
  };
}

it('latches WR after atomic control/data updates, ignoring repeats and deselection', async () => {
  const joint = await createFusedBoard({
    firmware: new Uint8Array(8),
    translate: waveform([
      { ...bus(3), PB5: 0, PB8: 0, PB9: 1, PA8: 1 },
      { PB5: 1, PB9: 0 }, // WR precedes CS: latch must use the final CS value.
      { ...bus(0x1030), PB5: 0 },
      { PB5: 1, PB8: 1 }, // Likewise, latch uses the new RS value.
      { ...bus(0x7777), PB5: 1 }, // Reassigning high is not another edge.
      { PB5: 0, PB9: 1 },
      { PB5: 1 }, // Deselected rise must not write.
    ]),
  });
  try {
    joint.board.runUntil(0);
    joint.advanceTo(100);
    const regs = joint.lcd.memories.get('regs')!;
    expect(new DataView(regs.buffer).getUint16(6, true)).toBe(0x1030);
    expect(joint.lcd.states.get('index')).toBe(3);
    expect(joint.mcu.states.get('fusedWrites')).toBe(2);
    expect(joint.mcu.states.get('fusedWrChanges')).toBe(6);
  } finally {
    joint.dispose();
  }
});

it('drives the LCD ID through internal GPIO samples and releases it when RD rises', async () => {
  const joint = await createFusedBoard({
    firmware: new Uint8Array(8),
    translate: waveform(
      [{ ...bus(null), PB5: 0, PB8: 1, PB9: 0, PA8: 1 }, { PA8: 0 }, {}, { PA8: 1 }, {}],
      (pc, b) => {
        if (pc !== 2 && pc !== 4) return;
        for (const bit of [3, 4]) {
          const high = b.equal(
            types.logic,
            b.field(b.readSample(`PC${bit}`), 'level'),
            b.constant(types.logic, types.logic.members.high),
          );
          b.writeState(
            `r${bit}`,
            b.select(
              types.number,
              high,
              (yes) => yes.constant(types.number, 1),
              (no) => no.constant(types.number, 0),
            ),
          );
        }
      },
    ),
  });
  try {
    joint.board.runUntil(0);
    joint.advanceTo(3);
    expect(joint.mcu.states.get('fusedReadValue')).toBe(0x9325);
    expect(joint.mcu.states.get('r3')).toBe((0x9325 >> 3) & 1);
    expect(joint.mcu.states.get('r4')).toBe((0x9325 >> 4) & 1);
    joint.advanceTo(100);
    expect(joint.mcu.states.get('fusedReading')).toBe(false);
    expect(joint.mcu.states.get('r3')).toBe(0);
    expect(joint.mcu.states.get('r4')).toBe(0);
  } finally {
    joint.dispose();
  }
});
