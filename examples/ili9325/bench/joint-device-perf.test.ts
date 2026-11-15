import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createJointBoard,
  gramMatchesOracle,
  nonZeroGramPixels,
  sameBytes,
  JOINT_440MS_EXPECTED,
  JOINT_FULL_FRAME_PIXELS,
  type JointBoard,
} from '../test/joint-harness';

const enabled = process.env.MICA_DEVICE_PERF === '1';
const rounds = Number(process.env.MICA_DEVICE_ROUNDS ?? 3);
const cpuMs = (start: ReturnType<typeof process.cpuUsage>) => {
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1000;
};
function validate(joint: JointBoard) {
  const lcd = joint.lcd as unknown as {
    sampleResources: Map<string, { version: number }>;
    memoryResources: Map<string, { version: number }>;
  };
  expect(joint.board.time).toBe(440_000_000_000);
  expect(joint.board.status).toBe('ready');
  expect(joint.errors).toEqual([]);
  expect(joint.faults).toEqual([]);
  expect(lcd.sampleResources.get('WR')!.version).toBe(545_004);
  expect(lcd.memoryResources.get('gram')!.version).toBe(272_007);
  expect(nonZeroGramPixels(joint.lcd.memories.get('gram')!)).toBe(76_800);
  expect(joint.frames).toHaveLength(10);
  expect(joint.frames.every((frame, index) => sameBytes(frame, joint.expectedFrames[index]!))).toBe(
    true,
  );
}
const digest = (joint: JointBoard) =>
  createHash('sha256')
    .update(joint.lcd.memories.get('gram')!)
    .update(Buffer.concat(joint.frames))
    .digest('hex');

it.skipIf(!enabled)(
  'device optimization: complete-edge post window and independent oracle',
  async () => {
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10)
      throw new Error('Invalid rounds');
    const readings = [];
    const digests: string[] = [];
    (await createJointBoard()).dispose();
    for (let round = 1; round <= rounds; round++) {
      const joint = await createJointBoard();
      try {
        joint.board.runUntil(0);
        joint.advanceTo(220_000_000_000);
        expect(joint.frames).toHaveLength(5);
        const jit = (
          joint.board as unknown as {
            jits: { directStats: { directCompiles: number; directFallbacks: number } }[];
          }
        ).jits[0]!;
        const before = { ...jit.directStats };
        const cpu = process.cpuUsage();
        const wall = performance.now();
        joint.advanceTo(440_000_000_000);
        const postMs = cpuMs(cpu);
        const wallMs = performance.now() - wall;
        validate(joint);
        expect(joint.readAccounting()).toBeUndefined();
        digests.push(digest(joint));
        readings.push({
          round,
          postMs,
          wallMs,
          realtime: 220 / postMs,
          compiles: jit.directStats.directCompiles - before.directCompiles,
          fallbacks: jit.directStats.directFallbacks - before.directFallbacks,
        });
      } finally {
        joint.dispose();
      }
    }
    const oracle = await createJointBoard({ accounting: true });
    try {
      oracle.board.runUntil(0);
      oracle.advanceTo(440_000_000_000);
      validate(oracle);
      const accounting = oracle.readAccounting()!;
      expect(accounting.wrLevelChanges).toBe(545_004);
      expect(accounting.wrSamples).toBe(accounting.wrLevelChanges);
      expect(accounting.csSamples).toBe(accounting.csLevelChanges);
      expect(accounting.rsSamples).toBe(accounting.rsLevelChanges);
      expect(accounting.pixelWrites).toBe(272_007);
      expect(accounting.oracleGramStores).toBe(272_007);
      expect(gramMatchesOracle(oracle.lcd.memories.get('gram')!, accounting.oracleGram)).toBe(true);
      expect(
        oracle.frames.every((frame, index) => sameBytes(frame, accounting.oracleFrames[index]!)),
      ).toBe(true);
      expect(
        accounting.fullScreenFills.filter(
          (fill) =>
            fill.uniform &&
            fill.pixels === JOINT_FULL_FRAME_PIXELS &&
            fill.value === JOINT_440MS_EXPECTED.clearColor,
        ),
      ).toHaveLength(3);
      expect(digests.every((value) => value === digest(oracle))).toBe(true);
      const internal = oracle.lcd as unknown as {
        reactions: {
          declaration: { name: string };
          synchronousProgram?: {
            source: string;
            functions: readonly string[];
          } | null;
        }[];
      };
      const generated = internal.reactions.map((reaction) => ({
        name: reaction.declaration.name,
        synchronous: reaction.synchronousProgram != null,
        sourceBytes: reaction.synchronousProgram?.source.length,
        genericReads: reaction.synchronousProgram?.source.match(/host\.read\(/g)?.length ?? 0,
        functions: reaction.synchronousProgram?.functions,
      }));
      const jit = (
        oracle.board as unknown as { jits: { direct?: { program: { emitStats?: unknown } } }[] }
      ).jits[0]!;
      const result = {
        case: process.env.MICA_DEVICE_CASE,
        node: process.version,
        readings,
        generated,
        directEmitStats: jit.direct?.program.emitStats,
        digest: digest(oracle),
        wr: accounting.wrLevelChanges,
        stores: accounting.oracleGramStores,
        frames: oracle.frames.length,
      };
      writeFileSync(
        join(process.env.MICA_DEVICE_REPORT!, `${process.env.MICA_DEVICE_CASE}.json`),
        JSON.stringify(result, null, 2),
      );
      process.stdout.write(`DEVICE_PERF ${JSON.stringify(result)}\n`);
    } finally {
      oracle.dispose();
    }
  },
  900_000,
);
