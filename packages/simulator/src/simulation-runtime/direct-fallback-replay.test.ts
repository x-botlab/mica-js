import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import type { JitTranslate } from '../types';

/**
 * A direct program can execute a zero-duration block that writes a marker/PC and then
 * dispatch a not-yet-compiled next PC. The fallback path must not tell runJit to use the
 * old cached PC: the dirty marker/PC has already been flushed and the executed prefix must
 * not be replayed. This is independent of the compiler's dynamic-duration liveness bug.
 */
function model() {
  const builder = createDeviceBuilder({ name: 'DirectFallbackReplay' });
  builder.memory({ name: 'code', length: 4 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'phase', type: types.bool, initial: false });
  builder.state({ name: 'marker', type: types.number, initial: 0 });
  builder.start((body) => {
    body.wait(body.constant(types.number, 1));
    body.writeState('phase', body.constant(types.bool, true));
  });
  return builder.finish();
}

const translate: JitTranslate = (input, block) => {
  if (input.pc === 0) {
    block.instruction({ pc: 0, nextPc: 0 }, (body) => {
      const phase = body.readState('phase', types.bool);
      body.writeState(
        'marker',
        body.add(body.readState('marker', types.number), body.constant(types.number, 1)),
      );
      body.writeState(
        'pc',
        body.select(
          types.number,
          phase,
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      body.elapse(
        body.select(
          types.number,
          phase,
          (yes) => yes.constant(types.number, 0),
          (no) => no.constant(types.number, 1),
        ),
      );
    });
  } else {
    block.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => body.stop());
  }
  return block.finish();
};

describe('direct fallback with an executed zero-duration prefix', () => {
  it('does not replay the executed prefix when the next PC is uncompiled', () => {
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: model(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            pc: 'pc',
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array([1, 1, 1, 1]));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(
      library,
      { instances: [{ id: 'probe', type: 'probe' }], nets: [] },
      { execution: 'throughput' },
    );
    try {
      board.runUntil(1);
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      const jit = instance.jits[0] as Jit;
      // The first interpreter pass cached PC 0 and advanced one ps. The start process
      // switches phase at t=1; direct then writes PC 1 without advancing time.
      board.runUntil(2);
      expect(instance.states.get('marker')).toBe(2);
      expect(instance.states.get('pc')).toBe(2);
      expect(directJitStats(jit)?.directFallbacks).toBeGreaterThan(0);
    } finally {
      board.dispose();
    }
  });
});
