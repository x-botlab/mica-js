import { createDeviceBuilder, types, type PureValueFunctionBody } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import type { JitTranslate } from '../types';

/**
 * #273 的验收：直接程序的写入栅栏在**块入口**判定，观察者集合变化不再让整程序重编译。
 *
 * 板上每个 pc 写一个被观察的状态（`sel`），最后一条块只写无人观察的 `tick`。`sel` 决定
 * 观察源 `watched` 读到哪个 probe，于是每跑一块，被观察的资源集合就在十个组合之间移动。
 * 改动前这会让守卫集合进入发射期判定与缓存键：每次变化都换一份程序，超过 8 槽后旧程序
 * 被挤出，只能整程序重建。
 *
 * 断言是两条独立性质：
 * - 十个组合轮流出现、`observerRevision` 持续推进时，`directCompiles` 不再增长，且
 *   `directPrograms` 只有一份程序；
 * - 同一份程序里，被观察写入的块在入口回退（`directFallbacks` 增长），无人观察的块照常
 *   直接执行（`directCalls - directFallbacks` 增长），观察者仍然按块顺序收到每次更新。
 */

const PROBES = 10;
const BLOCKS = PROBES + 1;

/** 每块推进一个 ps；最后一条块（pc === PROBES）只写无人观察的 `tick`。 */
const translate: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: (pc + 1) % BLOCKS }, (b) => {
    if (pc < PROBES) b.writeState('sel', b.constant(types.number, pc));
    b.writeState('tick', b.add(b.readState('tick', types.number), b.constant(types.number, 1)));
    b.elapse(1);
  });
  return block.finish();
};

function churnModel(probes: number) {
  const builder = createDeviceBuilder({ name: 'BarrierBench' });
  builder.memory({ name: 'code', length: 16 });
  builder.memory({ name: 'scratch', length: 4 });
  builder.memory({ name: 'evidence', length: probes + 1, public: true });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'sel', type: types.number, initial: probes - 1 });
  builder.state({ name: 'tick', type: types.number, initial: 0 });
  builder.state({ name: 'cursor', type: types.number, initial: 0 });
  builder.state({ name: 'fires', type: types.number, initial: 0 });
  for (let probe = 0; probe < probes; probe++)
    builder.state({ name: `probe${probe}`, type: types.number, initial: probe + 1 });
  // 带 memory 参数的纯函数调用把这条观察源留在通用路径上：只有通用路径会逐轮重算
  // 资源集合；生成的链会绑定一个静态槽集合，守卫就不再变化。
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
  builder.derived({ name: 'watched', type: types.number }, (b) => {
    b.callPureValue('tagOf', types.number, b.memory('scratch'), b.constant(types.number, 0));
    // 语句级分支按需读取：未选中的 probe 不会被读，被观察的资源集合才跟着 `sel` 移动。
    const pick = (probe: number, body: PureValueFunctionBody<number>): void => {
      if (probe === probes - 1) {
        body.returnValue(body.readState(`probe${probe}`, types.number));
        return;
      }
      body.if(
        body.equal(
          types.number,
          body.readState('sel', types.number),
          body.constant(types.number, probe),
        ),
        (yes) => yes.returnValue(yes.readState(`probe${probe}`, types.number)),
        (no) => pick(probe + 1, no),
      );
    };
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

describe('direct JIT block-entry write barriers', () => {
  it('observer churn keeps one program and only falls back on the observed blocks', () => {
    let evidence: Uint8Array | undefined;
    const library = createDeviceLibrary([
      {
        id: 'bench',
        model: churnModel(PROBES),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'bench',
            code: 'code',
            pc: 'pc',
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array(16));
            evidence = context.memory.evidence as Uint8Array;
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(library, {
      instances: [{ id: 'bench', type: 'bench' }],
      nets: [],
    });
    try {
      board.runUntil(0);
      expect(board.status).toBe('ready');
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      const jit: Jit = instance.jits[0]!;
      // 每个 PC 只会被翻译一次，预热两圈后 revision 已经稳定。
      board.runUntil(board.time + 2 * BLOCKS);
      const stats = directJitStats(jit);
      expect(stats).toBeDefined();
      const compiles = stats!.directCompiles;
      const calls = stats!.directCalls;
      const fallbacks = stats!.directFallbacks;
      expect(compiles).toBeGreaterThan(0);
      expect(jit.directPrograms.size).toBe(1);

      const guards = (): string => [...jit.directStateGuards].sort().join(',');
      const observerBefore = instance.observerRevision;
      const delivered = instance.states.get('fires') as number;

      // 一块一块地走完一圈，途中采样守卫集合，并确认程序没有被重编译。
      const signatures = new Set<string>([guards()]);
      for (let step = 0; step < BLOCKS; step += 1) {
        board.runUntil(board.time + 1);
        signatures.add(guards());
        expect(stats!.directCompiles).toBe(compiles);
      }
      board.runUntil(board.time + 4 * BLOCKS);

      // 观察者集合确实一直在动：一圈内出现过不止一种守卫集合。
      expect(signatures.size).toBeGreaterThan(1);
      expect(instance.observerRevision).toBeGreaterThan(observerBefore);
      // 而程序没有被重编译：写入栅栏是运行期判定的。
      expect(stats!.directCompiles).toBe(compiles);
      expect(jit.directPrograms.size).toBe(1);
      // 被观察的块在入口回退，无人观察的块仍然走直接程序。
      expect(stats!.directFallbacks).toBeGreaterThan(fallbacks);
      expect(stats!.directCalls - stats!.directFallbacks).toBeGreaterThan(calls - fallbacks);
      // 观察者仍然按块顺序收到每次更新。
      expect(instance.states.get('fires') as number).toBeGreaterThan(delivered);
      expect(evidence).toBeDefined();
      for (let probe = 0; probe < PROBES; probe += 1) expect(evidence![probe]).toBe(probe + 1);
    } finally {
      board.dispose();
    }
  });
});
