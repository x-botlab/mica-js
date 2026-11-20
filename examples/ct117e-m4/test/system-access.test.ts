import { readFile } from 'node:fs/promises';
import type { RegionIR } from '@mica-js/sdk/model';
import { expect, it } from 'vitest';
import { createHarness } from './harness';

it('preserves ordered dynamic system accesses in the released MCU model', async () => {
  const hex = await readFile(new URL('./fixtures/system-access.hex', import.meta.url));
  const stepPs = 1_000_000;
  const board = await createHarness({ hex, stepPs });
  try {
    await board.advanceTo(20 * stepPs);
    expect(board.diagnostics).toEqual([]);
    expect(board.errors).toEqual([]);
    expect(board.faults).toEqual([]);

    const ram = board.memory('sram');
    const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    expect(Array.from({ length: 9 }, (_, i) => view.getUint32((i + 1) * 4, true))).toEqual([
      0xe000e01c, // STMIA writeback
      7, // LOAD
      0, // VAL clears on write
      0xe000e01c, // LDMIA writeback
      1, // First narrow CTRL read sees COUNTFLAG
      0, // Second narrow read sees it cleared
      0x7030a000, // Only implemented NVIC priority bits survive
      0xa0,
      0x7030,
    ]);

    const jit = board.instance.jits[0] as {
      readonly cache: ReadonlyMap<number, { readonly body: RegionIR }>;
      readonly direct?: { readonly pcs: ReadonlySet<number> };
    };
    function calls(region: RegionIR): string[] {
      return region.operations.flatMap((op) => {
        if (op.kind === 'call' || op.kind === 'callValue') return [op.name];
        if (op.kind === 'if') return [...calls(op.yes), ...(op.no ? calls(op.no) : [])];
        return [];
      });
    }
    const expected = [
      'mcuReadSystem1',
      'mcuReadSystem2',
      'mcuReadSystem4',
      'mcuWriteSystem1',
      'mcuWriteSystem2',
      'mcuWriteSystem4',
    ];
    const cached = [...jit.cache].map(([pc, { body }]) => ({
      direct: jit.direct?.pcs.has(pc),
      names: calls(body).filter((name) => expected.includes(name)),
    }));
    const names = (entries: typeof cached) =>
      [...new Set(entries.flatMap((entry) => entry.names))].sort();
    expect(names(cached)).toEqual(expected);
    expect(names(cached.filter((entry) => entry.direct))).toEqual(expected);
  } finally {
    await board.dispose();
  }
});
