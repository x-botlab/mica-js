import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { JitTranslate } from '../types';

/**
 * 直接程序在翻译缓存增长后补入迟到 PC 的调度回归。
 *
 * 首次编译按 8 条已翻译指令触发；如果循环头等重要块在第 9 条之后才翻译，旧策略会把它
 * 永久记入 fallback 集合，整个热循环退回解释器。新策略在同一个纯 PC 第二次 fallback
 * 时最多重编一次；带引脚效果/轮询的块则直接排除，不应因为新 PC 出现而反复重编。
 */

const BLOCKS = 24;
const EFFECT_PC = 20;

const translate: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: (pc + 1) % BLOCKS }, (b) => {
    if (pc === EFFECT_PC) b.writeIntent('out', b.combineIntents());
    else
      b.writeState('tick', b.add(b.readState('tick', types.number), b.constant(types.number, 1)));
    b.elapse(1);
  });
  return block.finish();
};

function latePcModel() {
  const builder = createDeviceBuilder({ name: 'LatePcBench' });

  builder.memory({ name: 'code', length: BLOCKS });
  builder.pin({ name: 'out' });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'tick', type: types.number, initial: 0 });

  return builder.finish();
}

describe('direct JIT late translation cache', () => {
  it('retries a hot pure PC after cache growth but keeps effect PCs excluded', () => {
    const library = createDeviceLibrary([
      {
        id: 'bench',
        model: latePcModel(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'bench',
            code: 'code',
            pc: 'pc',
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array(BLOCKS));
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
      // 跑过两圈：第一圈发现 PC >= 8，第二圈同一纯 PC 再次 fallback 后补编。
      board.runUntil(BLOCKS * 3);
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      const jit = instance.jits[0]!;
      const stats = directJitStats(jit);

      expect(stats).toBeDefined();
      expect(jit.directFallbackPcs.has(EFFECT_PC)).toBe(true);
      expect(jit.direct?.pcs.has(8)).toBe(true);
      expect(stats!.directCalls - stats!.directFallbacks).toBeGreaterThan(0);

      const compiles = stats!.directCompiles;
      board.runUntil(board.time + BLOCKS * 10);
      expect(stats!.directCompiles).toBe(compiles);
    } finally {
      board.dispose();
    }
  });

  it('retries a pure loop head with only 9 cached instructions', () => {
    const blocks = 9;
    const translateLate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: pc === blocks - 1 ? pc : (pc + 1) % blocks }, (b) => {
        b.writeState('tick', b.add(b.readState('tick', types.number), b.constant(types.number, 1)));
        b.elapse(1);
      });
      return block.finish();
    };
    const builder = createDeviceBuilder({ name: 'LateLoopBench' });

    builder.memory({ name: 'code', length: blocks });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    builder.state({ name: 'tick', type: types.number, initial: 0 });
    const library = createDeviceLibrary([
      {
        id: 'bench',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'bench',
            code: 'code',
            pc: 'pc',
            translate: translateLate,
          });
          context.loadBytes('code', new Uint8Array(blocks));
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
      board.runUntil(60);
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      const jit = instance.jits[0]!;
      const stats = directJitStats(jit)!;

      // cache=9 < initial 8 + batch 16；循环头 8 仍必须进入直接程序。
      expect(jit.cache.size).toBe(9);
      expect(jit.direct?.pcs.has(8)).toBe(true);
      expect(stats.directCalls - stats.directFallbacks).toBeGreaterThan(0);
      expect(stats.directCompiles).toBeLessThanOrEqual(3);
    } finally {
      board.dispose();
    }
  });

  it('does not keep probing a pure PC the compiler declined', () => {
    const blocks = 9;
    const translateUnsupported: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: pc === blocks - 1 ? pc : (pc + 1) % blocks }, (b) => {
        if (pc === blocks - 1) b.call('noop');
        b.elapse(1);
      });
      return block.finish();
    };
    const builder = createDeviceBuilder({ name: 'UnsupportedPcBench' });

    builder.memory({ name: 'code', length: blocks });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    builder.fn({ name: 'noop', params: [] }, (b) => b.return());
    const library = createDeviceLibrary([
      {
        id: 'bench',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'bench',
            code: 'code',
            pc: 'pc',
            translate: translateUnsupported,
          });
          context.loadBytes('code', new Uint8Array(blocks));
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
      board.runUntil(200);
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      const jit = instance.jits[0]!;
      const stats = directJitStats(jit)!;
      const compiles = stats.directCompiles;

      expect(jit.direct?.unsupportedPcs.has(8)).toBe(true);
      expect(jit.directFallbackPcs.has(8)).toBe(true);
      board.runUntil(board.time + 1000);
      expect(stats.directCompiles).toBe(compiles);
    } finally {
      board.dispose();
    }
  });
});
