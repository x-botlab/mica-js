import { describe, expect, it } from 'vitest';
import { createSourceHarness, runSource } from './source-harness.ts';

const HALT = [0x80, 0xfe];
const PUSH_PULL_P2 = [0x75, 0x96, 0xff, 0x75, 0x95, 0x00];

describe('source harness', () => {
  it('runs firmware against the source model', async () => {
    const result = await runSource({
      firmware: Uint8Array.from([...PUSH_PULL_P2, 0x75, 0xa0, 0xa5, ...HALT]),
    });

    expect(result.faults).toEqual([]);
    expect(result.ports[2]).toBe(0xa5);
  });

  it('drives an external pin', async () => {
    const harness = await createSourceHarness({
      firmware: Uint8Array.from([0xe5, 0xb0, 0xf5, 0xa0, ...HALT]),
      observe: ['P2_0', 'P2_1'],
      drive: ['P3_0'],
      pullUp: { P3_0: 10_000 },
    });

    try {
      harness.drive('P3_0', 1);
      harness.board.runUntil(1_000_000);
      harness.drive('P3_0', 0);
      harness.board.runUntil(2_000_000);
      expect(harness.faults).toEqual([]);
    } finally {
      harness.dispose();
    }
  });
});
