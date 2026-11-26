import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { JitTranslate } from '../types';

function scenario(replace: boolean, repeat = false) {
  const builder = createDeviceBuilder({ name: 'DirectRebuild' });
  builder.memory({ name: 'code', length: 32 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'visit', type: types.bool, initial: false });
  builder.state({ name: 'marker', type: types.number, initial: 0 });
  builder.pin({ name: 'vdd' });
  builder.pin({ name: 'vss' });
  builder.pin({ name: 'signal', low: 0.8, high: 2 });
  builder.start((body) => {
    body.wait(4);
    body.writeState('visit', body.constant(types.bool, true));
  });

  const translate: JitTranslate = ({ pc }, block) => {
    const emit = (entry: number, replacement = false) =>
      block.instruction({ pc: entry, nextPc: entry < 15 ? entry + 1 : 0 }, (body) => {
        if (entry === 0) {
          body.if(body.readState('visit', types.bool), (visit) => {
            visit.writeState('pc', visit.constant(types.number, 16));
          });
          if (replacement) body.writeState('marker', body.constant(types.number, 2));
        } else if (entry === 1) {
          body.writeState('pc', body.constant(types.number, 0));
        } else if (entry === 16) {
          body.writeState('visit', body.constant(types.bool, false));
          body.writeState('marker', body.constant(types.number, 1));
          if (repeat) body.writeState('pc', body.constant(types.number, 16));
        }
        const resistor = body.resistor(
          body.pin(entry === 0 ? 'vdd' : 'vss'),
          body.constant(types.number, 1000),
        );
        body.writeIntent('signal', body.combineIntents(resistor));
        body.elapse(1);
      });
    // Seed the translation at 16 entries so it is subject to the rebuild stride.
    if (pc === 0) for (let entry = 0; entry < 16; entry++) emit(entry);
    else {
      emit(pc);
      if (replace) emit(0, true);
    }
    return block.finish();
  };
  const library = createDeviceLibrary([
    {
      id: 'dut',
      model: builder.finish(),
      create: (context) => {
        const registration = context.attachJit({ entry: 'cpu', code: 'code', pc: 'pc', translate });
        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);
  return createBoard(
    library,
    {
      instances: [{ id: 'dut', type: 'dut' }],
      nets: [
        { id: 'vdd', pins: [{ instance: 'dut', pin: 'vdd' }], voltage: 3.3 },
        { id: 'vss', pins: [{ instance: 'dut', pin: 'vss' }], voltage: 0 },
      ],
    },
    { execution: 'throughput' },
  );
}

describe('direct JIT incremental routing at electrical publication boundaries', () => {
  for (const [replace, description] of [
    [false, 'keeps the session across an append-only revision'],
    [true, 'replaces one route without rebuilding the session'],
  ] as const) {
    it(description, () => {
      const board = scenario(replace);
      try {
        board.runUntil(3);
        const [instance] = (board as unknown as { instances: readonly Instance[] }).instances;
        const jit = instance!.jits[0]!;
        const original = jit.direct!.session;
        const revision = jit.revision;
        const compiles = directJitStats(jit)!.directCompiles;
        const routes = directJitStats(jit)!.directRoutes;
        const samples = instance!.sampleResources.get('signal')!;
        const before = samples.version;

        board.runUntil(20);
        expect(jit.revision).toBe(revision + 1);
        expect(samples.version - before).toBeGreaterThan(10);
        expect(instance!.states.get('marker')).toBe(replace ? 2 : 1);
        expect(directJitStats(jit)!.directCompiles).toBe(compiles);
        expect(jit.direct!.session).toBe(original);
        expect(jit.direct!.session.has(16)).toBe(true);
        expect(directJitStats(jit)!.directRoutes).toBeGreaterThan(routes);
      } finally {
        board.dispose();
      }
    });
  }

  it('adds a route on demand instead of rebuilding the fixed dispatcher', () => {
    const board = scenario(false, true);
    try {
      board.runUntil(3);
      const [instance] = (board as unknown as { instances: readonly Instance[] }).instances;
      const jit = instance!.jits[0]!;
      const compiles = directJitStats(jit)!.directCompiles;
      const session = jit.direct!.session;

      board.runUntil(30);
      expect(jit.direct!.session).toBe(session);
      expect(jit.direct!.session.has(16)).toBe(true);
      expect(directJitStats(jit)!.directCompiles).toBe(compiles);
      expect(directJitStats(jit)!.directRoutes).toBeGreaterThan(16);
    } finally {
      board.dispose();
    }
  });
});
