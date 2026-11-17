import { expect, it } from 'vitest';
import { createFusedBoard } from './fused-harness';
import { createJointBoard, sameBytes } from './joint-harness';

it('single fused instance preserves MCU GPIO initialization and LCD registers', async () => {
  const fused = await createFusedBoard();
  const reference = await createJointBoard({ accounting: true });
  try {
    for (const joint of [fused, reference]) {
      joint.board.runUntil(0);
      joint.advanceTo(200_000_000);
      expect(joint.errors).toEqual([]);
      expect(joint.faults).toEqual([]);
    }
    expect(fused.mcu).toBe(fused.lcd);
    expect((fused.board as unknown as { instances: unknown[] }).instances).toHaveLength(1);
    expect(fused.mcu.states.get('pc')).toBe(reference.mcu.states.get('pc'));
    expect(fused.lcd.states.get('index')).toBe(0x13);
    expect(sameBytes(fused.lcd.memories.get('regs')!, reference.lcd.memories.get('regs')!)).toBe(
      true,
    );
    expect(fused.mcu.states.get('fusedWrChanges')).toBe(reference.readAccounting()!.wrLevelChanges);
    expect(fused.frames).toEqual(reference.frames);
  } finally {
    fused.dispose();
    reference.dispose();
  }
});
