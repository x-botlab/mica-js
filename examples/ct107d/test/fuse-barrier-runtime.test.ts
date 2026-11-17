import { createDeviceBuilder, createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { JitInstructionBuilder } from '@mica-js/sdk/model';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { DeviceContext } from '@mica-js/sdk/device';
import { describe, expect, it } from 'vitest';
import { fuseBlock } from '../device/src/fuse.ts';

/**
 * fuse barrier 的 runtime 证明：用最小 JIT 执行 fuseBlock 生成的块。
 *
 * cond=true 走提前 redirect，不执行任何 pin intent；SETTLE/提前 redirect 不能 bump。
 * cond=false 在同一块内执行 pin intent 后 redirect；必须在 redirect 前提交 fusedSeq。
 */

function blockFor(pc: number, nextPc: number, build: (b: JitInstructionBuilder) => void) {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc, nextPc }, (b) => build(b));

  return builder.finish();
}

function makeBoard(cond: boolean) {
  const model = createDeviceBuilder({ name: `FuseBarrier${cond ? 'NoPin' : 'Pin'}` });

  model.memory({ name: 'code', length: 16 });
  model.memory({ name: 'fusedMcuDrives', length: 40 });
  model.memory({ name: 'fusedPins', length: 40 });
  model.state({ name: 'pc', type: types.number, initial: 0 });
  model.state({ name: 'fusedSeq', type: types.number, initial: 0 });
  model.state({ name: 'cond', type: types.bool, initial: cond });

  const pc0 = fuseBlock(
    blockFor(0, 1, (b) => {
      b.if(
        b.readState('cond', types.bool),
        (yes) => {
          yes.redirect(yes.constant(types.number, 1), yes.constant(types.number, 0));
        },
        (no) => {
          no.writeIntent('P3_1', no.resistor(no.pin('VCC'), no.constant(types.number, 25)));
          no.redirect(no.constant(types.number, 1), no.constant(types.number, 0));
        },
      );
    }),
  );
  const pc1 = blockFor(1, 1, (b) => {
    b.elapse(b.constant(types.number, 10));
    b.stop();
  });
  const blocks = new Map([
    [0, pc0],
    [1, pc1],
  ]);

  const library = createDeviceLibrary([
    {
      id: 'dut',
      model: model.finish(),
      create: (context: DeviceContext) => {
        const registration = context.attachJit({
          entry: 'dut',
          code: 'code',
          pc: 'pc',
          translate: ({ pc }: { pc: number }) => {
            const block = blocks.get(pc);

            if (block === undefined) throw new Error(`unexpected pc ${pc}`);
            return block;
          },
        });

        context.loadBytes('code', new Uint8Array(16));

        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);
  const board = createBoard(library, {
    instances: [{ id: 'dut', type: 'dut' }],
    nets: [],
  });

  return board;
}

describe('fuse barrier runtime', () => {
  it('SETTLE-like early redirect with no executed pin intent does not bump fusedSeq', () => {
    const board = makeBoard(true);

    try {
      board.runUntil(1000);
      const instance = (
        board as unknown as {
          readonly instances: readonly {
            readonly states: ReadonlyMap<string, number>;
            readonly memories: ReadonlyMap<string, Uint8Array>;
          }[];
        }
      ).instances[0]!;

      expect(instance.states.get('fusedSeq')).toBe(0);
      expect(instance.memories.get('fusedMcuDrives')![25]).toBe(0);
    } finally {
      board.dispose();
    }
  });

  it('executed pin intent commits fusedSeq before the following redirect', () => {
    const board = makeBoard(false);

    try {
      board.runUntil(1000);
      const instance = (
        board as unknown as {
          readonly instances: readonly {
            readonly states: ReadonlyMap<string, number>;
            readonly memories: ReadonlyMap<string, Uint8Array>;
          }[];
        }
      ).instances[0]!;

      expect(instance.states.get('fusedSeq')).toBe(1);
      expect(instance.memories.get('fusedMcuDrives')![25]).toBe(1);
    } finally {
      board.dispose();
    }
  });

  it('executed pin intent commits fusedSeq before the instruction elapse', () => {
    const model = createDeviceBuilder({ name: 'FuseBarrierElapse' });

    model.memory({ name: 'code', length: 16 });
    model.memory({ name: 'fusedMcuDrives', length: 40 });
    model.state({ name: 'pc', type: types.number, initial: 0 });
    model.state({ name: 'fusedSeq', type: types.number, initial: 0 });

    const block = fuseBlock(
      blockFor(0, 1, (b) => {
        b.writeIntent('P3_1', b.resistor(b.pin('VCC'), b.constant(types.number, 25)));
        b.elapse(b.constant(types.number, 10));
        b.stop();
      }),
    );
    const library = createDeviceLibrary([
      {
        id: 'dut',
        model: model.finish(),
        create: (context: DeviceContext) => {
          const registration = context.attachJit({
            entry: 'dut',
            code: 'code',
            pc: 'pc',
            translate: () => block,
          });

          context.loadBytes('code', new Uint8Array(16));

          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(library, {
      instances: [{ id: 'dut', type: 'dut' }],
      nets: [],
    });

    try {
      board.runUntil(1000);
      const instance = (
        board as unknown as {
          readonly instances: readonly {
            readonly states: ReadonlyMap<string, number>;
            readonly memories: ReadonlyMap<string, Uint8Array>;
          }[];
        }
      ).instances[0]!;

      expect(instance.states.get('fusedSeq')).toBe(1);
      expect(instance.memories.get('fusedMcuDrives')![25]).toBe(1);
    } finally {
      board.dispose();
    }
  });
});
