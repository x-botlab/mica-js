import {
  createIRInterpreter,
  createIRJIT,
  createIRModule,
  fromNumber,
  toNumber,
} from '@mica-js/ir';
import type { ArrayRef, StateRef } from '@mica-js/ir';
import { describe, expect, test } from 'vitest';
import { prepareElectricalDevice } from './electrical-authoring';
import { allocateElectricalNetwork } from './unified-ir/compiler/electrical-network';
import { generateResistiveSolver, RESISTIVE_FAULT } from './unified-ir/compiler/resistive-solver';
import type { ResistiveNetwork } from './unified-ir/compiler/resistive-solver';
import { createModuleValidation } from './unified-ir/validation';

const divider = (): ResistiveNetwork => ({
  nodes: 3,
  resistors: [
    { a: 0, b: 1, resistance: 1000, enabled: true },
    { a: 1, b: 2, resistance: 1000, enabled: true },
  ],
  sources: [
    { node: 0, voltage: 3.3, enabled: true },
    { node: 2, voltage: 0, enabled: true },
  ],
  contacts: [],
});

const independentLadders = (): ResistiveNetwork => ({
  nodes: 7,
  resistors: [
    { a: 0, b: 2, resistance: 1000, enabled: true },
    { a: 2, b: 3, resistance: 1000, enabled: true },
    { a: 3, b: 1, resistance: 1000, enabled: true },
    { a: 6, b: 4, resistance: 1000, enabled: true },
    { a: 4, b: 5, resistance: 1000, enabled: true },
    { a: 5, b: 1, resistance: 1000, enabled: true },
  ],
  sources: [
    { node: 0, voltage: 3.3, enabled: true },
    { node: 1, voltage: 0, enabled: true },
    { node: 6, voltage: 5, enabled: true },
  ],
  contacts: [{ a: 3, b: 4, closed: false }],
});

function probe(network: ResistiveNetwork, engine: 'reference' | 'jit') {
  const module = createIRModule();
  const solver = generateResistiveSolver(module, network, 'test');
  const trace = module.array('trace', 'f64', Array<number>(64 * network.nodes).fill(0));
  const completed = module.state('trace_completed', 'u32', 0);
  const batch = module.func('trace_batch', { params: ['u32'], results: [] });
  batch.body((b, [count]) => {
    const header = b.block(['u32']);
    const body = b.block(['u32']);
    const done = b.block([]);
    b.jump(header, [b.const('u32', 0)]);
    b.at(header, (b, [tick]) =>
      b.branch(
        b.int.cmp('lt', tick, count),
        { target: body, args: [tick] },
        { target: done, args: [] },
      ),
    );
    b.at(body, (b, [tick]) => {
      b.array.store(
        solver.sourceVoltage,
        b.const('u32', 0),
        b.float.sub(b.const('f64', 3.3), b.array.load(solver.sourceVoltage, b.const('u32', 0))),
      );
      b.call(solver.invalidate.rhs, []);
      b.call(solver.solve, []);
      const base = b.int.mul(b.state.load(completed), b.const('u32', network.nodes));
      for (let node = 0; node < network.nodes; node++)
        b.array.store(
          trace,
          b.int.add(base, b.const('u32', node)),
          b.array.load(solver.voltage, b.const('u32', node)),
        );
      b.state.store(completed, b.int.add(b.state.load(completed), b.const('u32', 1)));
      b.jump(header, [b.int.add(tick, b.const('u32', 1))]);
    });
    b.at(done, (b) => b.return([]));
  });
  const options = { validation: createModuleValidation(module), maxSteps: 10_000_000 };
  const createRuntime = () =>
    engine === 'jit'
      ? createIRJIT(module, { ...options, jit: { tierUpThreshold: 0 } })
      : createIRInterpreter(module, options);
  let runtime = createRuntime();
  const read = (array: ArrayRef<'f64'> | ArrayRef<'u8'>, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const value = runtime.storage.loadArray(array, i);
      return typeof value === 'number' ? value : toNumber(value);
    });
  return {
    solver,
    groups: () => ({
      rebuilds: Array.from({ length: network.nodes }, (_, i) =>
        runtime.storage.loadArray(solver.groupRebuilds, i),
      ),
      solves: Array.from({ length: network.nodes }, (_, i) =>
        runtime.storage.loadArray(solver.groupSolves, i),
      ),
    }),
    solve: () =>
      runtime.execute(solver.solve, [], { instanceId: 'resistive-test', virtualTime: 0 }),
    number: (array: ArrayRef<'f64'>, i: number, value: number) => {
      runtime.storage.storeArray(array, i, fromNumber('f64', value));
      runtime.execute(
        array === solver.sourceVoltage ? solver.invalidate.rhs : solver.invalidate.matrix,
        [],
        { instanceId: 'resistive-test', virtualTime: 0 },
      );
    },
    flag: (array: ArrayRef<'bool'>, i: number, value: boolean) => {
      runtime.storage.storeArray(array, i, value);
      runtime.execute(
        array === solver.contactClosed ? solver.invalidate.topology : solver.invalidate.matrix,
        [],
        { instanceId: 'resistive-test', virtualTime: 0 },
      );
    },
    snapshot: () => ({
      voltage: read(solver.voltage, network.nodes),
      voltageState: read(solver.voltageState, network.nodes),
      current: read(solver.current, network.resistors.length),
      currentState: read(solver.currentState, network.resistors.length),
      sourceCurrent: read(solver.sourceCurrent, network.sources.length),
      sourceCurrentState: read(solver.sourceCurrentState, network.sources.length),
      fault: runtime.storage.loadState(solver.fault),
      factors: runtime.storage.loadState(solver.factorizations),
    }),
    runBatch: (count: number) =>
      runtime.execute(batch, [count], { instanceId: 'resistive-test', virtualTime: 0 }),
    trace: () => read(trace, 64 * network.nodes),
    seedVersion: (version: StateRef<'u32'>, value: number) =>
      runtime.storage.storeState(version, value),
    reset: () => {
      runtime = createRuntime();
    },
  };
}

for (const engine of ['reference', 'jit'] as const) {
  describe(`resistive IR (${engine})`, () => {
    test('switches the direct singleton path to general solving when a source is disabled', () => {
      const p = probe(divider(), engine);
      p.solve();
      const initial = p.snapshot();
      p.flag(p.solver.sourceEnabled, 0, false);
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      expect(p.snapshot().voltage).toEqual([0, 0, 0]);
      p.flag(p.solver.sourceEnabled, 0, true);
      p.solve();
      expect(p.snapshot().voltage).toEqual(initial.voltage);
      p.flag(p.solver.resistorEnabled, 0, false);
      p.solve();
      expect(p.snapshot().voltage[1]).toBe(0);
      p.flag(p.solver.resistorEnabled, 1, false);
      p.solve();
      expect(p.snapshot().voltageState).toEqual([0, 1, 0]);
      expect(p.snapshot().current).toEqual([0, 0]);
      p.flag(p.solver.resistorEnabled, 0, true);
      p.solve();
      expect(p.snapshot().voltage[1]).toBe(3.3);
      expect(p.snapshot().voltageState).toEqual([0, 0, 0]);
    });

    test('rebuilds and solves only affected unknown groups across shared fixed rails', () => {
      const p = probe(independentLadders(), engine);
      p.solve();
      expect(p.groups().rebuilds).toEqual([0, 0, 1, 0, 1, 0, 0]);
      expect(p.groups().solves).toEqual([0, 0, 1, 0, 1, 0, 0]);
      const untouched = p.snapshot().voltage.slice(4, 6);
      p.number(p.solver.resistance, 0, 2000);
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      expect(p.snapshot().voltage[2]).toBeCloseTo(1.65, 12);
      expect(p.snapshot().voltage[3]).toBeCloseTo(0.825, 12);
      expect(p.snapshot().voltage.slice(4, 6)).toEqual(untouched);
      expect(p.groups().rebuilds).toEqual([0, 0, 2, 0, 1, 0, 0]);
      expect(p.groups().solves).toEqual([0, 0, 2, 0, 1, 0, 0]);
      p.number(p.solver.sourceVoltage, 0, 6.6);
      p.solve();
      expect(p.snapshot().voltage[2]).toBeCloseTo(3.3, 12);
      expect(p.groups().rebuilds).toEqual([0, 0, 2, 0, 1, 0, 0]);
      expect(p.groups().solves).toEqual([0, 0, 3, 0, 1, 0, 0]);
      p.number(p.solver.sourceVoltage, 2, 6);
      p.solve();
      expect(p.snapshot().voltage[4]).toBeCloseTo(4, 12);
      expect(p.groups().solves).toEqual([0, 0, 3, 0, 2, 0, 0]);
      p.solve();
      expect(p.groups().solves).toEqual([0, 0, 3, 0, 2, 0, 0]);
    });

    test('repartitions when ideal boundaries disappear or contacts join and split groups', () => {
      const p = probe(independentLadders(), engine);
      p.solve();
      const initial = p.snapshot();
      p.flag(p.solver.sourceEnabled, 0, false);
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      expect(p.snapshot().voltage.slice(0, 4)).toEqual([0, 0, 0, 0]);
      expect(p.snapshot().voltage.slice(4, 7)).toEqual(initial.voltage.slice(4, 7));
      p.flag(p.solver.sourceEnabled, 0, true);
      p.solve();
      expect(p.snapshot().voltage).toEqual(initial.voltage);
      p.flag(p.solver.contactClosed, 0, true);
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      const joined = (3.3 / 2000 + 5 / 1000) / (1 / 2000 + 1 / 1000 + 1 / 1000 + 1 / 2000);
      expect(p.snapshot().voltage[3]).toBeCloseTo(joined, 12);
      expect(p.snapshot().voltage[4]).toBeCloseTo(joined, 12);
      p.flag(p.solver.contactClosed, 0, false);
      p.solve();
      expect(p.snapshot().voltage).toEqual(initial.voltage);
      p.flag(p.solver.resistorEnabled, 1, false);
      p.solve();
      expect(p.snapshot().voltage[2]).toBeCloseTo(3.3, 12);
      expect(p.snapshot().voltage[3]).toBe(0);
      p.flag(p.solver.resistorEnabled, 1, true);
      p.solve();
      expect(p.snapshot().voltage).toEqual(initial.voltage);
      p.reset();
      p.solve();
      expect(p.groups().rebuilds).toEqual([0, 0, 1, 0, 1, 0, 0]);
    });

    test('solves a divider and stable oriented currents', () => {
      const p = probe(divider(), engine);
      p.solve();
      const result = p.snapshot();
      expect(result.fault).toBe(0);
      expect(result.voltage).toEqual([3.3, 1.65, 0]);
      expect(result.voltageState).toEqual([0, 0, 0]);
      expect(result.current).toEqual([0.00165, 0.00165]);
      expect(result.sourceCurrent).toEqual([0.00165, -0.00165]);
      expect(result.sourceCurrentState).toEqual([0, 0]);
    });

    test('links JSON properties and paired JS to real resistor branches across devices', () => {
      const definition = {
        properties: { resistance: { type: 'number', default: 1000, exclusiveMin: 0 } },
        pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
        resistors: { body: { pins: ['A', 'B'] } },
      };
      const resistor = (value: number) =>
        prepareElectricalDevice(definition, { resistance: value }, ({ properties, electrical }) => {
          electrical.initializeResistor('body', {
            resistance: properties['resistance'] as number,
            enabled: true,
            maxAbsCurrent: 0.01,
          });
        });
      const linked = allocateElectricalNetwork(
        [
          { id: 'top', prepared: resistor(3000) },
          { id: 'bottom', prepared: resistor(1000) },
        ],
        { VDD: { voltage: 5 } },
        [
          [{ source: 'VDD' }, { device: 'top', pin: 'A' }],
          [
            { device: 'top', pin: 'B' },
            { device: 'bottom', pin: 'A' },
          ],
          [{ device: 'bottom', pin: 'B' }, { source: 'GND' }],
        ],
      );
      const middle = linked.pins.get('top')!.get('B')!.node;
      expect(middle).toBe(linked.pins.get('bottom')!.get('A')!.node);
      expect(middle).not.toBe(linked.pins.get('top')!.get('A')!.node);
      const p = probe(linked.network, engine);
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      expect(p.snapshot().voltage[middle]).toBeCloseTo(1.25, 12);
      expect(linked.currentLimits.get(linked.resistors.get('top')!.get('body')!)).toBe(0.01);
    });

    test('allocates independent drive, analog, bias, and input resources from pin capabilities', () => {
      const prepared = prepareElectricalDevice(
        { pins: { IO: { kind: 'signal' }, UNUSED: { kind: 'signal' } } },
        {},
        ({ electrical }) => {
          electrical.initializePin('IO', {
            drive: {
              reference: { source: 'VDD' },
              highResistance: 50,
              lowResistance: 100,
              analogResistance: 200,
              maxAbsCurrent: 0.02,
            },
            bias: { reference: { source: 'VDD' }, upResistance: 10_000, downResistance: 20_000 },
            input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
          });
        },
      );
      const linked = allocateElectricalNetwork(
        [{ id: 'gpio', prepared }],
        { VDD: { voltage: 3.3 } },
        [],
      );
      const io = linked.pins.get('gpio')!.get('IO')!;
      expect(linked.pins.get('gpio')!.has('UNUSED')).toBe(true);
      expect(io.input).toMatchObject({ reference: linked.sources.get('VDD'), low: 0.3, high: 0.7 });
      const p = probe(linked.network, engine);
      p.solve();
      expect(p.snapshot().voltageState[io.node]).toBe(1);
      p.flag(p.solver.resistorEnabled, io.bias!.up, true);
      p.solve();
      expect(p.snapshot().voltage[io.node]).toBeCloseTo(3.3, 12);
      p.flag(p.solver.resistorEnabled, io.drive!.low, true);
      p.solve();
      expect(p.snapshot().voltage[io.node]).toBeCloseTo(3.3 / 101, 12);
      p.flag(p.solver.resistorEnabled, io.drive!.low, false);
      p.flag(p.solver.resistorEnabled, io.bias!.up, false);
      p.number(p.solver.sourceVoltage, io.drive!.analog!.source, 1.2);
      p.flag(p.solver.resistorEnabled, io.drive!.analog!.resistor, true);
      p.solve();
      expect(p.snapshot().voltage[io.node]).toBeCloseTo(1.2, 12);
      p.number(p.solver.sourceVoltage, linked.sources.get('VDD')!, 5);
      p.flag(p.solver.resistorEnabled, io.drive!.analog!.resistor, false);
      p.flag(p.solver.resistorEnabled, io.drive!.high, true);
      p.solve();
      expect(p.snapshot().voltage[io.node]).toBeCloseTo(5, 12);
    });

    test('links declared symmetric contacts without turning them into permanent wires', () => {
      const prepared = prepareElectricalDevice(
        {
          pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
          connections: { main: { pins: ['A', 'B'], initial: 'open' } },
        },
        {},
        () => {},
      );
      const linked = allocateElectricalNetwork(
        [{ id: 'button', prepared }],
        { VDD: { voltage: 3.3 } },
        [[{ source: 'VDD' }, { device: 'button', pin: 'A' }]],
      );
      const a = linked.pins.get('button')!.get('A')!.node;
      const b = linked.pins.get('button')!.get('B')!.node;
      expect(a).not.toBe(b);
      const p = probe(linked.network, engine);
      p.solve();
      expect(p.snapshot().voltageState[b]).toBe(1);
      p.flag(p.solver.contactClosed, linked.contacts.get('button')!.get('main')!, true);
      p.solve();
      expect(p.snapshot().voltage[b]).toBe(3.3);
      p.flag(p.solver.contactClosed, linked.contacts.get('button')!.get('main')!, false);
      p.solve();
      expect(p.snapshot().voltageState[b]).toBe(1);
    });

    test('reuses factors for RHS changes and refactors for resistance and enable changes', () => {
      const p = probe(divider(), engine);
      p.solve();
      p.solve();
      expect(p.snapshot().factors).toBe(1);
      p.number(p.solver.sourceVoltage, 0, 5);
      p.solve();
      expect(p.snapshot().voltage).toEqual([5, 2.5, 0]);
      expect(p.snapshot().factors).toBe(1);
      p.number(p.solver.resistance, 0, 3000);
      p.solve();
      expect(p.snapshot().voltage[1]).toBeCloseTo(1.25, 12);
      expect(p.snapshot().factors).toBe(2);
      p.flag(p.solver.resistorEnabled, 0, false);
      p.solve();
      expect(p.snapshot().voltage[1]).toBe(0);
      expect(p.snapshot().current[0]).toBe(0);
      expect(p.snapshot().factors).toBe(3);
      p.flag(p.solver.sourceEnabled, 1, false);
      p.solve();
      expect(p.snapshot().voltageState).toEqual([0, 1, 1]);
      expect(p.snapshot().factors).toBe(4);
    });

    test('represents pull-up/down, high impedance, and independent opposing drivers', () => {
      const network: ResistiveNetwork = {
        nodes: 3,
        sources: [
          { node: 0, voltage: 3.3, enabled: true },
          { node: 2, voltage: 0, enabled: true },
        ],
        contacts: [],
        resistors: [
          { a: 0, b: 1, resistance: 10_000, enabled: true },
          { a: 1, b: 2, resistance: 100, enabled: false },
        ],
      };
      const p = probe(network, engine);
      p.solve();
      expect(p.snapshot().voltage[1]).toBeCloseTo(3.3, 12);
      p.flag(p.solver.resistorEnabled, 1, true);
      p.solve();
      expect(p.snapshot().voltage[1]).toBeCloseTo(3.3 / 101, 12);
      p.flag(p.solver.resistorEnabled, 0, false);
      p.solve();
      expect(p.snapshot().voltage[1]).toBe(0);
      p.flag(p.solver.resistorEnabled, 1, false);
      p.solve();
      expect(p.snapshot().voltageState[1]).toBe(1);
    });

    test('solves a multi-node bridge with KCL and no resistance-based node merging', () => {
      const network: ResistiveNetwork = {
        nodes: 5,
        contacts: [],
        sources: [
          { node: 0, voltage: 10, enabled: true },
          { node: 4, voltage: 0, enabled: true },
        ],
        resistors: [
          { a: 0, b: 1, resistance: 1000, enabled: true },
          { a: 1, b: 4, resistance: 2000, enabled: true },
          { a: 0, b: 2, resistance: 2000, enabled: true },
          { a: 2, b: 4, resistance: 1000, enabled: true },
          { a: 1, b: 3, resistance: 500, enabled: true },
          { a: 3, b: 2, resistance: 500, enabled: true },
        ],
      };
      const p = probe(network, engine);
      p.solve();
      const result = p.snapshot();
      expect(result.fault).toBe(0);
      expect(result.voltage[1]).toBeCloseTo(40 / 7, 12);
      expect(result.voltage[2]).toBeCloseTo(30 / 7, 12);
      expect(result.voltage[3]).toBeCloseTo(5, 12);
      for (const node of [1, 2, 3]) {
        let balance = 0;
        network.resistors.forEach((r, i) => {
          if (r.a === node) balance += result.current[i]!;
          if (r.b === node) balance -= result.current[i]!;
        });
        expect(Math.abs(balance)).toBeLessThan(1e-14);
      }
    });

    test('matches every sample between repeated steps and a single unified IR batch', () => {
      const steps = probe(divider(), engine);
      const batch = probe(divider(), engine);
      for (let tick = 0; tick < 37; tick++) steps.runBatch(1);
      batch.runBatch(37);
      expect(batch.trace()).toEqual(steps.trace());
      expect(batch.snapshot()).toEqual(steps.snapshot());
      expect(batch.snapshot().factors).toBe(1);
    });

    test('tracks isolated and floating resistive components without gmin', () => {
      const p = probe(
        {
          nodes: 4,
          contacts: [],
          sources: [{ node: 0, voltage: 3.3, enabled: true }],
          resistors: [{ a: 1, b: 2, resistance: 1000, enabled: true }],
        },
        engine,
      );
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      expect(p.snapshot().voltageState).toEqual([0, 1, 1, 1]);
      expect(p.snapshot().currentState).toEqual([0]);
      expect(p.snapshot().current).toEqual([0]);
    });

    test('merges and splits bidirectional contacts atomically', () => {
      const network = divider();
      const p = probe(
        {
          ...network,
          nodes: 5,
          contacts: [
            { a: 1, b: 3, closed: true },
            { a: 4, b: 3, closed: true },
          ],
        },
        engine,
      );
      p.solve();
      expect(p.snapshot().voltage).toEqual([3.3, 1.65, 0, 1.65, 1.65]);
      p.flag(p.solver.contactClosed, 0, false);
      p.solve();
      expect(p.snapshot().voltageState).toEqual([0, 0, 0, 1, 1]);
      p.flag(p.solver.contactClosed, 1, false);
      p.flag(p.solver.contactClosed, 0, true);
      p.solve();
      expect(p.snapshot().voltageState).toEqual([0, 0, 0, 0, 1]);
      expect(p.snapshot().voltage[3]).toBe(1.65);
    });

    test('propagates contact labels through reversed chains and cycles', () => {
      const p = probe(
        {
          nodes: 6,
          sources: [{ node: 5, voltage: 2, enabled: true }],
          resistors: [],
          contacts: [
            { a: 5, b: 4, closed: true },
            { a: 4, b: 3, closed: true },
            { a: 3, b: 2, closed: true },
            { a: 2, b: 1, closed: true },
            { a: 1, b: 0, closed: true },
            { a: 0, b: 5, closed: true },
          ],
        },
        engine,
      );
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      expect(p.snapshot().voltage).toEqual(Array<number>(6).fill(2));
    });

    test('preserves the previous complete snapshot on source conflict and can recover', () => {
      const p = probe({ ...divider(), contacts: [{ a: 0, b: 2, closed: false }] }, engine);
      p.solve();
      const before = p.snapshot();
      p.flag(p.solver.contactClosed, 0, true);
      p.solve();
      expect(p.snapshot().fault).toBe(RESISTIVE_FAULT.sourceConflict);
      expect(p.snapshot().voltage).toEqual(before.voltage);
      expect(p.snapshot().current).toEqual(before.current);
      p.flag(p.solver.contactClosed, 0, false);
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      expect(p.snapshot().voltage).toEqual(before.voltage);
    });

    test('does not invent unique current for redundant equal ideal sources', () => {
      const p = probe(
        {
          nodes: 2,
          contacts: [],
          sources: [
            { node: 0, voltage: 2, enabled: true },
            { node: 0, voltage: 2, enabled: true },
            { node: 1, voltage: 0, enabled: true },
          ],
          resistors: [{ a: 0, b: 1, resistance: 1000, enabled: true }],
        },
        engine,
      );
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      expect(p.snapshot().sourceCurrentState).toEqual([2, 2, 0]);
      expect(p.snapshot().current).toEqual([0.002]);
    });

    test.each([0, -1, Infinity, NaN])(
      'rejects invalid runtime resistance %s without partial publication',
      (value) => {
        const p = probe(divider(), engine);
        p.solve();
        const before = p.snapshot();
        p.number(p.solver.resistance, 1, value);
        p.number(p.solver.sourceVoltage, 0, 5);
        p.solve();
        expect(p.snapshot().fault).toBe(RESISTIVE_FAULT.invalidParameter);
        expect(p.snapshot().voltage).toEqual(before.voltage);
        p.number(p.solver.resistance, 1, 1000);
        p.solve();
        expect(p.snapshot().voltage).toEqual([5, 2.5, 0]);
      },
    );

    test('reports unrepresentable conductance as a controlled numerical failure', () => {
      const p = probe(divider(), engine);
      p.solve();
      const before = p.snapshot();
      p.number(p.solver.resistance, 0, Number.MIN_VALUE);
      p.solve();
      expect(p.snapshot().fault).toBe(RESISTIVE_FAULT.numericalFailure);
      expect(p.snapshot().voltage).toEqual(before.voltage);
      p.number(p.solver.resistance, 0, 1000);
      p.solve();
      expect(p.snapshot().fault).toBe(0);
    });

    test.each([NaN, Infinity, -Infinity])(
      'rejects nonfinite source voltage %s without publication',
      (value) => {
        const p = probe(divider(), engine);
        p.solve();
        const before = p.snapshot();
        p.number(p.solver.sourceVoltage, 0, value);
        p.solve();
        expect(p.snapshot().fault).toBe(RESISTIVE_FAULT.invalidParameter);
        expect(p.snapshot().voltage).toEqual(before.voltage);
        p.number(p.solver.sourceVoltage, 0, 5);
        p.solve();
        expect(p.snapshot().fault).toBe(0);
        expect(p.snapshot().voltage[1]).toBe(2.5);
      },
    );

    test('explicit invalidation remains correct when version counters wrap around', () => {
      const p = probe(divider(), engine);
      p.solve();
      p.seedVersion(p.solver.rhsVersion, 0xffffffff);
      p.number(p.solver.sourceVoltage, 0, 5);
      p.solve();
      expect(p.snapshot().voltage[1]).toBe(2.5);
      expect(p.snapshot().factors).toBe(1);
      p.seedVersion(p.solver.matrixVersion, 0xffffffff);
      p.number(p.solver.resistance, 0, 3000);
      p.solve();
      expect(p.snapshot().voltage[1]).toBe(1.25);
      expect(p.snapshot().factors).toBe(2);
    });

    test('supports uniformly tiny and huge conductances without a fixed gmin', () => {
      for (const resistance of [1e-200, 1e200]) {
        const network = divider();
        const p = probe(
          { ...network, resistors: network.resistors.map((r) => ({ ...r, resistance })) },
          engine,
        );
        p.solve();
        expect(p.snapshot().fault).toBe(0);
        expect(p.snapshot().voltage[1]).toBeCloseTo(1.65, 12);
      }
    });

    test('scales the RHS before multiplying by large source voltages', () => {
      const p = probe(
        {
          nodes: 2,
          contacts: [],
          sources: [{ node: 0, voltage: 1e200, enabled: true }],
          resistors: [{ a: 0, b: 1, resistance: 1e-200, enabled: true }],
        },
        engine,
      );
      p.solve();
      expect(p.snapshot().fault).toBe(0);
      expect(p.snapshot().voltage).toEqual([1e200, 1e200]);
    });

    test('does not publish partial values when aggregate source current overflows', () => {
      const p = probe(
        {
          nodes: 3,
          contacts: [],
          sources: [
            { node: 0, voltage: 1, enabled: true },
            { node: 1, voltage: 0, enabled: true },
            { node: 2, voltage: 0, enabled: true },
          ],
          resistors: [
            { a: 0, b: 1, resistance: 1e-308, enabled: true },
            { a: 0, b: 2, resistance: 1e-308, enabled: false },
          ],
        },
        engine,
      );
      p.solve();
      const before = p.snapshot();
      expect(before.fault).toBe(0);
      p.flag(p.solver.resistorEnabled, 1, true);
      p.solve();
      expect(p.snapshot().fault).toBe(RESISTIVE_FAULT.numericalFailure);
      expect(p.snapshot().voltage).toEqual(before.voltage);
      expect(p.snapshot().current).toEqual(before.current);
      expect(p.snapshot().sourceCurrent).toEqual(before.sourceCurrent);
    });

    test('repeated failed solves never clear a conflict or reuse the previous snapshot as a solution', () => {
      const p = probe({ ...divider(), contacts: [{ a: 0, b: 2, closed: false }] }, engine);
      p.solve();
      p.flag(p.solver.contactClosed, 0, true);
      p.solve();
      p.solve();
      p.solve();
      expect(p.snapshot().fault).toBe(RESISTIVE_FAULT.sourceConflict);
    });

    test('recreating the runtime restores initial parameters and an empty factor cache', () => {
      const p = probe(divider(), engine);
      p.solve();
      p.number(p.solver.resistance, 0, 3000);
      p.number(p.solver.sourceVoltage, 0, 5);
      p.solve();
      p.reset();
      expect(p.snapshot().factors).toBe(0);
      expect(p.snapshot().fault).toBe(0);
      p.solve();
      expect(p.snapshot().voltage).toEqual([3.3, 1.65, 0]);
      expect(p.snapshot().factors).toBe(1);
    });
  });
}

test('rejects unresolved source references, unknown endpoints, and duplicate device ids at link time', () => {
  const prepared = prepareElectricalDevice(
    { pins: { IO: { kind: 'signal' } } },
    {},
    ({ electrical }) => {
      electrical.initializePin('IO', {
        input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
      });
    },
  );
  const device = { id: 'd', prepared };
  expect(() => allocateElectricalNetwork([device], {}, [])).toThrow('Unknown voltage source');
  expect(() => allocateElectricalNetwork([device, device], { VDD: { voltage: 3.3 } }, [])).toThrow(
    'duplicate device',
  );
  expect(() =>
    allocateElectricalNetwork([device], { VDD: { voltage: 3.3 } }, [
      [{ device: 'd', pin: 'missing' }, { source: 'GND' }],
    ]),
  ).toThrow('Unknown pin');
  expect(() => allocateElectricalNetwork([], { GND: { voltage: 5 } }, [])).toThrow(
    'duplicate voltage source',
  );
});

test('validates node indices and explicit initial parameters before emitting IR', () => {
  expect(() =>
    generateResistiveSolver(createIRModule(), { ...divider(), nodes: 0 }, 'bad'),
  ).toThrow();
  expect(() =>
    generateResistiveSolver(
      createIRModule(),
      { ...divider(), resistors: [{ a: 0, b: 3, resistance: 1, enabled: true }] },
      'bad',
    ),
  ).toThrow();
  expect(() =>
    generateResistiveSolver(
      createIRModule(),
      { ...divider(), sources: [{ node: 0, voltage: NaN, enabled: true }] },
      'bad',
    ),
  ).toThrow();
});
