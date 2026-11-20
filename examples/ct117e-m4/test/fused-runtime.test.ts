import { expect, it } from 'vitest';
import { loadFirmware } from './firmware';
import { createHarness, CT117E_M4_END_TIME_PS, CT117E_M4_EXPECTED, digest } from './harness';

// Captured from the independent MCU/LCD oracle, not from the fused host under test.
const ORACLE_FRAME_HASHES = [
  'c47632a24e3c5582d6f26b39769606e406ebf64f3553f90bfa24579a20e7db82',
  '3c3fc9b585c72a29beaf0a4a562c281fe20d9609e9680e00adfa4a92cda9ca0a',
  'a347ab017013ff00be77945cf5263ffdcd859d761a55b2e5127165ee8eb49cb7',
];
const ORACLE_GRAM_HASH = '0de1cda765da66060420faed78e9359a841f6123948f12090e2bb134d729f1da';

it('融合宿主用原始 HEX 一步运行到 440 ms，按序交付三帧及整屏快照', async () => {
  const { hex } = loadFirmware();
  const harness = await createHarness({ hex, stepPs: CT117E_M4_END_TIME_PS });
  try {
    await harness.runtime.step();
    expect(harness.runtime.getState()).toEqual({
      status: 'paused',
      simTime: CT117E_M4_END_TIME_PS,
    });
    expect(harness.diagnostics).toEqual([]);
    expect(harness.errors).toEqual([]);
    expect(harness.faults).toEqual([]);
    expect(harness.workload()).toMatchObject(CT117E_M4_EXPECTED.final);
    expect(harness.deliveryTimes).toEqual(Array<number>(3).fill(CT117E_M4_END_TIME_PS));
    expect(harness.frames.map(digest)).toEqual(ORACLE_FRAME_HASHES);
    expect(digest((await harness.framebuffer()).subarray(8))).toBe(ORACLE_GRAM_HASH);
  } finally {
    await harness.dispose();
  }
}, 900_000);
