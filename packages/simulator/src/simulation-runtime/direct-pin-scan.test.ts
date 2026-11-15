import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { JitTranslate } from '../types';

/**
 * P2 回归：直接 JIT 的静态引脚效果摘要按翻译后的 IR 身份缓存。
 *
 * 过去 `runDirect()` 的 fallback 分支每次都用 `hasPinIntent(entry.body)` 递归扫描同一份
 * 已翻译 IR。预览负载的稳态循环每圈都会在带引脚意图的块上回退一次，扫描量随回退次数
 * 线性增长。现在摘要只在首次遇到该 RegionIR 时计算：
 * - 稳态回退只查摘要，扫描次数不随 fallback 增长；
 * - 改码清空翻译缓存后重新翻译产生新 IR，摘要必须重新计算而不是复用旧版本结论；
 * - 观察者集合、代码内存屏障等动态守卫仍各自独立判定。
 */

const BLOCKS = 9;
const PIN_PC = 8;
const WRITE_PC = 3;
const WRITE_AT = 40;

function loopModel(name: string, writable: boolean) {
  const builder = createDeviceBuilder({ name });
  builder.memory({ name: 'code', length: BLOCKS });
  builder.pin({ name: 'out' });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'tick', type: types.number, initial: 0 });
  if (writable) builder.state({ name: 'wrote', type: types.number, initial: 0 });
  return builder.finish();
}

function bench(translate: JitTranslate, model: ReturnType<typeof loopModel>) {
  const library = createDeviceLibrary([
    {
      id: 'bench',
      model,
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
  return createBoard(library, { instances: [{ id: 'bench', type: 'bench' }], nets: [] });
}

function onlyJit(board: ReturnType<typeof bench>) {
  const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
  return { instance, jit: instance.jits[0]! };
}

const translatePinLoop: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: (pc + 1) % BLOCKS }, (b) => {
    if (pc === PIN_PC) b.writeIntent('out', b.combineIntents());
    b.writeState('tick', b.add(b.readState('tick', types.number), b.constant(types.number, 1)));
    b.elapse(1);
  });
  return block.finish();
};

describe('direct JIT static effect summaries', () => {
  it('does not rescan translated bodies on steady fallbacks', () => {
    const board = bench(translatePinLoop, loopModel('PinScanBench', false));
    try {
      board.runUntil(0);
      board.runUntil(BLOCKS * 12);
      const { jit } = onlyJit(board);
      const stats = directJitStats(jit)!;

      // 带引脚意图的块始终被排除在直接程序外，并在每次进入时回退。
      expect(jit.direct?.pcs.has(PIN_PC)).toBe(false);
      expect(jit.directFallbackPcs.has(PIN_PC)).toBe(true);
      expect(stats.directPinScans).toBeGreaterThan(0);
      const fallbacks = stats.directFallbacks;
      const scans = stats.directPinScans;
      const compiles = stats.directCompiles;

      board.runUntil(board.time + BLOCKS * 60);

      // 稳态窗口中每圈仍会回退一次，但摘要命中：扫描与重编译都不再增长。
      expect(stats.directFallbacks - fallbacks).toBeGreaterThanOrEqual(60);
      expect(stats.directPinScans).toBe(scans);
      expect(stats.directCompiles).toBe(compiles);
    } finally {
      board.dispose();
    }
  });

  it('recomputes summaries for the new code version after invalidation', () => {
    let pinEnabled = true;
    const translateMutable: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: (pc + 1) % BLOCKS }, (b) => {
        if (pinEnabled && pc === PIN_PC) b.writeIntent('out', b.combineIntents());
        if (pc === WRITE_PC) {
          b.if(
            b.equal(types.number, b.readState('wrote', types.number), b.constant(types.number, 0)),
            (pending) => {
              pending.if(
                pending.greaterThanOrEqual(
                  pending.readState('tick', types.number),
                  pending.constant(types.number, WRITE_AT),
                ),
                (patch) => {
                  // 写入绑定为代码的内存会清空翻译缓存并递增 revision，等价于固件改码。
                  patch.store8('code', 0, patch.constant(types.number, 1));
                  patch.writeState('wrote', patch.constant(types.number, 1));
                },
              );
            },
          );
        }
        b.writeState('tick', b.add(b.readState('tick', types.number), b.constant(types.number, 1)));
        b.elapse(1);
      });
      return block.finish();
    };

    const board = bench(translateMutable, loopModel('PinScanCodeBench', true));
    try {
      board.runUntil(0);
      board.runUntil(30);
      const { instance, jit } = onlyJit(board);
      const stats = directJitStats(jit)!;

      expect(jit.direct?.pcs.has(PIN_PC)).toBe(false);
      expect(jit.directFallbackPcs.has(PIN_PC)).toBe(true);
      const scans = stats.directPinScans;
      const compiles = stats.directCompiles;

      // 改码后的块变纯；越过写入阈值时触发代码内存失效与重新翻译。
      pinEnabled = false;
      board.runUntil(400);
      expect(instance.states.get('wrote')).toBe(1);
      // 新 IR 必须重新扫描摘要，不能沿用旧代码版本的结论。
      expect(stats.directPinScans).toBeGreaterThan(scans);
      expect(stats.directCompiles).toBeGreaterThan(compiles);

      board.runUntil(board.time + BLOCKS * 40);
      const steadyScans = stats.directPinScans;
      const steadyFallbacks = stats.directFallbacks;
      // 新版本中该块已无引脚意图，进入直接程序。
      expect(jit.direct?.pcs.has(PIN_PC)).toBe(true);
      expect(jit.directFallbackPcs.has(PIN_PC)).toBe(false);

      // 代码内存屏障仍让写码块每圈独立回退，摘要依旧不增长。
      board.runUntil(board.time + BLOCKS * 40);
      expect(stats.directFallbacks).toBeGreaterThan(steadyFallbacks);
      expect(stats.directPinScans).toBe(steadyScans);
    } finally {
      board.dispose();
    }
  });
});
