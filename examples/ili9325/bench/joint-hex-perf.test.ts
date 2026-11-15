import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { expect, it } from 'vitest';
import {
  createJointBoard,
  sameBytes,
  gramMatchesOracle,
  nonZeroGramPixels,
  JOINT_TIME_QUANTUM_PS,
  type JointBoard,
} from '../test/joint-harness';
import { createFusedBoard } from '../test/fused-harness';

const enabled = process.env.MICA_JOINT_HEX === '1';
const topology = process.env.MICA_JOINT_HEX_BASELINE === '1' ? 'discrete' : 'fused';
const createMeasuredBoard = topology === 'fused' ? createFusedBoard : createJointBoard;
const firmwarePath = resolve(import.meta.dirname, '../../stm32g431rbt6/bench/HAL_06_LCD.hex');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Strict Intel HEX input, mapped onto the MCU's Flash image; execution starts from its vector. */
function loadFirmware() {
  let base = 0;
  let eof = false;
  let entry: number | undefined;
  let records = 0;
  const bytes = new Map<number, number>();
  const source = readFileSync(firmwarePath);
  for (const raw of source.toString('ascii').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (eof || !/^:(?:[0-9a-f]{2})+$/i.test(line)) throw new Error('Malformed HEX record');
    const record = Buffer.from(line.slice(1), 'hex');
    const count = record[0]!;
    if (record.length !== count + 5 || record.reduce((a, b) => a + b, 0) % 256 !== 0)
      throw new Error('HEX length/checksum mismatch');
    const offset = record.readUInt16BE(1);
    const kind = record[3];
    const data = record.subarray(4, 4 + count);
    records++;
    if (kind === 0) {
      for (let i = 0; i < count; i++) {
        const at = base + offset + i;
        if (at < 0x08000000 || at >= 0x08020000) throw new Error('HEX data outside MCU Flash');
        if (bytes.has(at) && bytes.get(at) !== data[i]) throw new Error('Conflicting HEX overlap');
        bytes.set(at, data[i]!);
      }
    } else if (kind === 1 && count === 0 && offset === 0) eof = true;
    else if ((kind === 2 || kind === 4) && count === 2 && offset === 0)
      base = data.readUInt16BE() * (kind === 2 ? 16 : 65536);
    else if ((kind === 3 || kind === 5) && count === 4 && offset === 0)
      entry = kind === 5 ? data.readUInt32BE() : data.readUInt16BE(0) * 16 + data.readUInt16BE(2);
    else throw new Error(`Unsupported or malformed HEX record type ${kind}`);
  }
  if (!eof || bytes.size === 0 || !bytes.has(0x08000000)) throw new Error('Incomplete HEX image');
  const end = Math.max(...bytes.keys()) + 1;
  const firmware = new Uint8Array(end - 0x08000000).fill(0xff);
  for (const [at, value] of bytes) firmware[at - 0x08000000] = value;
  return {
    firmware,
    metadata: {
      path: firmwarePath,
      sourceSha256: digest(source),
      imageSha256: digest(firmware),
      base: 0x08000000,
      end,
      bytes: firmware.length,
      dataBytes: bytes.size,
      records,
      entry,
      resetVector: new DataView(firmware.buffer).getUint32(4, true),
    },
  };
}
function snapshot(joint: JointBoard) {
  const lcd = joint.lcd as unknown as {
    sampleResources: Map<string, { version: number }>;
    memoryResources: Map<string, { version: number }>;
  };
  const jit = (
    joint.board as unknown as {
      jits: {
        cache: Map<number, unknown>;
        directStats: {
          directCompiles: number;
          directCalls: number;
          directFallbacks: number;
          directShards: number;
        };
      }[];
    }
  ).jits[0]!;
  let framePixels = 0;
  for (const frame of joint.frames) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const pixels = view.getUint16(4, true) * view.getUint16(6, true);
    expect(frame.byteLength).toBe(8 + pixels * 2);
    framePixels += pixels;
  }
  return {
    // Fused internal WR is a numeric state, not a fictitious electrical sample resource.
    wrChanges: joint.mcu.states.get('fusedWrChanges') ?? lcd.sampleResources.get('WR')!.version,
    gramStores: Number(
      joint.mcu.states.get('fusedGramStores') ?? lcd.memoryResources.get('gram')!.version,
    ),
    frames: joint.frames.length,
    framePixels,
    nonZeroPixels: nonZeroGramPixels(joint.lcd.memories.get('gram')!),
    mcu: Object.fromEntries(
      ['pc', 'halted', 'tickPs', 'tickActive', 'systickLoad', 'systickCount'].map((name) => [
        name,
        joint.mcu.states.get(name),
      ]),
    ),
    jit: { ...jit.directStats, blocks: jit.cache.size },
    instanceCount: (joint.board as unknown as { instances: unknown[] }).instances.length,
  };
}

function cpuState(joint: JointBoard) {
  return {
    states: Object.fromEntries([...joint.mcu.states].filter(([name]) => !name.startsWith('fused'))),
    memories: Object.fromEntries(
      ['code', 'sram', 'ccm', 'periph', 'sys'].map((name) => [
        name,
        digest(joint.mcu.memories.get(name)!),
      ]),
    ),
  };
}

function compareWorkload(
  actual: ReturnType<typeof snapshot>,
  expected: ReturnType<typeof snapshot>,
) {
  for (const key of [
    'wrChanges',
    'gramStores',
    'frames',
    'framePixels',
    'nonZeroPixels',
    'mcu',
  ] as const)
    expect(actual[key], `${topology} ${key}`).toEqual(expected[key]);
  expect(actual.instanceCount).toBe(topology === 'fused' ? 1 : 2);
}
function verify(joint: JointBoard) {
  expect(joint.board.status).toBe('ready');
  expect(joint.errors).toEqual([]);
  expect(joint.faults).toEqual([]);
  expect(joint.frames.length).toBeGreaterThan(0);
  expect(joint.expectedFrames).toHaveLength(joint.frames.length);
  expect(joint.frames.every((frame, i) => sameBytes(frame, joint.expectedFrames[i]!))).toBe(true);
}
const cpuMs = (start: ReturnType<typeof process.cpuUsage>) => {
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1000;
};
const round = (n: number) => Number(n.toFixed(3));

it.skipIf(!enabled || process.env.MICA_JOINT_HEX_LONG === '1')(
  'HAL_06_LCD.hex: fused MCU/LCD, 0→440 ms and independent discrete bus oracle',
  async () => {
    const { firmware, metadata } = loadFirmware();
    const directory = mkdtempSync(join(tmpdir(), `mica-joint-hex-${topology}-`));
    const readings = [];
    const images: string[] = [];
    const frameDigests: string[][] = [];
    const frameTimes: number[][] = [];
    const cpuStates: ReturnType<typeof cpuState>[] = [];
    (await createMeasuredBoard({ firmware })).dispose();
    for (let index = 0; index < 3; index++) {
      const coldCpu = process.cpuUsage();
      const coldWall = performance.now();
      const joint = await createMeasuredBoard({ firmware });
      try {
        joint.board.runUntil(0);
        joint.advanceTo(200_000_000);
        const coldMs = cpuMs(coldCpu),
          coldWallMs = performance.now() - coldWall;
        verifyReady(joint);
        const activeCpu = process.cpuUsage(),
          activeWall = performance.now();
        joint.advanceTo(220_000_000_000);
        const activeMs = cpuMs(activeCpu),
          activeWallMs = performance.now() - activeWall;
        verifyReady(joint);
        const middle = snapshot(joint);
        const postCpu = process.cpuUsage(),
          postWall = performance.now();
        joint.advanceTo(440_000_000_000);
        const postMs = cpuMs(postCpu),
          postWallMs = performance.now() - postWall;
        verify(joint);
        expect(joint.board.time).toBe(440_000_000_000);
        expect(joint.readAccounting()).toBeUndefined();
        const end = snapshot(joint);
        images.push(digest(joint.lcd.memories.get('gram')!));
        frameDigests.push(joint.frames.map(digest));
        frameTimes.push([...joint.frameTimes]);
        // Only compare the original MCU declarations: the fused instance also owns LCD states.
        const state = cpuState(joint);
        cpuStates.push(state);
        readings.push({
          round: index + 1,
          coldMs: round(coldMs),
          activeMs: round(activeMs),
          postMs: round(postMs),
          totalMs: round(coldMs + activeMs + postMs),
          coldWallMs: round(coldWallMs),
          activeWallMs: round(activeWallMs),
          postWallMs: round(postWallMs),
          totalWallMs: round(coldWallMs + activeWallMs + postWallMs),
          activeRealtime: round(219.8 / activeMs),
          postRealtime: round(220 / postMs),
          totalRealtime: round(440 / (coldMs + activeMs + postMs)),
          middle,
          end,
        });
        writeFileSync(
          join(directory, 'readings.json'),
          JSON.stringify(
            {
              metadata,
              node: process.version,
              cpu: cpus()[0]?.model,
              topology,
              quantumPs: JOINT_TIME_QUANTUM_PS,
              readings,
            },
            null,
            2,
          ),
        );
        process.stdout.write(`HEX_PERF ${JSON.stringify(readings.at(-1))}\n`);
      } finally {
        joint.dispose();
      }
    }
    // The new image has its own workload: do not reuse the old BIN's fixed WR/pixel/frame counts.
    const oracle = await createJointBoard({ firmware, accounting: true });
    try {
      oracle.board.runUntil(0);
      oracle.advanceTo(220_000_000_000);
      const referenceMiddle = snapshot(oracle);
      oracle.advanceTo(440_000_000_000);
      verify(oracle);
      const accounting = oracle.readAccounting()!;
      expect(accounting.wrSamples).toBe(accounting.wrLevelChanges);
      expect(accounting.csSamples).toBe(accounting.csLevelChanges);
      expect(accounting.rsSamples).toBe(accounting.rsLevelChanges);
      expect(accounting.dataSamples).toBeGreaterThanOrEqual(accounting.dataBitLevelChanges);
      expect(accounting.gramStores).toBe(accounting.pixelWrites);
      expect(accounting.oracleGramStores).toBe(accounting.pixelWrites);
      expect(accounting.pixelWrites).toBeGreaterThan(0);
      expect(gramMatchesOracle(oracle.lcd.memories.get('gram')!, accounting.oracleGram)).toBe(true);
      expect(accounting.oracleFrames).toHaveLength(oracle.frames.length);
      expect(oracle.frames.every((frame, i) => sameBytes(frame, accounting.oracleFrames[i]!))).toBe(
        true,
      );
      expect(images.every((value) => value === digest(oracle.lcd.memories.get('gram')!))).toBe(
        true,
      );
      for (const hashes of frameDigests) expect(hashes).toEqual(oracle.frames.map(digest));
      for (const times of frameTimes) expect(times).toEqual(oracle.frameTimes);
      const referenceCpu = cpuState(oracle);
      for (const actual of cpuStates) {
        expect(actual.memories).toEqual(referenceCpu.memories);
        for (const [key, value] of Object.entries(referenceCpu.states))
          expect(actual.states[key], `MCU ${key}`).toEqual(value);
      }
      const counts = Object.fromEntries(
        Object.entries(accounting).filter(
          ([key]) => key !== 'oracleGram' && key !== 'oracleFrames',
        ),
      );
      const result = {
        metadata,
        topology,
        counts,
        middle: referenceMiddle,
        final: snapshot(oracle),
        gramSha256: digest(oracle.lcd.memories.get('gram')!),
        frameSha256: oracle.frames.map(digest),
        frameTimes: oracle.frameTimes,
      };
      writeFileSync(join(directory, 'oracle.json'), JSON.stringify(result, null, 2));
      expect(
        readings.every(
          (r) =>
            r.end.wrChanges === accounting.wrLevelChanges &&
            r.end.gramStores === accounting.pixelWrites &&
            r.end.frames === oracle.frames.length,
        ),
      ).toBe(true);
      for (const reading of readings) {
        compareWorkload(reading.middle, referenceMiddle);
        compareWorkload(reading.end, result.final);
      }
      process.stdout.write(`HEX_REPORT ${directory}\n`);
    } finally {
      oracle.dispose();
    }
  },
  900_000,
);

function verifyReady(joint: JointBoard) {
  expect(joint.board.status).toBe('ready');
  expect(joint.errors).toEqual([]);
  expect(joint.faults).toEqual([]);
}

/** Single diagnostic run to distinguish initialization/drawing from the terminal idle loop. */
it.skipIf(!enabled || process.env.MICA_JOINT_HEX_LONG !== '1')(
  'HEX phase diagnostic through 5 s',
  async () => {
    const { firmware, metadata } = loadFirmware();
    const directory = mkdtempSync(join(tmpdir(), `mica-joint-hex-${topology}-long-`));
    const joint = await createMeasuredBoard({ firmware });
    const windows = [];
    try {
      joint.board.runUntil(0);
      let previousMs = 0;
      let previousWr = 0;
      let previousStores = 0;
      for (const targetMs of [220, 440, 1000, 2000, 5000]) {
        const cpu = process.cpuUsage(),
          wall = performance.now();
        joint.advanceTo(targetMs * 1_000_000_000);
        const measuredCpuMs = cpuMs(cpu),
          wallMs = performance.now() - wall;
        verifyReady(joint);
        const state = snapshot(joint);
        windows.push({
          fromMs: previousMs,
          toMs: targetMs,
          cpuMs: round(measuredCpuMs),
          wallMs: round(wallMs),
          realtime: round((targetMs - previousMs) / measuredCpuMs),
          wrChanges: Number(state.wrChanges) - previousWr,
          stores: state.gramStores - previousStores,
          state,
        });
        previousMs = targetMs;
        previousWr = Number(state.wrChanges);
        previousStores = state.gramStores;
        writeFileSync(
          join(directory, 'windows.json'),
          JSON.stringify({ metadata, topology, windows }, null, 2),
        );
        process.stdout.write(`HEX_LONG ${JSON.stringify(windows.at(-1))}\n`);
      }
      const oracle = await createJointBoard({ firmware, accounting: true });
      try {
        oracle.board.runUntil(0);
        for (const window of windows) {
          oracle.advanceTo(window.toMs * 1_000_000_000);
          compareWorkload(window.state, snapshot(oracle));
        }
        verify(joint);
        verify(oracle);
        const a = oracle.readAccounting()!;
        expect(a.wrSamples).toBe(a.wrLevelChanges);
        expect(a.csSamples).toBe(a.csLevelChanges);
        expect(a.rsSamples).toBe(a.rsLevelChanges);
        expect(a.gramStores).toBe(a.pixelWrites);
        expect(a.oracleGramStores).toBe(a.pixelWrites);
        expect(gramMatchesOracle(oracle.lcd.memories.get('gram')!, a.oracleGram)).toBe(true);
        expect(oracle.frames.every((frame, i) => sameBytes(frame, a.oracleFrames[i]!))).toBe(true);
        expect(digest(joint.lcd.memories.get('gram')!)).toBe(
          digest(oracle.lcd.memories.get('gram')!),
        );
        expect(joint.frames.map(digest)).toEqual(oracle.frames.map(digest));
        expect(joint.frameTimes).toEqual(oracle.frameTimes);
        const actualCpu = cpuState(joint),
          referenceCpu = cpuState(oracle);
        expect(actualCpu.memories).toEqual(referenceCpu.memories);
        for (const [key, value] of Object.entries(referenceCpu.states))
          expect(actualCpu.states[key], `MCU ${key}`).toEqual(value);
        writeFileSync(
          join(directory, 'oracle.json'),
          JSON.stringify(
            {
              wr: a.wrLevelChanges,
              stores: a.pixelWrites,
              fills: a.fullScreenFills,
              final: snapshot(oracle),
            },
            null,
            2,
          ),
        );
      } finally {
        oracle.dispose();
      }
      process.stdout.write(`HEX_LONG_REPORT ${directory}\n`);
    } finally {
      joint.dispose();
    }
  },
  900_000,
);
