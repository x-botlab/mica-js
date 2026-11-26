import { createHash } from 'node:crypto';
import { timePs, toTimePs } from '@mica-js/core';
import { compileDDL } from '@mica-js/ddl';
import { describe, expect, it, vi } from 'vitest';
import type {
  DeviceRegistry,
  FusedDocument,
  PackageFiles,
  UnifiedDeviceManifest,
  MemoryProgram,
  ProgramFiles,
} from '@mica-js/document/fused';
import { MethodError, createHeadlessRuntime, openDevicePackage, satisfiesRange } from '.';
import type {
  HeadlessRuntime,
  HeadlessRuntimeOptions,
  RuntimeDiagnostic,
  RuntimeModelEvent,
  RuntimeState,
} from '.';

const SWITCH = 'test:tactile';
const LED = 'test:led';
const PROBE = 'test:probe';
const LABEL = 'test:label';

const SWITCH_ID = '11111111-1111-4111-8111-111111111111';
const LED_ID = '22222222-2222-4222-8222-222222222222';
const PROBE_ID = '33333333-3333-4333-8333-333333333333';
const WIRE_ID = '44444444-4444-4444-8444-444444444444';
const VCC_ID = '55555555-5555-4555-8555-555555555555';
const GND_ID = '66666666-6666-4666-8666-666666666666';
const CONFLICT_ID = '77777777-7777-4777-8777-777777777777';

const STEP = toTimePs(1, 'ms');

const SWITCH_MODEL = await compileDDL(`
device TactileSwitch(onResistance: number default 1) {
  assert onResistance >= 0.001 && onResistance <= 1_000_000_000;
  pin a1;
  pin a2 = [resistor(to: a1, resistance: 0.001)];
  pin b1;
  pin b2 = [resistor(to: b1, resistance: 0.001)];
  input channel press: bool(capacity: 16);
  process start {
    loop {
      const pressed = await press.receive();
      if pressed {
        a1.intent <- [resistor(to: b1, resistance: onResistance)];
      } else {
        a1.intent <- [];
      }
    }
  }
}
`);

const LED_MODEL = await compileDDL(`
device IndicatorLed(forwardResistance: number default 500, ratedCurrent: number default 0.02) {
  assert forwardResistance >= 0.001 && forwardResistance <= 1_000_000_000;
  assert ratedCurrent > 0 && ratedCurrent <= 1;
  pin anode = [resistor(to: cathode, resistance: forwardResistance)];
  pin cathode;
  output channel brightness: number(capacity: 64);
  fn report() {
    const a = anode.sample.voltage;
    const k = cathode.sample.voltage;
    if a != none && k != none {
      const v = a - k;
      const i = v / forwardResistance;
      brightness.send(min(1, max(0, i / ratedCurrent)));
    } else {
      brightness.send(0);
    }
  }
  process start { report(); }
  reaction anodeChanged on anode.sample.voltage as (previous, next) { report(); }
  reaction cathodeChanged on cathode.sample.voltage as (previous, next) { report(); }
}
`);

const PROBE_MODEL = await compileDDL(`
device Probe(limit: number default 10) {
  state untouched: number = 0;
}
`);

const SWITCH_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'test',
  name: 'tactile',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Tactile switch',
  designatorPrefix: 'S',
  pins: { a1: {}, a2: {}, b1: {}, b2: {} },
  properties: { onResistance: { type: 'number', default: 1, exclusiveMin: 0 } },
  model: {
    entry: 'model.js',
    methods: {
      setPressed: {
        params: { ref: 'Press' },
        returns: { type: 'null' },
      },
      getPressed: { params: { type: 'null' }, returns: { type: 'boolean' } },
    },
    types: { Press: { type: 'object', properties: { pressed: { type: 'boolean' } } } },
  },
};

const LED_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'test',
  name: 'led',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Indicator LED',
  designatorPrefix: 'D',
  pins: { anode: {}, cathode: {} },
  properties: {
    forwardResistance: { type: 'number', default: 500, exclusiveMin: 0 },
    ratedCurrent: { type: 'number', default: 0.02, exclusiveMin: 0 },
  },
  model: {
    entry: 'model.js',
    methods: {
      getBrightness: { params: { type: 'null' }, returns: { type: 'number' } },
    },
    events: { onDidBrightnessChange: { type: 'number' } },
  },
};

const LABEL_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'test',
  name: 'label',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Label',
};

const LABEL_ID = '99999999-9999-4999-8999-999999999999';

const PROBE_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'test',
  name: 'probe',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Probe',
  properties: { limit: { type: 'number', default: 10, min: 0 } },
  model: {
    entry: 'model.js',
    methods: {
      echo: { params: { ref: 'Echo' }, returns: { ref: 'Echo' } },
      getLimit: { params: { type: 'null' }, returns: { type: 'number' } },
      reject: { params: { type: 'null' }, returns: { type: 'null' } },
      rejectBundled: { params: { type: 'null' }, returns: { type: 'null' } },
      rejectNamed: { params: { type: 'null' }, returns: { type: 'null' } },
      rejectBadDetails: { params: { type: 'null' }, returns: { type: 'null' } },
      fail: { params: { type: 'null' }, returns: { type: 'null' } },
      ping: { params: { type: 'null' }, returns: { type: 'number' } },
      sendBytes: { params: { type: 'null' }, returns: { type: 'number' } },
      badEvent: { params: { type: 'null' }, returns: { type: 'null' } },
    },
    types: {
      Echo: { type: 'object', properties: { value: { type: 'number' } } },
      Tick: { type: 'object', properties: { value: { type: 'number' } } },
      Bytes: { type: 'object', properties: { data: { type: 'binary' } } },
    },
    events: { onDidTick: { ref: 'Tick' }, onDidBytes: { ref: 'Bytes' } },
  },
};

/** In-memory registry: every package declares the exact bytes it hands out. */
function createRegistry(
  packages: Readonly<
    Record<string, { manifest: UnifiedDeviceManifest; files?: Record<string, string> }>
  >,
  counter: { reads: number } = { reads: 0 },
): DeviceRegistry {
  const prepared = new Map<string, { manifest: string; files: Record<string, Uint8Array> }>();
  for (const [id, entry] of Object.entries(packages)) {
    const files: Record<string, Uint8Array> = {
      'package.json': new TextEncoder().encode(JSON.stringify(entry.manifest, null, 2)),
    };
    for (const [path, content] of Object.entries(entry.files ?? {})) {
      files[path] = new TextEncoder().encode(content);
    }
    prepared.set(id, { manifest: entry.manifest.name, files });
  }
  return {
    async open(lock): Promise<PackageFiles> {
      const entry = prepared.get(lock.id);
      if (entry === undefined) {
        throw new Error(`unknown package ${lock.id}`);
      }
      const table: Record<string, { size: number; integrity: string }> = {};
      for (const [path, bytes] of Object.entries(entry.files)) {
        table[path] = {
          size: bytes.length,
          integrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        };
      }
      return {
        lock,
        files: table,
        read: async (path: string) => {
          counter.reads += 1;
          const bytes = entry.files[path];
          if (bytes === undefined) {
            throw new Error(`unknown file ${path}`);
          }
          return bytes.slice();
        },
      };
    },
  };
}

/** JSON Canonicalization Scheme subset: sorted object keys, no extra whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** The lock a registry must publish for one package: the JCS release identity (RFC 0020). */
function dependency(
  manifest: UnifiedDeviceManifest,
  extraFiles: Readonly<Record<string, string>> = {},
): { version: string; integrity: string } {
  const contents: Record<string, Uint8Array> = {
    'package.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };
  for (const [path, content] of Object.entries(extraFiles)) {
    contents[path] = new TextEncoder().encode(content);
  }
  const files: Record<string, { size: number; integrity: string }> = {};
  for (const [path, bytes] of Object.entries(contents)) {
    files[path] = {
      size: bytes.length,
      integrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  }
  return {
    version: manifest.version,
    integrity: sha256(
      canonicalJson({
        id: `${manifest.publisher}:${manifest.name}`,
        version: manifest.version,
        files,
      }),
    ),
  };
}

/** The production simulator solves this: 5 V a power reference, 0 V ground, a switch in between. */
function circuitDocument(extra: readonly unknown[] = []): FusedDocument {
  return {
    version: 2,
    dependencies: {
      [SWITCH]: dependency(SWITCH_MANIFEST),
      [LED]: dependency(LED_MANIFEST),
      [LABEL]: dependency(LABEL_MANIFEST),
    },
    instances: [
      {
        id: SWITCH_ID,
        device: SWITCH,
        designator: 'S1',
        placement: { x: 0, y: 0, rotation: 0 },
      },
      {
        id: LED_ID,
        device: LED,
        designator: 'D1',
        placement: { x: 20, y: 0, rotation: 0 },
      },
      // Display-only instance: the headless runtime keeps it in the document and skips it.
      {
        id: LABEL_ID,
        device: LABEL,
        placement: { x: 0, y: 20, rotation: 0 },
      },
    ],
    nodes: [],
    wires: [
      {
        id: WIRE_ID,
        from: { kind: 'pin', instance: LED_ID, pin: 'cathode' },
        to: { kind: 'pin', instance: SWITCH_ID, pin: 'a1' },
        bends: [],
      },
    ],
    labels: [],
    references: [
      {
        id: VCC_ID,
        target: { kind: 'pin', instance: LED_ID, pin: 'anode' },
        voltage: 5,
        symbol: 'power',
        label: { name: 'VCC' },
      },
      {
        id: GND_ID,
        target: { kind: 'pin', instance: SWITCH_ID, pin: 'b1' },
        voltage: 0,
        symbol: 'ground',
      },
      ...extra,
    ],
  } as FusedDocument;
}

function probeDocument(
  limit: number,
  manifest: UnifiedDeviceManifest = PROBE_MANIFEST,
  files: Readonly<Record<string, string>> = {},
): FusedDocument {
  return {
    version: 2,
    dependencies: { [PROBE]: dependency(manifest, files) },
    instances: [
      {
        id: PROBE_ID,
        device: PROBE,
        designator: 'U1',
        placement: { x: 0, y: 0, rotation: 0 },
        properties: { limit },
      },
    ],
    nodes: [],
    wires: [],
    labels: [],
    references: [],
  };
}

interface Harness {
  readonly runtime: HeadlessRuntime;
  readonly events: RuntimeModelEvent[];
  readonly diagnostics: RuntimeDiagnostic[];
  readonly states: RuntimeState[];
  /** Counts registry reads, so a reset can be proven to reuse the captured bytes. */
  readonly registry: { reads: number };
}

async function start(
  document: FusedDocument,
  modules: Readonly<Record<string, unknown>>,
  options: { observe?: boolean; batchExecution?: boolean } = {},
): Promise<Harness> {
  const events: RuntimeModelEvent[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const states: RuntimeState[] = [];
  const registry = { reads: 0 };
  const runtime = await createHeadlessRuntime({
    document,
    registry: createRegistry(
      {
        [SWITCH]: { manifest: SWITCH_MANIFEST },
        [LED]: { manifest: LED_MANIFEST },
        [PROBE]: { manifest: PROBE_MANIFEST },
        [LABEL]: { manifest: LABEL_MANIFEST },
      },
      registry,
    ),
    loadModule: async (files, path) => {
      const namespace = modules[`${files.lock.id}/${path}`];
      if (namespace === undefined) {
        throw new Error(`missing module ${files.lock.id}/${path}`);
      }
      return namespace;
    },
    step: STEP,
    onDiagnostic: (entry) => diagnostics.push(entry),
    ...(options.batchExecution === undefined ? {} : { batchExecution: options.batchExecution }),
    ...(options.observe === false
      ? {}
      : { onModelEvent: (event: RuntimeModelEvent) => events.push(event) }),
  });
  runtime.onDidChangeState((state) => states.push(state));
  return { runtime, events, diagnostics, states, registry };
}

function switchModule(onCreate: () => void = () => {}) {
  return {
    model: SWITCH_MODEL,
    create(context: {
      inputs: Record<string, { send(value: unknown): void }>;
      props: Record<string, unknown>;
    }) {
      onCreate();
      let pressed = false;
      return {
        methods: {
          setPressed(params: { pressed: boolean }) {
            pressed = params.pressed;
            context.inputs['press']!.send(pressed);
            return null;
          },
          getPressed() {
            return pressed;
          },
        },
        sync() {},
        dispose() {},
      };
    },
  };
}

function ledModule(created: { count: number }) {
  return {
    model: LED_MODEL,
    create(context: {
      props: Record<string, unknown>;
      events: Record<string, { fire(value: unknown): void }>;
    }) {
      created.count += 1;
      let brightness = 0;
      // Initial event fired while the board is still initializing.
      context.events['onDidBrightnessChange']!.fire(0);
      return {
        methods: {
          getBrightness() {
            return brightness;
          },
        },
        sync(batch: { outputs: unknown }) {
          const outputs = batch.outputs as Record<string, readonly { value: unknown }[]>;
          for (const message of outputs['brightness'] ?? []) {
            brightness = message.value as number;
            context.events['onDidBrightnessChange']!.fire(brightness);
          }
        },
        dispose() {},
      };
    },
  };
}

/** Stand-in for the class identity of a bundle that re-exports this SDK. */
class BundledMethodError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'MethodError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
    Object.defineProperty(this, Symbol.for('mica-js.sdk/method-error'), { value: true });
  }
}

/** A copy that lost the marker symbol but kept the documented name and shape. */
class NamedMethodError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MethodError';
    this.code = code;
  }
}

function probeModule(state: { limit: number; disposed: number; failDispose?: boolean }) {
  return {
    model: PROBE_MODEL,
    create(context: {
      props: Record<string, unknown>;
      events: Record<
        string,
        {
          fire(value: unknown): void;
          fireTransferred(value: unknown, buffers: readonly ArrayBuffer[]): void;
        }
      >;
    }) {
      state.limit = context.props['limit'] as number;
      const frozen = Object.isFrozen(context.props);
      let counter = 0;
      context.events['onDidTick']!.fire({ value: 0 });
      return {
        methods: {
          echo(params: { value: number }) {
            return { value: params.value * 2 };
          },
          getLimit() {
            return frozen ? state.limit : -1;
          },
          reject() {
            throw new MethodError('probe/rejected', 'business rejection', { reason: 'declined' });
          },
          rejectBundled() {
            // A device artifact bundles its own copy of this class, so `instanceof` cannot work.
            throw new BundledMethodError('probe/bundled', 'bundled rejection', {
              source: 'bundle',
            });
          },
          rejectNamed() {
            throw new NamedMethodError('probe/named', 'named rejection');
          },
          rejectBadDetails() {
            throw new BundledMethodError('probe/bad-details', 'bad details', () => {});
          },
          fail() {
            throw new Error('model exploded');
          },
          ping() {
            counter += 1;
            context.events['onDidTick']!.fire({ value: counter });
            return counter;
          },
          sendBytes() {
            const bytes = new Uint8Array([1, 2, 3]);
            // A fresh view always owns a plain ArrayBuffer, so no cast is needed at runtime.
            context.events['onDidBytes']!.fireTransferred({ data: bytes }, [
              bytes.buffer as ArrayBuffer,
            ]);
            // Ownership moved into the event, so the local view is detached.
            return bytes.byteLength;
          },
          badEvent() {
            context.events['onDidTick']!.fire({ value: 'not a number' });
            return null;
          },
        },
        sync() {},
        dispose() {
          state.disposed += 1;
          if (state.failDispose === true) {
            state.failDispose = false;
            throw new Error('dispose exploded');
          }
        },
      };
    },
  };
}

describe('headless fused runtime', () => {
  it('rejects an invalid batch-execution switch before preparing any module', async () => {
    const loadModule = vi.fn(async () => ({}));
    const diagnostics: RuntimeDiagnostic[] = [];
    for (const batchExecution of [undefined, null, 'on', 1, {}]) {
      const options = {
        document: probeDocument(3),
        registry: createRegistry({ [PROBE]: { manifest: PROBE_MANIFEST } }),
        loadModule,
        step: STEP,
        batchExecution,
        onDiagnostic: (entry: RuntimeDiagnostic) => diagnostics.push(entry),
      } as unknown as HeadlessRuntimeOptions;
      await expect(createHeadlessRuntime(options)).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      });
    }
    expect(loadModule).not.toHaveBeenCalled();
    expect(diagnostics.map((entry) => entry.code)).toEqual(
      Array.from({ length: 5 }, () => 'INVALID_CONFIGURATION'),
    );
  });

  it('accepts the batch-execution switch and keeps it across reset', async () => {
    const state = { limit: 0, disposed: 0 };
    const harness = await start(
      probeDocument(3),
      { [`${PROBE}/model.js`]: probeModule(state) },
      { batchExecution: true },
    );
    const { runtime, diagnostics } = harness;
    try {
      await runtime.step();
      expect(runtime.getState()).toEqual({ status: 'paused', simTime: STEP });
      await runtime.reset();
      expect(runtime.getState()).toEqual({ status: 'paused', simTime: timePs(0) });
      await runtime.step();
      expect(runtime.getState()).toEqual({ status: 'paused', simTime: STEP });
      expect(state.limit).toBe(3);
      expect(diagnostics).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it('drives a real button and LED through the production simulator', async () => {
    const created = { count: 0 };
    const harness = await start(circuitDocument(), {
      [`${SWITCH}/model.js`]: switchModule(),
      [`${LED}/model.js`]: ledModule(created),
    });
    const { runtime, events } = harness;
    try {
      expect(runtime.getState()).toEqual({ status: 'paused', simTime: toTimePs(0, 'ps') });
      expect(created.count).toBe(1);
      // The factory event is delivered before the runtime returns.
      const initial = events.filter((event) => event.instanceId === LED_ID);
      expect(initial).toHaveLength(1);
      expect(initial[0]!.payload).toMatchObject({ value: 0, simTime: 0, sequence: 1 });

      const led = runtime.getModel(LED_ID);
      const button = runtime.getModel(SWITCH_ID);
      expect(() => runtime.getModel(LABEL_ID)).toThrowError(
        expect.objectContaining({ code: 'model/unknown-instance' }),
      );
      expect(await led.methods['getBrightness']!(null)).toBe(0);

      // No history replay: a late subscription only sees later events.
      const late: number[] = [];
      led.events['onDidBrightnessChange']!((event) => late.push(event.sequence));
      expect(late).toEqual([]);

      await button.methods['setPressed']!({ pressed: true });
      expect(await button.methods['getPressed']!(null)).toBe(true);
      await runtime.step();

      const brightness = (await led.methods['getBrightness']!(null)) as number;
      // 5 V across 500 ohm + 1 ohm of the pressing branch: ~9.98 mA of the 20 mA rating.
      expect(brightness).toBeGreaterThan(0.49);
      expect(brightness).toBeLessThan(0.51);
      expect(late.length).toBeGreaterThan(0);

      const changes = events.filter(
        (event) => event.instanceId === LED_ID && event.event === 'onDidBrightnessChange',
      );
      // Sequences are strict per-instance and start at 1; no gap and no replay.
      expect(changes.map((event) => event.payload.sequence)).toEqual(
        changes.map((_, index) => index + 1),
      );
      const powered = changes[changes.length - 1]!;
      expect(powered.payload.simTime).toBe(STEP);
      expect(powered.payload.value).toBeCloseTo(brightness, 12);
      expect((powered.payload.value as number) * 0.02).toBeCloseTo(5 / 501, 6);

      await button.methods['setPressed']!({ pressed: false });
      await runtime.step();
      expect(await led.methods['getBrightness']!(null)).toBe(0);
      expect(runtime.getState()).toEqual({ status: 'paused', simTime: toTimePs(2, 'ms') });

      const states: RuntimeState[] = [];
      runtime.onDidChangeState((state) => states.push(state));
      await runtime.resume();
      expect(runtime.getState().status).toBe('running');
      await expect(runtime.step()).rejects.toMatchObject({ code: 'runtime/unavailable-state' });
      runtime.pause();
      expect(runtime.getState().status).toBe('paused');
      expect(states.some((state) => state.status === 'running')).toBe(true);
      expect(runtime.getState().simTime).toBeGreaterThan(toTimePs(2, 'ms'));

      // Reset rebuilds the model from the captured bytes and invalidates the old client.
      const readsBeforeReset = harness.registry.reads;
      const lateAfterReset: number[] = [];
      led.events['onDidBrightnessChange']!((event) => lateAfterReset.push(event.sequence));
      await runtime.reset();
      expect(runtime.getState()).toEqual({ status: 'paused', simTime: toTimePs(0, 'ps') });
      await expect(led.methods['getBrightness']!(null)).rejects.toMatchObject({
        code: 'model/disconnected',
      });
      await expect(button.methods['setPressed']!({ pressed: true })).rejects.toMatchObject({
        code: 'model/disconnected',
      });
      const rebuilt = runtime.getModel(LED_ID);
      expect(await rebuilt.methods['getBrightness']!(null)).toBe(0);
      expect(created.count).toBe(2);
      expect(lateAfterReset).toEqual([]);
      expect(harness.registry.reads).toBe(readsBeforeReset);
    } finally {
      await runtime.dispose();
      await runtime.dispose();
    }
    expect(harness.diagnostics.filter((entry) => entry.code !== 'model/disconnected')).toEqual([]);
  });

  it('rejects a voltage conflict before any model factory runs', async () => {
    let factories = 0;
    const diagnostics: RuntimeDiagnostic[] = [];
    // Two different ideal voltages on the cathode/switch net conflict before any factory runs.
    const conflicting = circuitDocument([
      {
        id: CONFLICT_ID,
        target: { kind: 'pin', instance: LED_ID, pin: 'cathode' },
        voltage: 5,
      },
      {
        id: '88888888-8888-4888-8888-888888888888',
        target: { kind: 'pin', instance: SWITCH_ID, pin: 'a1' },
        voltage: 3.3,
      },
    ]);
    const attempt = createHeadlessRuntime({
      document: conflicting,
      registry: createRegistry({
        [SWITCH]: { manifest: SWITCH_MANIFEST },
        [LED]: { manifest: LED_MANIFEST },
        [LABEL]: { manifest: LABEL_MANIFEST },
      }),
      loadModule: async (files, path) => {
        if (path !== 'model.js') {
          throw new Error(`unexpected entry ${path}`);
        }
        return files.lock.id === SWITCH
          ? switchModule(() => {
              factories += 1;
            })
          : ledModule({ count: 0 });
      },
      step: STEP,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    await expect(attempt).rejects.toMatchObject({ code: 'net/reference-conflict' });
    expect(factories).toBe(0);
    expect(diagnostics.map((entry) => entry.code)).toContain('net/reference-conflict');
  });

  it('checks parameters, business rejections, faults and transferred events', async () => {
    const state = { limit: 0, disposed: 0 };
    const harness = await start(probeDocument(42), {
      [`${PROBE}/model.js`]: probeModule(state),
    });
    const { runtime, events } = harness;
    try {
      expect(state.limit).toBe(42);
      const probe = runtime.getModel(PROBE_ID);
      expect(await probe.methods['getLimit']!(null)).toBe(42);
      expect(events[0]!.payload).toMatchObject({ value: { value: 0 }, sequence: 1 });

      await expect(
        probe.methods['echo']!({ value: 'nope' as unknown as number }),
      ).rejects.toMatchObject({ code: 'model/invalid-params' });
      await expect(probe.methods['echo']!({ value: 2 })).resolves.toEqual({ value: 4 });
      expect(runtime.getState().status).toBe('paused');

      await expect(probe.methods['reject']!(null)).rejects.toBeInstanceOf(MethodError);
      expect(runtime.getState().status).toBe('paused');

      // A bundled copy of MethodError has a separate class identity; the rejection must survive.
      const bundled = await probe.methods['rejectBundled']!(null).catch((cause: unknown) => cause);
      expect(bundled).toBeInstanceOf(MethodError);
      expect(bundled).toMatchObject({
        code: 'probe/bundled',
        message: 'bundled rejection',
        details: { source: 'bundle' },
      });
      await expect(probe.methods['rejectNamed']!(null)).rejects.toMatchObject({
        code: 'probe/named',
        message: 'named rejection',
      });
      await expect(probe.methods['rejectBadDetails']!(null)).rejects.toMatchObject({
        code: 'probe/bad-details',
      });
      expect(harness.diagnostics.map((entry) => entry.code)).toContain('model/invalid-result');
      expect(runtime.getState().status).toBe('paused');

      const bytes: number[][] = [];
      probe.events['onDidBytes']!((event) => {
        const data = (event.value as { data: Uint8Array }).data;
        bytes.push([...data]);
        data[0] = 9;
      });
      expect(await probe.methods['sendBytes']!(null)).toBe(0);
      expect(bytes).toEqual([[1, 2, 3]]);
      const transferred = events.find((event) => event.event === 'onDidBytes');
      expect([...(transferred!.payload.value as { data: Uint8Array }).data]).toEqual([1, 2, 3]);

      expect(probe.methods['nope']).toBeUndefined();
      expect(() => runtime.getModel('not-an-instance')).toThrowError(
        expect.objectContaining({ code: 'model/unknown-instance' }),
      );

      await expect(probe.methods['fail']!(null)).rejects.toMatchObject({
        code: 'model/execution-failed',
      });
      expect(runtime.getState().status).toBe('faulted');
      await expect(runtime.step()).rejects.toMatchObject({ code: 'runtime/model-failed' });
      await expect(probe.methods['ping']!(null)).rejects.toMatchObject({
        code: 'runtime/model-failed',
      });
      expect(harness.diagnostics.map((entry) => entry.code)).toContain('model/execution-failed');

      await runtime.reset();
      expect(runtime.getState()).toEqual({ status: 'paused', simTime: toTimePs(0, 'ps') });
      await expect(runtime.getModel(PROBE_ID).methods['badEvent']!(null)).rejects.toMatchObject({
        code: 'model/invalid-event',
      });
      expect(runtime.getState().status).toBe('faulted');
      await runtime.reset();
      expect(await runtime.getModel(PROBE_ID).methods['ping']!(null)).toBe(1);
    } finally {
      await runtime.dispose();
    }
    // The initial board, the board replaced by each reset and the disposed session all released.\n    expect(state.disposed).toBe(3);
  });

  it('rejects inconsistent packages and layouts before any model factory runs', async () => {
    let factories = 0;
    const module = probeModule({ limit: 0, disposed: 0 });
    const counted = {
      model: module.model,
      create(context: never) {
        factories += 1;
        return (module.create as (value: never) => unknown)(context);
      },
    };

    const attempt = async (
      document: FusedDocument,
      manifest: UnifiedDeviceManifest = PROBE_MANIFEST,
      read?: (path: string) => Uint8Array | undefined,
    ): Promise<readonly string[]> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const registry = createRegistry({ [PROBE]: { manifest } });
      const wrapped: DeviceRegistry = {
        async open(lock) {
          const files = await registry.open(lock);
          if (read === undefined) {
            return files;
          }
          return {
            ...files,
            read: async (path: string) => {
              const bytes = read(path) ?? (await files.read(path));
              return bytes;
            },
          };
        },
      };
      await expect(
        createHeadlessRuntime({
          document,
          registry: wrapped,
          loadModule: async () => counted,
          step: STEP,
          onDiagnostic: (entry) => diagnostics.push(entry),
        }),
      ).rejects.toBeInstanceOf(Error);
      return diagnostics.map((entry) => entry.code);
    };

    // The engine range of the manifest is checked, not just its syntax.
    const incompatible: UnifiedDeviceManifest = { ...PROBE_MANIFEST, engines: { mica: '^2.0.0' } };
    expect(await attempt(probeDocument(1, incompatible), incompatible)).toContain(
      'package/unsupported-engine',
    );
    expect(factories).toBe(0);

    // Tampered package.json bytes break the declared file digest and the release identity.
    const tampered = (path: string): Uint8Array | undefined =>
      path === 'package.json' ? new TextEncoder().encode('{}') : undefined;
    expect(await attempt(probeDocument(1), PROBE_MANIFEST, tampered)).toContain(
      'package/integrity-mismatch',
    );
    expect(factories).toBe(0);

    // A layout may only name views the device declares.
    const withLayout = probeDocument(1);
    const layoutDocument: FusedDocument = {
      ...withLayout,
      instances: [
        {
          ...withLayout.instances[0]!,
          viewLayout: {
            properties: { height: 160, collapsed: false },
            views: [{ viewId: 'monitor', location: 'sidebar', height: 120, collapsed: false }],
          },
        },
      ],
    };
    expect(await attempt(layoutDocument)).toContain('document/invalid-view-layout');
    expect(factories).toBe(0);

    // An override of an undeclared property is rejected with the document pointer.
    const withUnknownProperty = probeDocument(1);
    const unknownDocument: FusedDocument = {
      ...withUnknownProperty,
      instances: [
        {
          ...withUnknownProperty.instances[0]!,
          properties: { limit: 1, mystery: 2 },
        },
      ],
    };
    expect(await attempt(unknownDocument)).toContain('schema/invalid-value');
    expect(factories).toBe(0);

    // The engine range of this runtime accepts the declared manifest.
    const runtime = await createHeadlessRuntime({
      document: probeDocument(7),
      registry: createRegistry({ [PROBE]: { manifest: PROBE_MANIFEST } }),
      loadModule: async () => probeModule({ limit: 0, disposed: 0 }),
      step: STEP,
    });
    expect(await runtime.getModel(PROBE_ID).methods['getLimit']!(null)).toBe(7);
    await runtime.dispose();
  });

  it('keeps verified bytes and the file table independent of the registry', async () => {
    const packageJson = JSON.stringify(PROBE_MANIFEST, null, 2);
    const stored = new TextEncoder().encode(packageJson);
    const table: Record<string, { size: number; integrity: string }> = {
      'package.json': {
        size: stored.length,
        integrity: `sha256:${createHash('sha256').update(stored).digest('hex')}`,
      },
    };
    const lock = {
      id: PROBE,
      version: PROBE_MANIFEST.version,
      integrity: sha256(
        canonicalJson({ id: PROBE, version: PROBE_MANIFEST.version, files: table }),
      ),
    };
    const verified = await openDevicePackage(
      {
        async open(requested) {
          return { lock: requested, files: table, read: async () => stored };
        },
      },
      lock,
    );

    // The declared table is a frozen snapshot, not the registry's live object.
    expect(Object.isFrozen(verified.files)).toBe(true);
    expect(Object.isFrozen(verified.files['package.json'])).toBe(true);
    table['package.json'] = { size: 0, integrity: `sha256:${'0'.repeat(64)}` };
    expect(verified.files['package.json']?.size).toBe(stored.length);

    // Verified reads hand out copies: writing to one result cannot poison the next read.
    const first = await verified.read('package.json');
    first.fill(0);
    const second = await verified.read('package.json');
    expect(new TextDecoder().decode(second)).toBe(packageJson);
    second.fill(0);
    expect(new TextDecoder().decode(stored)).toBe(packageJson);
  });

  it('surfaces listener and diagnostic sink failures instead of swallowing them', async () => {
    const harness = await start(probeDocument(5), {
      [`${PROBE}/model.js`]: probeModule({ limit: 0, disposed: 0 }),
    });
    const { runtime } = harness;
    try {
      runtime.onDidReportDiagnostic(() => {
        throw new Error('diagnostic listener exploded');
      });
      const probe = runtime.getModel(PROBE_ID);
      let delivered = 0;
      probe.events['onDidTick']!(() => {
        delivered += 1;
        throw new Error('event listener exploded');
      });
      expect(await probe.methods['ping']!(null)).toBe(1);
      // The failing listener is removed after its first failure; the model keeps running.
      expect(await probe.methods['ping']!(null)).toBe(2);
      expect(delivered).toBe(1);
      expect(runtime.getState().status).toBe('paused');
      // The failing diagnostic listener is reported through the sink instead of being swallowed.
      expect(harness.diagnostics.map((entry) => entry.code)).toContain(
        'runtime/presentation-failed',
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('falls back to the host console when the diagnostic sink itself fails', async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    let runtime: HeadlessRuntime | undefined;
    try {
      runtime = await createHeadlessRuntime({
        document: probeDocument(5),
        registry: createRegistry({ [PROBE]: { manifest: PROBE_MANIFEST } }),
        loadModule: async () => probeModule({ limit: 0, disposed: 0 }),
        step: STEP,
        onDiagnostic: () => {
          throw new Error('sink exploded');
        },
      });
      const probe = runtime.getModel(PROBE_ID);
      probe.events['onDidTick']!(() => {
        throw new Error('event listener exploded');
      });
      await probe.methods['ping']!(null);
      expect(logged.length).toBeGreaterThan(0);
      expect(runtime.getState().status).toBe('paused');
    } finally {
      spy.mockRestore();
      if (runtime !== undefined) {
        await runtime.dispose();
      }
    }
  });

  it('applies a query response before a later call produces events', async () => {
    const harness = await start(probeDocument(42), {
      [`${PROBE}/model.js`]: probeModule({ limit: 0, disposed: 0 }),
    });
    const { runtime } = harness;
    const order: string[] = [];
    try {
      const probe = runtime.getModel(PROBE_ID);
      probe.events['onDidTick']!(() => order.push('event'));
      for (const at of ['paused', 'running'] as const) {
        order.length = 0;
        if (at === 'running') {
          void runtime.resume();
        }
        const query = probe.methods['getLimit']!(null).then((value) => {
          order.push(`query:${String(value)}`);
        });
        const change = probe.methods['ping']!(null);
        await Promise.all([query, change]);
        if (at === 'running') {
          runtime.pause();
        }
        // The already-submitted query applies its result before the change event is delivered.
        expect(order, at).toEqual(['query:42', 'event']);
      }
    } finally {
      runtime.pause();
      await runtime.dispose();
    }
  });

  it('rejects a model whose dispose hook returns a thenable', async () => {
    const diagnostics: RuntimeDiagnostic[] = [];
    const runtime = await createHeadlessRuntime({
      document: probeDocument(1),
      registry: createRegistry({ [PROBE]: { manifest: PROBE_MANIFEST } }),
      loadModule: async () => {
        const base = probeModule({ limit: 0, disposed: 0 });
        return {
          model: base.model,
          create(context: never) {
            const instance = base.create(context) as {
              methods: Record<string, unknown>;
              sync(): void;
              dispose(): unknown;
            };
            return {
              methods: instance.methods,
              sync: () => instance.sync(),
              dispose: () => Promise.resolve(),
            };
          },
        };
      },
      step: STEP,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      await expect(runtime.dispose()).rejects.toMatchObject({ code: 'model/async-handler' });
      expect(diagnostics.map((entry) => entry.code)).toContain('model/async-handler');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a failed reset instead of pretending to succeed', async () => {
    const state: { limit: number; disposed: number; failDispose?: boolean } = {
      limit: 0,
      disposed: 0,
      failDispose: true,
    };
    const harness = await start(probeDocument(3), { [`${PROBE}/model.js`]: probeModule(state) });
    const { runtime } = harness;
    try {
      await expect(runtime.reset()).rejects.toMatchObject({ code: 'runtime/model-failed' });
      expect(runtime.getState().status).toBe('faulted');
      expect(harness.diagnostics.map((entry) => entry.code)).toContain('runtime/model-failed');
      expect(state.disposed).toBe(1);
      // A later reset starts from a clean session instead of inheriting the failure.
      await runtime.reset();
      expect(runtime.getState()).toEqual({ status: 'paused', simTime: toTimePs(0, 'ps') });
      expect(await runtime.getModel(PROBE_ID).methods['getLimit']!(null)).toBe(3);
    } finally {
      await runtime.dispose();
    }
  });

  it('matches engine ranges with standard semantics', () => {
    expect(satisfiesRange('1.4.2', '^1.0.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfiesRange('1.4.2', '1.x')).toBe(true);
    expect(satisfiesRange('2.1.0', '1.x')).toBe(false);
    expect(satisfiesRange('1.2.3', '1.0.0 - 1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.4', '1.0.0 - 1.2.3')).toBe(false);
    expect(satisfiesRange('1.4.2', '1')).toBe(true);
    expect(satisfiesRange('1.0.0-beta.1', '^1.0.0')).toBe(false);
    expect(satisfiesRange('1.0.0-beta.1', '>=1.0.0-beta.0 <1.0.0')).toBe(true);
    expect(satisfiesRange('1.4.2', 'not a range')).toBe(false);
    expect(satisfiesRange('1.4', '^1.0.0')).toBe(false);
  });

  it('captures targeted memory and filesystem projects once and reuses both on reset', async () => {
    const manifest: UnifiedDeviceManifest = {
      publisher: 'test',
      name: 'probe',
      version: '1.0.0',
      engines: { mica: '^1.0.0' },
      displayName: 'Program probe',
      properties: {
        limit: { type: 'number', default: 10 },
        program: {
          type: 'program',
          loader: 'memory',
          formats: ['bin'],
          addressSpaces: { code: { start: 0, size: 256 } },
          defaults: { addressSpace: 'code', loadAddress: 16 },
        },
        scripts: { type: 'program', loader: 'filesystem' },
      },
      model: {
        entry: 'model.js',
        methods: {
          getPrograms: {
            params: { type: 'null' },
            returns: {
              type: 'object',
              properties: {
                address: { type: 'number' },
                bytes: { type: 'array', items: { type: 'number' } },
                script: { type: 'string' },
              },
            },
          },
        },
      },
    };
    const binary = new Uint8Array([1, 2, 3]);
    const script = new TextEncoder().encode('print(1)');
    const resolve = vi.fn(async (_id: string, target: { property: string }) =>
      target.property === 'program'
        ? { kind: 'memory' as const, format: 'bin' as const, data: binary }
        : { kind: 'filesystem' as const, files: [{ path: 'main.py', data: script }] },
    );
    const runtime = await createHeadlessRuntime({
      document: {
        version: 2,
        dependencies: { [PROBE]: dependency(manifest) },
        instances: [
          {
            id: PROBE_ID,
            device: PROBE,
            placement: { x: 0, y: 0, rotation: 0 },
            properties: {
              program: { mode: 'project', projectId: 'shared' },
              scripts: { mode: 'project', projectId: 'shared' },
            },
          },
        ],
        nodes: [],
        wires: [],
        labels: [],
        references: [],
      },
      registry: createRegistry({ [PROBE]: { manifest } }),
      step: STEP,
      programs: { projects: { select: async () => ({ id: 'shared', title: 'Shared' }), resolve } },
      loadModule: async () => ({
        model: PROBE_MODEL,
        create(context: { props: Record<string, unknown> }) {
          const program = context.props['program'] as MemoryProgram;
          const scripts = context.props['scripts'] as ProgramFiles;
          return {
            methods: {
              getPrograms: () => ({
                address: program.segments[0]!.address,
                bytes: [...program.segments[0]!.data],
                script: new TextDecoder().decode(scripts.read('main.py').slice()),
              }),
            },
            sync() {},
            dispose() {},
          };
        },
      }),
    });
    binary.fill(9);
    script.fill(0);
    const expected = { address: 16, bytes: [1, 2, 3], script: 'print(1)' };
    expect(await runtime.getModel(PROBE_ID).methods['getPrograms']!(null)).toEqual(expected);
    await runtime.reset();
    expect(await runtime.getModel(PROBE_ID).methods['getPrograms']!(null)).toEqual(expected);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith('shared', {
      deviceId: PROBE,
      property: 'scripts',
      loader: 'filesystem',
    });
    await runtime.dispose();
  });

  it('loads BIN firmware into a read-only image and rejects other formats explicitly', async () => {
    const firmwareManifest: UnifiedDeviceManifest = {
      publisher: 'test',
      name: 'probe',
      version: '1.0.0',
      engines: { mica: '^1.0.0' },
      displayName: 'Probe',
      properties: {
        limit: { type: 'number', default: 10, min: 0 },
        asset: { type: 'binary', default: { src: 'assets/app.bin', mode: 'package' } },
        firmware: {
          type: 'firmware',
          maxBytes: 64,
          addressSpaces: { code: { start: 0, size: 256 } },
          addressSpace: 'code',
          loadAddress: 16,
        },
      },
      model: {
        entry: 'model.js',
        methods: {
          getSegment: { params: { type: 'null' }, returns: { ref: 'Segment' } },
          getAsset: { params: { type: 'null' }, returns: { ref: 'Asset' } },
        },
        types: {
          Asset: {
            type: 'object',
            properties: {
              bytes: { type: 'array', items: { type: 'number' } },
              mutable: { type: 'boolean' },
              writable: { type: 'boolean' },
            },
          },
          Segment: {
            type: 'object',
            properties: {
              address: { type: 'number' },
              bytes: { type: 'array', items: { type: 'number' } },
            },
          },
          Bytes: {
            type: 'object',
            properties: { bytes: { type: 'array', items: { type: 'number' } } },
          },
        },
      },
    };
    type Segment = { address: number; bytes: number[] };
    type Image = { segments: readonly { address: number; data: { slice(): Uint8Array } }[] };
    const module = {
      model: PROBE_MODEL,
      create(context: { props: Record<string, unknown> }) {
        const image = context.props['firmware'] as Image;
        const asset = context.props['asset'] as Uint8Array;
        return {
          methods: {
            getSegment(): Segment {
              const segment = image.segments[0]!;
              return { address: segment.address, bytes: [...segment.data.slice()] };
            },
            getAsset(): { bytes: number[]; mutable: boolean; writable: boolean } {
              const writable = ((): boolean => {
                try {
                  (asset as unknown as number[])[0] = 9;
                  return true;
                } catch {
                  return false;
                }
              })();
              return {
                bytes: [...asset],
                mutable: asset instanceof Uint8Array,
                writable,
              };
            },
          },
          sync() {},
          dispose() {},
        };
      },
    };
    const binFiles = { 'assets/app.bin': '\u0001\u0002\u0003\u0004' };
    const document: FusedDocument = {
      version: 2,
      dependencies: { [PROBE]: dependency(firmwareManifest, binFiles) },
      instances: [
        {
          id: PROBE_ID,
          device: PROBE,
          placement: { x: 0, y: 0, rotation: 0 },
          properties: { firmware: { src: 'assets/app.bin', mode: 'package' } },
        },
      ],
      nodes: [],
      wires: [],
      labels: [],
      references: [],
    };
    const registry = createRegistry({
      [PROBE]: { manifest: firmwareManifest, files: binFiles },
    });
    const runtime = await createHeadlessRuntime({
      document,
      registry,
      loadModule: async () => module,
      step: STEP,
    });
    const probe = runtime.getModel(PROBE_ID);
    expect(await probe.methods['getSegment']!(null)).toEqual({
      address: 16,
      bytes: [1, 2, 3, 4],
    });
    // A `binary` property reaches the factory as a read-only snapshot, not as mutable bytes.
    expect(await probe.methods['getAsset']!(null)).toEqual({
      bytes: [1, 2, 3, 4],
      mutable: false,
      writable: false,
    });
    await runtime.dispose();

    // A HEX source is recognized and rejected with an explicit limitation, not passed through.
    const hexFiles = {
      'assets/app.hex': ':00000001FF',
      'assets/app.bin': '\u0001\u0002\u0003\u0004',
    };
    const hexDocument: FusedDocument = {
      ...document,
      dependencies: { [PROBE]: dependency(firmwareManifest, hexFiles) },
      instances: [
        {
          ...document.instances[0]!,
          properties: { firmware: { src: 'assets/app.hex', mode: 'package' } },
        },
      ],
    };
    const diagnostics: RuntimeDiagnostic[] = [];
    await expect(
      createHeadlessRuntime({
        document: hexDocument,
        registry: createRegistry({
          [PROBE]: { manifest: firmwareManifest, files: hexFiles },
        }),
        loadModule: async () => module,
        step: STEP,
        onDiagnostic: (entry) => diagnostics.push(entry),
      }),
    ).rejects.toMatchObject({ code: 'firmware/unsupported-format' });
    expect(diagnostics.map((entry) => entry.code)).toContain('firmware/unsupported-format');
  });
});
