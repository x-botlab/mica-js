import { createDeviceBuilder, types } from '@mica-js/device-model';
import { expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { prepareJitAot, type BoardOptions, type DeviceContext } from '../types';

function createRig({
  pcs,
  rewrite = false,
  execution = 'throughput',
  count = 1,
}: {
  pcs?: readonly number[];
  rewrite?: boolean;
  execution?: BoardOptions['execution'];
  count?: number;
} = {}) {
  const builder = createDeviceBuilder({ name: 'AotRig' });
  builder.memory({ name: 'code', length: 3 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'total', type: types.number, initial: 0 });
  const translated: number[] = [];

  const board = createBoard(
    createDeviceLibrary([
      {
        id: 'rig',
        model: builder.finish(),
        create(context: DeviceContext) {
          const jit = context.attachJit({
            entry: 'cpu',
            code: 'code',
            pc: 'pc',
            directTier: { promoteAfter: 32 },
            translate({ pc, code }, block) {
              translated.push(pc);
              const value = code[pc];
              if (value === undefined) throw new RangeError('Unmapped PC');
              block.instruction({ pc, nextPc: (pc + 1) % 3 }, (body) => {
                body.writeState('total', body.add(body.readState('total', types.number), value));
                body.elapse(1);
              });
              return block.finish();
            },
          });
          context.loadBytes('code', Uint8Array.of(2, 3, 5));
          if (pcs !== undefined) jit[prepareJitAot]?.(pcs);
          if (rewrite) context.loadBytes('code', Uint8Array.of(7));
          return { sync() {}, dispose: () => jit.dispose() };
        },
      },
    ]),
    {
      instances: Array.from({ length: count }, (_, i) => ({ id: `rig${i}`, type: 'rig' })),
      nets: [],
    },
    { execution },
  );
  const instance = (board as unknown as { instances: Instance[] }).instances[0]!;
  return { board, instance, jit: instance.jits[0]!, translated };
}

it('prepares admitted routes without running instructions and lazily translates other PCs', () => {
  const reference = createRig();
  const prepared = createRig({ pcs: [0, 1, 1, 9] });
  try {
    expect(reference.translated).toEqual([]);
    expect(prepared.translated).toEqual([0, 1, 9]);
    expect(prepared.jit.direct?.pcs).toEqual(new Set([0, 1]));
    expect(prepared.board.time).toBe(0);
    expect(prepared.instance.states.get('total')).toBe(0);

    reference.board.runUntil(4);
    prepared.board.runUntil(4);
    expect(prepared.translated).toEqual([0, 1, 9, 2]);
    expect(prepared.instance.states.get('total')).toBe(reference.instance.states.get('total'));
    expect(prepared.instance.states.get('pc')).toBe(reference.instance.states.get('pc'));
  } finally {
    prepared.board.dispose();
    reference.board.dispose();
  }
});

it('rejects stale requests and drops compiled routes after a later code write', () => {
  const stale = createRig({ pcs: [0, 1], rewrite: true });
  const prepared = createRig({ pcs: [0, 1] });
  try {
    expect(stale.translated).toEqual([]);
    expect(prepared.jit.direct?.pcs.has(0)).toBe(true);
    prepared.instance.context.loadBytes('code', Uint8Array.of(7));
    expect(prepared.jit.cache.size).toBe(0);
    expect(prepared.jit.direct).toBeUndefined();

    stale.board.runUntil(1);
    prepared.board.runUntil(1);
    expect(stale.instance.states.get('total')).toBe(7);
    expect(prepared.instance.states.get('total')).toBe(7);
  } finally {
    prepared.board.dispose();
    stale.board.dispose();
  }
});

it.each([
  { execution: 'precise', count: 1 },
  { execution: 'throughput', count: 2 },
] as const)('leaves preparation to the regular path in $execution with $count JITs', (options) => {
  const rig = createRig({ ...options, pcs: [0, 1] });
  try {
    expect(rig.translated).toEqual([]);
    expect(rig.jit.direct).toBeUndefined();
  } finally {
    rig.board.dispose();
  }
});
