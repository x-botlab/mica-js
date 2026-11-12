/**
 * Board-level workloads that pin the engine paths behind the current performance issues.
 *
 * Each load is deliberately shaped like a real board so that the hotspot it presses is the
 * same one the issue measured, and each `verify` is a semantic guard: a wrong solver result,
 * a missing observation delivery or a mis-ordered guard refresh fails the sample instead of
 * silently producing a faster-but-broken number.
 *
 * - `port-model` (#266 / #255): generated device whose JIT blocks emit the port-modelling IR
 *   (`bytes`, `index`, `resistor`, `combineIntents`, `writeIntent`) and whose pins are sampled
 *   back through reactions. A block that contains an uncovered op is dropped whole, so this
 *   load measures the interpreter fallback that #266 describes.
 * - `topology-churn` (#263 / #264): GPIO -> resistor -> LED -> ground networks whose intent
 *   set changes on every step, forcing a new topology key each solve, plus single-branch leaf
 *   pins whose target node sits in a component that contains both VCC and GND (the exact
 *   condition under which the leaf fast path is disabled today).
 * - `observer-churn` (#273): one observed source that reads a different state per JIT block, so
 *   subscriber membership — and with it `directStateGuards` and the direct-program cache key —
 *   changes on every block. The source deliberately keeps the generic observation path (see
 *   `tagOf`), because a generated chain binds one static resource set at baseline.
 * - `wide-memory` (#254 / #266): JIT blocks mixing `store32le` / `load32le` / `store16le`, and
 *   the whole memory image is compared against a reference model.
 *
 * Determinism: every load is driven by the step index (or by a state the load advances itself),
 * never by clocks or unseeded randomness, and no per-step state is accumulated in JavaScript.
 */
import assert from 'node:assert/strict';
import { createDeviceBuilder, types } from '../../../device-model/dist/index.js';

export const boardNames = ['port-model', 'topology-churn', 'observer-churn', 'wide-memory'];

const endpoint = (instance, pin) => ({ instance, pin });
const rails = (ids) => [
  { id: 'supply', voltage: 3.3, pins: ids.map((id) => endpoint(id, 'supply')) },
  { id: 'reference', voltage: 0, pins: ids.map((id) => endpoint(id, 'reference')) },
];

/** Counts runtime diagnostics so a load can assert the board never faulted. */
function watchErrors(board) {
  const diagnostics = [];
  board.onDidError((diagnostic) => diagnostics.push(diagnostic));
  return diagnostics;
}

/**
 * Devices that attach a JIT are built through the device builder, and their adapter factory
 * needs per-board state that only exists once assembly starts; the state is published on a
 * closure slot for the duration of `createBoard` only.
 */
function jitLibrary(createDeviceLibrary, model, createAdapter) {
  let assembling;
  const library = createDeviceLibrary([
    { id: 'bench', model, create: (context) => createAdapter(context, assembling) },
  ]);
  return (createBoard, nets, state) => {
    assembling = state;
    try {
      return createBoard(library, { instances: [{ id: 'bench', type: 'bench' }], nets });
    } finally {
      assembling = undefined;
    }
  };
}

/**
 * Intent shapes of `port-model`. Each shape is a real port-model writing: drive high, drive
 * low, a resistive divider (both rails) and a released pin without any branch.
 */
const portShapes = 4;
const portCodes = [
  1, // high: single resistor to the supply rail
  0, // low: single resistor to the reference rail
  3, // both: equal divider between the rails, 1.65 V resolves to unknown
  2, // released: no branch at all, the pin floats and has no voltage
];

function portIntent(b, shape) {
  const high = (c) => c.combineIntents(c.resistor(c.pin('supply'), c.constant(types.number, 25)));
  const low = (c) => c.combineIntents(c.resistor(c.pin('reference'), c.constant(types.number, 25)));
  const both = (c) =>
    c.combineIntents(
      c.resistor(c.pin('supply'), c.constant(types.number, 25)),
      c.resistor(c.pin('reference'), c.constant(types.number, 25)),
    );
  const released = (c) => c.combineIntents();
  return b.select(
    types.intent,
    b.equal(types.number, shape, b.constant(types.number, 0)),
    high,
    (onLow) =>
      onLow.select(
        types.intent,
        onLow.equal(types.number, shape, onLow.constant(types.number, 1)),
        low,
        (onBoth) =>
          onBoth.select(
            types.intent,
            onBoth.equal(types.number, shape, onBoth.constant(types.number, 2)),
            both,
            released,
          ),
      ),
  );
}

/** Level/status classification shared by every port reaction: 1 high, 0 low, 2 float, 3 mid. */
function portCode(b, current) {
  return b.select(
    types.number,
    b.equal(types.logic, b.field(current, 'level'), types.logic.members.high),
    (c) => c.constant(types.number, 1),
    (onNotHigh) =>
      onNotHigh.select(
        types.number,
        onNotHigh.equal(types.logic, onNotHigh.field(current, 'level'), types.logic.members.low),
        (c) => c.constant(types.number, 0),
        (onUnknown) =>
          onUnknown.select(
            types.number,
            onUnknown.equal(
              types.sampleStatus,
              onUnknown.field(current, 'status'),
              types.sampleStatus.members.floating,
            ),
            (c) => c.constant(types.number, 2),
            (c) => c.constant(types.number, 3),
          ),
      ),
  );
}

function portModelDevice(ports) {
  const builder = createDeviceBuilder({ name: 'PortModelBench' });
  builder.memory({ name: 'code', length: 16 });
  builder.memory({ name: 'evidence', length: ports, public: true });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'cycle', type: types.number, initial: 0 });
  builder.pin({ name: 'supply' });
  builder.pin({ name: 'reference' });
  for (let port = 0; port < ports; port++) {
    builder.pin({
      name: `p${port}`,
      low: 0.8,
      high: 2.0,
      // A driven rest state, so releasing the pin is a real sample change.
      initial: (b) =>
        b.returnValue(
          b.combineIntents(b.resistor(b.pin('reference'), b.constant(types.number, 25))),
        ),
    });
    builder.reaction(
      {
        name: `watch${port}`,
        sourcePath: [`p${port}`, 'sample'],
        sourceType: types.sample,
        previous: 'previous',
        current: 'current',
        captures: [],
      },
      {},
      (b, { current }) => {
        b.store8('evidence', b.constant(types.number, port), portCode(b, current));
      },
    );
  }
  return builder.finish();
}

function portTranslator(ports) {
  // Every block models one port: the table lookup and the intent construction are the IR
  // shapes #266 reports as uncovered, so a single missing op drops the whole block.
  const shapes = new Uint8Array([0, 1, 2, 3]);
  return ({ pc }, block) => {
    block.instruction({ pc, nextPc: (pc + 1) % ports }, (b) => {
      const cycle = b.readState('cycle', types.number);
      const shape = b.index(b.bytes(...shapes), b.remainder(cycle, b.constant(types.number, 4)));
      b.writeIntent(`p${pc}`, portIntent(b, shape));
      if (pc === ports - 1) b.writeState('cycle', b.add(cycle, b.constant(types.number, 1)));
      b.elapse(1);
    });
    return block.finish();
  };
}

async function preparePortModel({ size, createDeviceLibrary, createBoard }) {
  const ports = size * 4;
  const assemble = jitLibrary(createDeviceLibrary, portModelDevice(ports), (context, state) => {
    const registration = context.attachJit({
      entry: 'bench',
      code: 'code',
      pc: 'pc',
      translate: portTranslator(ports),
    });
    try {
      context.loadBytes('code', new Uint8Array(16));
      state.evidence = context.memory.evidence;
    } catch (cause) {
      registration.dispose();
      throw cause;
    }
    return { sync() {}, dispose: () => registration.dispose() };
  });
  return {
    unit: 'intentWrites',
    description:
      `${ports} modelled GPIO ports driven by one JIT block per port; table lookup, intent ` +
      'construction (resistor/combineIntents) and the intent write are the port-modelling IR ' +
      'that #266 reports as uncovered, so an uncovered op falls back to the interpreter for ' +
      'the whole block. Each step rewrites every intent and the electrical solve classifies ' +
      'the resulting sample; verification compares the sampled class per shape.',
    create() {
      const state = { evidence: null };
      const board = assemble(createBoard, rails(['bench']), state);
      const diagnostics = watchErrors(board);
      let steps = 0;
      return {
        board,
        operationsPerStep: ports,
        initialize() {
          board.runUntil(0);
          assert.equal(board.status, 'ready');
          assert.equal(board.time, 0);
        },
        step() {
          steps++;
          board.runUntil(board.time + ports);
        },
        verify(completed) {
          assert.equal(steps, completed);
          assert.equal(board.time, completed * ports, 'one sim picosecond per modelled port');
          assert.equal(board.status, 'ready');
          assert.equal(diagnostics.length, 0, 'port modelling must not report diagnostics');
          const shape = (completed - 1) % portShapes;
          for (let port = 0; port < ports; port++)
            assert.equal(
              state.evidence[port],
              portCodes[shape],
              `port ${port} sample must match the last intent (shape ${shape})`,
            );
        },
        dispose() {
          board.dispose();
        },
      };
    },
  };
}

async function prepareTopologyChurn({ size, compile, createDeviceLibrary, createBoard }) {
  const channels = size * 2;
  // A GPIO output stage, the LED series resistor, the LED equivalent resistance to ground, a
  // single-branch leaf branch and a rest state that none of the drive shapes repeats.
  const drive = 25;
  const series = 220;
  const led = 1500;
  const leafResistance = 1000;
  const rest = 5000;
  const drivenVoltage = (3.3 * led) / (drive + series + led);
  const model = await compile(`device TopologyBenchmark {
    pin supply;
    pin reference;
    ${Array.from(
      { length: channels },
      (_, channel) => `pin drive${channel} =
      [resistor(to: supply, resistance: ${rest})];
    pin node${channel} = [
      resistor(to: drive${channel}, resistance: ${series}),
      resistor(to: reference, resistance: ${led})
    ];
    pin leaf${channel} = [resistor(to: node${channel}, resistance: ${leafResistance})];`,
    ).join('\n')}

    input channel tick: number(capacity: 1);
    record Reading { leaf: bool; channel: number; voltage: number; }
    output channel readings: Reading(capacity: ${channels * 2});

    fn publish(leaf: bool, channel: number, raw: sample) {
      const voltage = raw.voltage;
      if voltage != none {
        readings.send({ leaf: leaf, channel: channel, voltage: voltage });
      } else {
        assert false, "Every monitored node stays referenced";
      }
    }

    ${Array.from(
      { length: channels },
      (
        _,
        channel,
      ) => `reaction nodeChanged${channel} on node${channel}.sample as (previous, current) {
      publish(false, ${channel}, current);
    }
    reaction leafChanged${channel} on leaf${channel}.sample as (previous, current) {
      publish(true, ${channel}, current);
    }`,
    ).join('\n')}

    process start {
      loop {
        const step = await tick.receive();
        ${Array.from(
          { length: channels },
          (_, channel) => `match (step + ${channel}) % 4 {
          0 => { drive${channel}.intent <- [resistor(to: supply, resistance: ${drive})]; }
          1 => { drive${channel}.intent <- [resistor(to: reference, resistance: ${drive})]; }
          2 => { drive${channel}.intent <- [resistor(to: supply, resistance: ${drive})]; }
          _ => { drive${channel}.intent <- []; }
        }`,
        ).join('\n        ')}
      }
    }
  }`);
  let active;
  const library = createDeviceLibrary([
    {
      id: 'topology',
      model,
      create(context) {
        const state = active;
        state.context = context;
        return {
          sync(batch) {
            state.readings.push(...batch.outputs.readings);
          },
          dispose() {},
        };
      },
    },
  ]);
  return {
    unit: 'channelUpdates',
    description:
      `${channels} GPIO -> ${series} ohm -> LED -> ground networks on one board; the ` +
      'intent set changes for every channel on every step so each solve builds a new topology ' +
      'key, and every network carries a single-branch leaf pin whose target node sits in the ' +
      'component that ties VCC to ground through the load (#264). Readings are checked against ' +
      'the closed-form divider, and each leaf must equal its target node voltage.',
    create() {
      active = { context: null, readings: [] };
      const state = active;
      const board = createBoard(library, {
        instances: [{ id: 'topology', type: 'topology' }],
        nets: rails(['topology']),
      });
      const diagnostics = watchErrors(board);
      let steps = 0;
      return {
        board,
        operationsPerStep: channels,
        initialize() {
          board.runUntil(0);
          assert.equal(board.status, 'ready');
          assert.equal(state.readings.length, 0, 'no sample changes before the first drive');
        },
        step(index) {
          state.readings.length = 0;
          state.context.inputs.tick.send(index);
          steps++;
          board.runUntil(board.time + 1);
        },
        verify(completed) {
          assert.equal(steps, completed);
          assert.equal(board.time, completed);
          assert.equal(board.status, 'ready');
          assert.equal(diagnostics.length, 0, 'the fixture must never fault');
          assert.equal(state.readings.length, channels * 2, 'each node and leaf publishes once');
          const nodes = new Array(channels).fill(undefined);
          const leaves = new Array(channels).fill(undefined);
          for (const reading of state.readings) {
            // Samples are published by the solve of the step that wrote the intents, so they
            // carry the step start time rather than the advanced board time.
            assert.equal(reading.time, completed - 1);
            assert(reading.value.channel >= 0 && reading.value.channel < channels);
            const target = reading.value.leaf ? leaves : nodes;
            assert.equal(target[reading.value.channel], undefined, 'duplicate reading');
            target[reading.value.channel] = reading.value.voltage;
          }
          for (let channel = 0; channel < channels; channel++) {
            // 0 drives high, 1 drives low, 2 drives high again, 3 releases the pin.
            const shape = (completed - 1 + channel) % 4;
            const expected = shape === 1 || shape === 3 ? 0 : drivenVoltage;
            assert.ok(
              Math.abs(nodes[channel] - expected) <= 1e-9,
              `channel ${channel} node ${nodes[channel]} != ${expected}`,
            );
            assert.ok(
              Math.abs(leaves[channel] - nodes[channel]) <= 1e-9,
              `channel ${channel} leaf ${leaves[channel]} must equal its target node ${nodes[channel]}`,
            );
          }
        },
        dispose() {
          board.dispose();
        },
      };
    },
  };
}

function observerDevice(probes) {
  const builder = createDeviceBuilder({ name: 'ObserverBench' });
  builder.memory({ name: 'code', length: 16 });
  builder.memory({ name: 'scratch', length: 4 });
  builder.memory({ name: 'evidence', length: probes + 1, public: true });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'stamp', type: types.number, initial: 0 });
  // Starting at the last probe keeps the very first block a real source change.
  builder.state({ name: 'sel', type: types.number, initial: probes - 1 });
  builder.state({ name: 'cursor', type: types.number, initial: 0 });
  builder.state({ name: 'fires', type: types.number, initial: 0 });
  for (let probe = 0; probe < probes; probe++)
    builder.state({ name: `probe${probe}`, type: types.number, initial: probe + 1 });
  // A pure call that carries a memory parameter keeps this source on the generic
  // observation path, which is the only path whose resource set is recomputed per round;
  // a generated chain binds one static slot set and would keep the guards constant.
  builder.pureFn(
    {
      name: 'tagOf',
      params: [
        { name: 'table', type: types.memory },
        { name: 'offset', type: types.number },
      ],
      returns: types.number,
    },
    (b, args) => {
      b.returnValue(b.load8(args.table, args.offset));
    },
  );
  // The observed source reads the selector plus exactly one probe, so its resource set moves.
  builder.derived({ name: 'watched', type: types.number }, (b) => {
    b.callPureValue('tagOf', types.number, b.memory('scratch'), b.constant(types.number, 0));
    const selector = b.readState('sel', types.number);
    // Statement-level branches read lazily: a `select` would evaluate every probe and keep
    // the observed resource set constant, which is precisely the churn this load needs.
    // Statement-level branches keep the untaken probe unread, so the observed resource set
    // follows the selector. A `select` would read both branches.
    const pick = (probe, body) =>
      body.if(
        body.equal(types.number, selector, body.constant(types.number, probe)),
        (yes) => yes.returnValue(yes.readState(`probe${probe}`, types.number)),
        (no) =>
          probe + 1 === probes
            ? no.returnValue(no.readState(`probe${probes - 1}`, types.number))
            : pick(probe + 1, no),
      );
    pick(0, b);
  });
  builder.on({ name: 'observeWatched', sourcePath: ['watched'] }, (b) => {
    const cursor = b.readState('cursor', types.number);
    const fires = b.readState('fires', types.number);
    b.store8('evidence', cursor, b.readDerived('watched', types.number));
    b.store8(
      'evidence',
      b.constant(types.number, probes),
      b.bitAnd(b.add(fires, b.constant(types.number, 1)), b.constant(types.number, 255)),
    );
    b.writeState(
      'cursor',
      b.remainder(b.add(cursor, b.constant(types.number, 1)), b.constant(types.number, probes)),
    );
    b.writeState('fires', b.add(fires, b.constant(types.number, 1)));
  });
  return builder.finish();
}

function observerTranslator(probes) {
  // One block per probe: the selector write moves the observed resource set, which rewrites
  // the direct-program guard key on every round.
  return ({ pc }, block) => {
    block.instruction({ pc, nextPc: (pc + 1) % probes }, (b) => {
      b.writeState('sel', b.constant(types.number, pc));
      b.writeState('stamp', b.add(b.readState('stamp', types.number), b.constant(types.number, 1)));
      b.elapse(1);
    });
    return block.finish();
  };
}

/** Guard signature of the single JIT on this board; `undefined` when internals move. */
function guardSignature(board) {
  const jit = board.instances?.[0]?.jits?.[0];
  const states = jit?.directStateGuards;
  if (!(states instanceof Set)) return undefined;
  return [...states].sort().join(',');
}

/** Observation revision of the single instance; bumped whenever subscriber membership moves. */
function observerRevision(board) {
  const revision = board.instances?.[0]?.observerRevision;
  return typeof revision === 'number' ? revision : undefined;
}

async function prepareObserverChurn({ size, createDeviceLibrary, createBoard }) {
  const probes = size * 2;
  const assemble = jitLibrary(createDeviceLibrary, observerDevice(probes), (context, state) => {
    const registration = context.attachJit({
      entry: 'bench',
      code: 'code',
      pc: 'pc',
      translate: observerTranslator(probes),
    });
    try {
      context.loadBytes('code', new Uint8Array(16));
      state.evidence = context.memory.evidence;
    } catch (cause) {
      registration.dispose();
      throw cause;
    }
    return { sync() {}, dispose: () => registration.dispose() };
  });
  return {
    unit: 'observerRefreshes',
    description:
      `${probes} JIT blocks that each move one observed state set; the observed source reads a ` +
      'different probe state per block, so subscriber membership (and therefore ' +
      'directStateGuards / the direct-program cache key) changes on every block (#273). Steps ' +
      'walk one full block cycle; verification compares the delivered update ring with the ' +
      'expected delivery sequence and its count.',
    create() {
      const state = {
        evidence: null,
        signatures: new Set(),
        genericSource: false,
        revisionDelta: undefined,
      };
      const board = assemble(createBoard, [], state);
      const diagnostics = watchErrors(board);
      let steps = 0;
      return {
        board,
        operationsPerStep: probes,
        initialize() {
          board.runUntil(0);
          assert.equal(board.status, 'ready');
          assert.equal(state.evidence[probes], 0, 'no update before the first block runs');
          // Baseline binds every source; the observation probe is a documented test-only view
          // that names the sources kept on the generic path, i.e. the ones whose resource set
          // is recomputed on every round.
          const probe = board[Symbol.for('mica-js.simulator/observations')];
          const report = typeof probe === 'function' ? probe() : undefined;
          state.genericSource = Boolean(
            report?.skipped?.some((entry) => entry.key.includes('watched')),
          );
        },
        step() {
          steps++;
          const target = board.time + probes;
          const revision = observerRevision(board);
          // Sample the guard set once mid-cycle as well: the guard refresh lags one block, so a
          // single end-of-step snapshot aliases with the cycle length.
          board.runUntil(board.time + 1);
          const mid = guardSignature(board);
          if (mid !== undefined) state.signatures.add(mid);
          board.runUntil(target);
          const signature = guardSignature(board);
          if (signature !== undefined) state.signatures.add(signature);
          const after = observerRevision(board);
          if (revision !== undefined && after !== undefined) state.revisionDelta = after - revision;
        },
        verify(completed) {
          assert.equal(steps, completed);
          assert.equal(board.time, completed * probes, 'one block per picosecond');
          assert.equal(board.status, 'ready');
          assert.equal(diagnostics.length, 0);
          // A full cycle over all probes delivers exactly one update per probe, in block order.
          for (let probe = 0; probe < probes; probe++)
            assert.equal(
              state.evidence[probe],
              probe + 1,
              `update ${probe} must be delivered in block order`,
            );
          assert.equal(
            state.evidence[probes],
            (completed * probes) & 255,
            'update count must match one delivery per block',
          );
          // Guard churn is only structurally possible while the source keeps the generic
          // observation path; a generated chain binds one static resource set at baseline.
          if (state.revisionDelta !== undefined)
            assert.equal(
              state.revisionDelta,
              probes * 2,
              'every block must move the observed resource set',
            );
          if (completed >= 2 && state.genericSource && state.signatures.size)
            assert.ok(
              state.signatures.size >= 2,
              'the observed resource set must move the direct-JIT guard key',
            );
        },
        dispose() {
          board.dispose();
        },
      };
    },
  };
}

/** Fixed memory image and per-window stride shared by the generated device and its model. */
const wideMemoryLength = 128;

function wideMemoryDevice() {
  const builder = createDeviceBuilder({ name: 'WideMemoryBench' });
  builder.memory({ name: 'code', length: 16 });
  builder.memory({ name: 'ram', length: wideMemoryLength, public: true });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'stamp', type: types.number, initial: 0 });
  return builder.finish();
}

function wideMemoryTranslator(windows) {
  return ({ pc }, block) => {
    const window = pc * 4;
    block.instruction({ pc, nextPc: (pc + 1) % windows }, (b) => {
      const stamp = b.readState('stamp', types.number);
      b.store32le(
        'ram',
        b.constant(types.number, window),
        b.bitAnd(
          b.multiply(stamp, b.constant(types.number, 65599)),
          b.constant(types.number, 0xffffffff),
        ),
      );
      // Read a neighbouring window and fold it back as a half-word: verification of the
      // memory image then covers both wide loads and narrow stores.
      b.store16le(
        'ram',
        b.constant(types.number, (window + 2) % wideMemoryLength),
        b.bitAnd(
          b.load32le('ram', b.constant(types.number, (window + 8) % wideMemoryLength)),
          b.constant(types.number, 0xffff),
        ),
      );
      b.writeState('stamp', b.add(stamp, b.constant(types.number, 1)));
      b.elapse(1);
    });
    return block.finish();
  };
}

/** Reference model for [rounds] rounds of the generated wide-access block. */
function wideMemoryReference(rounds, windows) {
  const bytes = new Uint8Array(wideMemoryLength);
  const view = new DataView(bytes.buffer);
  for (let round = 0; round < rounds; round++) {
    const window = (round % windows) * 4;
    view.setUint32(window, (round * 65599) & 0xffffffff, true);
    const next = (window + 8) % wideMemoryLength;
    view.setUint16((window + 2) % wideMemoryLength, view.getUint32(next, true) & 0xffff, true);
  }
  return bytes;
}

async function prepareWideMemory({ size, createDeviceLibrary, createBoard }) {
  const windows = size * 2;
  const assemble = jitLibrary(createDeviceLibrary, wideMemoryDevice(), (context, state) => {
    const registration = context.attachJit({
      entry: 'bench',
      code: 'code',
      pc: 'pc',
      translate: wideMemoryTranslator(windows),
    });
    try {
      context.loadBytes('code', new Uint8Array(16));
      state.ram = context.memory.ram;
    } catch (cause) {
      registration.dispose();
      throw cause;
    }
    return { sync() {}, dispose: () => registration.dispose() };
  });
  return {
    unit: 'wideAccesses',
    description:
      `${windows} JIT blocks performing store32/load32/store16 mixes over one ${wideMemoryLength}-` +
      'byte memory; wide loads and stores are the ops #254 reports as uncovered, so a block ' +
      'falls back for the interpreter whenever they are. Verification rebuilds the whole ' +
      'memory image from a reference model, which pins endianness, width and ordering.',
    create() {
      const state = { ram: null };
      const board = assemble(createBoard, [], state);
      const diagnostics = watchErrors(board);
      let steps = 0;
      return {
        board,
        operationsPerStep: windows * 12,
        initialize() {
          board.runUntil(0);
          assert.equal(board.status, 'ready');
          assert.equal(board.time, 0);
        },
        step() {
          steps++;
          // Four passes over every window per step keeps the measured region long enough to
          // resolve without making the load size-sensitive.
          board.runUntil(board.time + windows * 4);
        },
        verify(completed) {
          assert.equal(steps, completed);
          const rounds = completed * windows * 4;
          assert.equal(board.time, rounds);
          assert.equal(board.status, 'ready');
          assert.equal(diagnostics.length, 0);
          const expected = wideMemoryReference(rounds, windows);
          for (let offset = 0; offset < wideMemoryLength; offset++)
            assert.equal(
              state.ram[offset],
              expected[offset],
              `memory byte ${offset} after ${rounds} wide rounds`,
            );
        },
        dispose() {
          board.dispose();
        },
      };
    },
  };
}

export async function prepareBoard(name, tools) {
  assert.ok(Number.isSafeInteger(tools.size) && tools.size > 0, 'size must be a positive integer');
  if (name === 'port-model') return preparePortModel(tools);
  if (name === 'topology-churn') return prepareTopologyChurn(tools);
  if (name === 'observer-churn') return prepareObserverChurn(tools);
  if (name === 'wide-memory') return prepareWideMemory(tools);
  throw new RangeError(`Unknown board workload: ${name}`);
}
