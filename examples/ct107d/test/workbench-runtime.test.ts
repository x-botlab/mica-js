import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toTimePs } from '@mica-js/core';
import { parseFusedDocument } from '@mica-js/document/fused';
import type {
  DeviceRegistry,
  FusedDocument,
  PackageFiles,
  Value,
} from '@mica-js/document/fused';
import {
  FusedPreparationError,
  createHeadlessRuntime,
  type HeadlessRuntime,
  type RuntimeDiagnostic,
  type RuntimeModelEvent,
} from '@mica-js/sdk/fused';
import { createDirectoryRegistry, readDirectoryPackage } from '@mica-js/sdk/fused/node';
import { describe, expect, it } from 'vitest';
import { createCt107dBoard } from '../bench/board';

const PROJECT = join(import.meta.dirname, '..');
const DEVICE_DIST = join(PROJECT, 'device', 'dist');
const DOCUMENT_PATH = join(PROJECT, 'ct107d.sch');
const DEVICE_ID = 'example:ct107d-board';
const INSTANCE_ID = '7d9e3a1c-5b2f-4c8d-9e01-2a3b4c5d6e7f';
const CLOCK_FREQUENCY = 12_000_000;
const STEP = toTimePs(1, 'ms');

interface SignalPayload {
  readonly designator: string;
  readonly port: string;
  readonly value: number;
}

interface LedState {
  readonly brightness: number;
  readonly current: number;
  readonly voltage: number;
}

interface SnapshotView {
  readonly leds: readonly LedState[];
  readonly displays: Readonly<Record<'DS1' | 'DS2', readonly number[]>>;
  readonly latches: Readonly<Record<'U6' | 'U7' | 'U8' | 'U9', number>>;
}

interface Harness {
  readonly runtime: HeadlessRuntime;
  readonly signals: Map<string, number>;
  readonly events: RuntimeModelEvent[];
  readonly diagnostics: RuntimeDiagnostic[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function signalOf(event: RuntimeModelEvent): SignalPayload | undefined {
  if (event.event !== 'onDidSignal') return undefined;
  const value = event.payload.value;
  if (!record(value)) return undefined;
  const designator = value['designator'];
  const port = value['port'];
  const signal = value['value'];
  if (typeof designator !== 'string' || typeof port !== 'string' || typeof signal !== 'number')
    return undefined;
  return { designator, port, value: signal };
}

function numberAt(value: unknown, name: string): number {
  if (!record(value) || typeof value[name] !== 'number') {
    throw new Error(`Snapshot field ${name} is not a number`);
  }
  return value[name];
}

function recordAt(value: unknown, name: string): Record<string, unknown> {
  if (!record(value) || !record(value[name])) {
    throw new Error(`Snapshot field ${name} is not an object`);
  }
  return value[name];
}

function arrayAt(value: unknown, name: string): readonly unknown[] {
  if (!record(value) || !Array.isArray(value[name])) {
    throw new Error(`Snapshot field ${name} is not an array`);
  }
  return value[name];
}

function snapshotOf(value: Value): SnapshotView {
  const leds = arrayAt(value, 'ledStates').map((entry, index) => {
    if (!record(entry)) throw new Error(`Snapshot LED ${String(index)} is not an object`);
    return {
      brightness: numberAt(entry, 'brightness'),
      current: numberAt(entry, 'current'),
      voltage: numberAt(entry, 'voltage'),
    };
  });
  const displays = recordAt(value, 'displays');
  const latches = recordAt(value, 'latches');
  const display = (name: 'DS1' | 'DS2'): readonly number[] =>
    arrayAt(displays, name).map((entry, index) => {
      if (typeof entry !== 'number') throw new Error(`Snapshot ${name}[${String(index)}]`);
      return entry;
    });
  return {
    leds,
    displays: { DS1: display('DS1'), DS2: display('DS2') },
    latches: {
      U6: numberAt(latches, 'U6'),
      U7: numberAt(latches, 'U7'),
      U8: numberAt(latches, 'U8'),
      U9: numberAt(latches, 'U9'),
    },
  };
}

async function snapshot(runtime: HeadlessRuntime): Promise<SnapshotView> {
  const method = runtime.getModel(INSTANCE_ID).methods['getSnapshot'];
  if (method === undefined) throw new Error('The board model has no getSnapshot method');
  return snapshotOf(await method(null));
}

function documentWithFirmware(source: 'assets/ct107d-demo.hex' | 'assets/ct107d-demo.bin'): FusedDocument {
  const raw = JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8')) as unknown;
  if (!record(raw) || !Array.isArray(raw['instances']) || raw['instances'].length !== 1) {
    throw new Error('The formal document does not contain one instance');
  }
  const instance = raw['instances'][0];
  if (!record(instance) || !record(instance['properties'])) {
    throw new Error('The formal document instance has no properties');
  }
  instance['properties'] = {
    ...instance['properties'],
    clockFrequency: CLOCK_FREQUENCY,
    firmware: { mode: 'package', src: source },
  };
  return parseFusedDocument(raw);
}

async function start(document: FusedDocument): Promise<Harness> {
  const signals = new Map<string, number>();
  const events: RuntimeModelEvent[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const runtime = await createHeadlessRuntime({
    document,
    registry: createDirectoryRegistry({ [DEVICE_ID]: DEVICE_DIST }),
    // Read through the verified package interface: a corrupted declared file must fail before
    // any model code is imported. The build emits a self-contained module, so a data URL keeps
    // this test independent of the filesystem copy.
    loadModule: async (files, path) => {
      const bytes = await files.read(path);
      return import(`data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`);
    },
    step: STEP,
    onDiagnostic: (entry) => diagnostics.push(entry),
    onModelEvent: (event) => {
      events.push(event);
      const signal = signalOf(event);
      if (signal !== undefined) signals.set(`${signal.designator}/${signal.port}`, signal.value);
    },
  });
  return { runtime, signals, events, diagnostics };
}

function oracleSignals(board: Awaited<ReturnType<typeof createCt107dBoard>>): {
  readonly signals: Map<string, number>;
  dispose(): void;
} {
  const signals = new Map<string, number>();
  const designatorOf = new Map<string, string>();
  for (const [id, designator] of board.designators) designatorOf.set(id, designator);
  const subscription = board.board.topics.onDidReceive((message) => {
    if (typeof message.payload !== 'number') return;
    const instance = board.topicOrigin();
    const designator = instance === undefined ? undefined : designatorOf.get(instance);
    if (designator !== undefined) signals.set(`${designator}/${message.topic}`, message.payload);
  });
  return { signals, dispose: () => subscription.dispose() };
}

/**
 * Focused equivalence subset against the discrete oracle: both displays, the four latches and the
 * eight LEDs' brightness/voltage. Other model signals are intentionally outside this assertion;
 * the fused-* suites remain responsible for the full behavioral baseline.
 */
const COMPARED = [
  'DS1/digit1',
  'DS1/digit2',
  'DS1/digit3',
  'DS1/digit4',
  'DS2/digit1',
  'DS2/digit2',
  'DS2/digit3',
  'DS2/digit4',
  'U6/latch',
  'U7/latch',
  'U8/latch',
  'U9/latch',
  ...Array.from({ length: 8 }, (_unused, index) => `D${String(index + 1)}/brightness`),
  ...Array.from({ length: 8 }, (_unused, index) => `D${String(index + 1)}/voltage`),
] as const;

function compareFocusedSignals(
  actual: Map<string, number>,
  oracle: Map<string, number>,
  label: string,
  requireAll: boolean,
): void {
  let compared = 0;
  for (const key of COMPARED) {
    const expected = oracle.get(key);
    if (expected === undefined) {
      if (requireAll) throw new Error(`${label}: oracle has no ${key}`);
      continue;
    }
    compared += 1;
    expect(actual.get(key), `${label}: ${key}`).toBe(expected);
  }
  expect(compared, `${label}: no comparable signal`).toBeGreaterThan(0);
}

describe('CT107D v2 headless runtime on the real device release', () => {
  it('prepares the official document, starts paused at zero and matches a focused oracle subset', async () => {
    const hex = await start(documentWithFirmware('assets/ct107d-demo.hex'));
    const oracle = await createCt107dBoard({
      firmware: new Uint8Array(readFileSync(join(PROJECT, 'assets', 'ct107d-demo.bin'))),
      props: { clockFrequency: CLOCK_FREQUENCY },
      execution: 'throughput',
    });
    const captured = oracleSignals(oracle);
    try {
      expect(hex.runtime.getState()).toEqual({ status: 'paused', simTime: 0 });
      expect(hex.diagnostics).toEqual([]);
      const initial = await snapshot(hex.runtime);
      expect(initial.leds).toHaveLength(8);
      expect(initial.displays.DS1).toHaveLength(4);
      expect(initial.displays.DS2).toHaveLength(4);

      oracle.board.runUntil(0);
      for (let ms = 1; ms <= 64; ms += 1) {
        await hex.runtime.step();
        oracle.board.runUntil(ms * 1_000_000_000);
        compareFocusedSignals(hex.signals, captured.signals, `t=${String(ms)}ms`, ms === 64);
        if (ms === 1) expect(hex.events.length).toBeGreaterThan(0);
      }
      expect(hex.runtime.getState()).toEqual({ status: 'paused', simTime: 64_000_000_000 });
      expect(hex.diagnostics).toEqual([]);

      const final = await snapshot(hex.runtime);
      final.leds.forEach((led, index) => {
        expect(led.brightness).toBe(hex.signals.get(`D${String(index + 1)}/brightness`));
        expect(led.current).toBe(hex.signals.get(`D${String(index + 1)}/current`));
        expect(led.voltage).toBe(hex.signals.get(`D${String(index + 1)}/voltage`));
      });
      for (const display of ['DS1', 'DS2'] as const) {
        final.displays[display].forEach((mask, index) => {
          expect(mask).toBe(hex.signals.get(`${display}/digit${String(index + 1)}`));
        });
      }
      for (const latch of ['U6', 'U7', 'U8', 'U9'] as const) {
        expect(final.latches[latch]).toBe(hex.signals.get(`${latch}/latch`));
      }
    } finally {
      captured.dispose();
      await hex.runtime.dispose();
      oracle.dispose();
    }
  }, 900_000);

  it('loads the same demo as BIN and HEX from the package and produces identical signals', async () => {
    const hex = await start(documentWithFirmware('assets/ct107d-demo.hex'));
    const bin = await start(documentWithFirmware('assets/ct107d-demo.bin'));
    try {
      expect(bin.signals).toEqual(hex.signals);
      for (let ms = 1; ms <= 32; ms += 1) {
        await hex.runtime.step();
        await bin.runtime.step();
        expect(bin.signals).toEqual(hex.signals);
      }
    } finally {
      await hex.runtime.dispose();
      await bin.runtime.dispose();
    }
  }, 900_000);

  it('reset rebuilds the session, disconnects the old client and restarts the first frame', async () => {
    const harness = await start(documentWithFirmware('assets/ct107d-demo.hex'));
    try {
      for (let step = 0; step < 16; step += 1) await harness.runtime.step();
      const old = harness.runtime.getModel(INSTANCE_ID);
      const before = await snapshot(harness.runtime);
      await harness.runtime.reset();
      expect(harness.runtime.getState()).toEqual({ status: 'paused', simTime: 0 });
      const oldQuery = old.methods['getSnapshot'];
      if (oldQuery === undefined) throw new Error('The old board client lost getSnapshot');
      await expect(oldQuery(null)).rejects.toMatchObject({ code: 'model/disconnected' });

      const rebuilt = await snapshot(harness.runtime);
      expect(rebuilt.leds).toHaveLength(8);
      expect(before.displays).toBeDefined();
      await harness.runtime.step();
      expect(harness.runtime.getState()).toEqual({ status: 'paused', simTime: 1_000_000_000 });
      expect(harness.diagnostics).toEqual([]);
    } finally {
      await harness.runtime.dispose();
    }
  }, 900_000);

  it('rejects step while running and resumes with one queued first step', async () => {
    const harness = await start(documentWithFirmware('assets/ct107d-demo.bin'));
    try {
      const states: string[] = [];
      harness.runtime.onDidChangeState((state) => states.push(`${state.status}@${state.simTime}`));
      await harness.runtime.resume();
      expect(harness.runtime.getState().status).toBe('running');
      await expect(harness.runtime.step()).rejects.toMatchObject({
        code: 'runtime/unavailable-state',
      });
      harness.runtime.pause();
      expect(harness.runtime.getState().status).toBe('paused');
      expect(states.length).toBeGreaterThan(0);
    } finally {
      await harness.runtime.dispose();
    }
  }, 900_000);

  it('fails preparation visibly on a missing release, a wrong lock and a corrupted file digest', async () => {
    const document = documentWithFirmware('assets/ct107d-demo.hex');
    const released = await readDirectoryPackage(DEVICE_DIST);
    const diagnostics: RuntimeDiagnostic[] = [];

    const missing = await createHeadlessRuntime({
      document,
      registry: createDirectoryRegistry({}),
      loadModule: async () => {
        throw new Error('no module expected');
      },
      step: STEP,
      onDiagnostic: (entry) => diagnostics.push(entry),
    }).catch((cause: unknown) => cause);
    expect(missing).toBeInstanceOf(FusedPreparationError);
    expect((missing as FusedPreparationError).code).toBe('package/not-found');

    const wrongLock: PackageFiles = {
      ...released,
      lock: { ...released.lock, integrity: `sha256:${'0'.repeat(64)}` },
    };
    const wrongLockRegistry: DeviceRegistry = {
      async open() {
        return wrongLock;
      },
    };
    const locked = await createHeadlessRuntime({
      document,
      registry: wrongLockRegistry,
      loadModule: async () => {
        throw new Error('no module expected');
      },
      step: STEP,
      onDiagnostic: (entry) => diagnostics.push(entry),
    }).catch((cause: unknown) => cause);
    expect(locked).toBeInstanceOf(FusedPreparationError);
    expect((locked as FusedPreparationError).code).toBe('package/integrity-mismatch');

    const corruptRegistry: DeviceRegistry = {
      async open() {
        return {
          lock: released.lock,
          files: released.files,
          async read(path: string) {
            const bytes = await released.read(path);
            if (path === 'model.js') bytes[0] = (bytes[0] ?? 0) ^ 0xff;
            return bytes;
          },
        };
      },
    };
    const corrupted = await createHeadlessRuntime({
      document,
      registry: corruptRegistry,
      loadModule: async (files, path) => {
        const bytes = await files.read(path);
        return import(`data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`);
      },
      step: STEP,
      onDiagnostic: (entry) => diagnostics.push(entry),
    }).catch((cause: unknown) => cause);
    expect(corrupted).toBeInstanceOf(FusedPreparationError);
    // The loader boundary reports a module that could not be read; the package verifier's
    // digest detail stays in the message so the actual cause is not hidden.
    expect((corrupted as FusedPreparationError).code).toBe('model/execution-failed');
    expect((corrupted as Error).message).toContain('does not match the released digest');
    expect(diagnostics.some((entry) => entry.message.includes('does not match the released digest'))).toBe(true);
  }, 900_000);
});
