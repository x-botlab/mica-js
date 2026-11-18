import { createDeviceBuilder, createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { JitInstructionBuilder } from '@mica-js/sdk/model';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { DeviceContext } from '@mica-js/sdk/device';
import { describe, expect, it } from 'vitest';
import { fuseBlock } from '../device/src/fuse.ts';
import {
  DIRTY_GROUP_MEMORY,
  PIN_DIRTY_MEMORY,
  dirtyGroup,
  driveMemoryName,
  pinMemoryName,
} from '../device/shared/dirty-protocol.mjs';
import { MCU_DIRTY_TRIGGERS, MCU_PIN } from '../device/src/nets';

/**
 * fuse barrier 的 runtime 证明：用最小 JIT 执行 fuseBlock 生成的块。
 *
 * cond=true 走提前 redirect，不执行任何 pin intent；SETTLE/提前 redirect 不能 bump。
 * cond=false 在同一块内执行 pin intent 后退出；必须在 redirect/elapse 前提交 fusedSeq。
 * 同一指令写多个脚时只提交一次，并合并引脚、组和可观察项的 dirty 标记。
 */

type Tail = 'redirect' | 'elapse';

interface Scenario {
  readonly pins?: readonly string[];
  readonly cond?: boolean;
  readonly tail?: Tail;
}

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

const DRIVE_RESISTANCE = 25;

function driveOf(pin: string): number {
  const entry = MCU_PIN[pin as keyof typeof MCU_PIN];

  if (entry === undefined) throw new Error(`Unknown MCU pin ${pin}`);
  return entry.drive;
}

function blockFor(pc: number, nextPc: number, build: (b: JitInstructionBuilder) => void) {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc, nextPc }, (b) => build(b));

  return builder.finish();
}

function makeBoard({ pins = ['P3_1'], cond = false, tail = 'redirect' }: Scenario = {}) {
  const drives = pins.map(driveOf);
  const model = createDeviceBuilder({
    name: `FuseBarrier${tail}${cond ? 'NoPin' : 'Pin'}${drives.join('_')}`,
  });

  model.memory({ name: 'code', length: 16 });
  model.memory({ name: PIN_DIRTY_MEMORY, length: 40 });
  model.memory({ name: DIRTY_GROUP_MEMORY, length: 5 });
  // Each pin owns its level and drive resources; the fused block must not depend on a
  // shared 40-byte buffer.
  for (const drive of drives) {
    model.memory({ name: pinMemoryName(drive), length: 1 });
    model.memory({ name: driveMemoryName(drive), length: 1 });
  }
  model.state({ name: 'pc', type: types.number, initial: 0 });
  model.state({ name: 'fusedSeq', type: types.number, initial: 0 });
  model.state({ name: 'cond', type: types.bool, initial: cond });
  // Derive the observable flags from the pins this fixture really drives, not from
  // a hand-written list that can drift from the generator.
  for (const state of new Set(pins.flatMap((pin) => MCU_DIRTY_TRIGGERS[pin] ?? [])))
    model.state({ name: state, type: types.bool, initial: false });

  const exit = (b: JitInstructionBuilder): void => {
    if (tail === 'redirect') b.redirect(b.constant(types.number, 1), b.constant(types.number, 0));
    else {
      b.elapse(b.constant(types.number, 10));
      b.stop();
    }
  };
  const pc0 = fuseBlock(
    blockFor(0, tail === 'redirect' ? 1 : 0, (b) => {
      b.if(
        b.readState('cond', types.bool),
        (yes) => {
          exit(yes);
        },
        (no) => {
          for (const pin of pins)
            no.writeIntent(
              pin,
              no.resistor(no.pin('VCC'), no.constant(types.number, DRIVE_RESISTANCE)),
            );
          exit(no);
        },
      );
    }),
  );
  const pc1 = blockFor(1, 1, (b) => {
    b.elapse(b.constant(types.number, 10));
    b.stop();
  });
  const blocks = new Map(
    tail === 'redirect'
      ? [
          [0, pc0],
          [1, pc1],
        ]
      : [[0, pc0]],
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

function instanceOf(board: ReturnType<typeof makeBoard>): InstanceView {
  return (board as unknown as { readonly instances: readonly InstanceView[] }).instances[0]!;
}

function expectMarks(instance: InstanceView, pins: readonly string[], active: boolean): void {
  const drives = pins.map(driveOf);
  const expected = active ? 1 : 0;

  expect(instance.states.get('fusedSeq')).toBe(expected);
  for (const drive of drives) {
    expect(instance.memories.get(driveMemoryName(drive))![0]).toBe(expected);
    expect(instance.memories.get(PIN_DIRTY_MEMORY)![drive]).toBe(expected);
  }
  for (const group of new Set(drives.map(dirtyGroup)))
    expect(instance.memories.get(DIRTY_GROUP_MEMORY)![group]).toBe(expected);
  // Every observable derived from these pins is raised exactly once per batch; the
  // flag value is idempotent, the IR test proves duplicate stores are merged away.
  for (const state of new Set(pins.flatMap((pin) => MCU_DIRTY_TRIGGERS[pin] ?? [])))
    expect(instance.states.get(state)).toBe(active);
  // An unrelated pin and group stay untouched.
  const unrelated = drives.includes(0) ? 8 : 0;
  expect(instance.memories.get(PIN_DIRTY_MEMORY)![unrelated]).toBe(0);
  expect(instance.memories.get(DIRTY_GROUP_MEMORY)![dirtyGroup(unrelated)]).toBe(0);
}

describe('fuse barrier runtime', () => {
  it('SETTLE-like early redirect with no executed pin intent does not bump fusedSeq', () => {
    const board = makeBoard({ cond: true });

    try {
      board.runUntil(1000);
      expectMarks(instanceOf(board), ['P3_1'], false);
    } finally {
      board.dispose();
    }
  });

  it('executed pin intent commits fusedSeq before the following redirect', () => {
    const board = makeBoard();

    try {
      board.runUntil(1000);
      expectMarks(instanceOf(board), ['P3_1'], true);
    } finally {
      board.dispose();
    }
  });

  it('executed pin intent commits fusedSeq before the instruction elapse', () => {
    const board = makeBoard({ tail: 'elapse' });

    try {
      board.runUntil(1000);
      expectMarks(instanceOf(board), ['P3_1'], true);
    } finally {
      board.dispose();
    }
  });

  it('merges multiple pins written by one instruction into a single batch', () => {
    const pins = ['P3_1', 'P3_2'] as const;
    const board = makeBoard({ pins, tail: 'elapse' });

    try {
      board.runUntil(1000);
      expectMarks(instanceOf(board), pins, true);
    } finally {
      board.dispose();
    }
  });
});
