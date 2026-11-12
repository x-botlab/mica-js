import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSimulationPrepareStore,
  idlePrepare,
  prepareText,
  reducePrepare,
  runSimulationPrepare,
} from '../src/sim/simulation-prepare.ts';

/**
 * 准备状态机的验收口径：
 *
 * - 一旦进入准备状态，就必然走到 `ready` 或 `failed`，不会停在中途（穷举可达状态验证）；
 * - 每个阶段都是「先把状态画出来，再开始这一阶段的重活」——顺序由事件日志断言；
 * - 阶段文本能区分读库 / 装配 / 首次推进，且不带编造的百分比。
 */

const preparing = new Set(['reading', 'assembling', 'first-advance']);

test('准备状态出现后先画一帧再干活，最后落到就绪', async () => {
  const log = [];
  const store = createSimulationPrepareStore();
  store.subscribe(() => log.push(`phase:${store.get().phase}`));

  await runSimulationPrepare(
    {
      async paint() {
        log.push(`paint:${store.get().phase}`);
      },
      async switchToSimulation() {
        log.push('assemble-work');
      },
      async firstAdvance() {
        log.push('first-advance-work');
      },
    },
    store.dispatch,
  );

  assert.deepEqual(log, [
    'phase:assembling',
    'paint:assembling',
    'assemble-work',
    'phase:first-advance',
    'paint:first-advance',
    'first-advance-work',
    'phase:ready',
  ]);
  assert.equal(store.get().phase, 'ready');
  assert.equal(prepareText(store.get()), undefined);
});

test('任一步失败都会落到失败并继续抛出', async () => {
  for (const failing of ['switchToSimulation', 'firstAdvance']) {
    const store = createSimulationPrepareStore();
    await assert.rejects(
      runSimulationPrepare(
        {
          async paint() {},
          async switchToSimulation() {
            if (failing === 'switchToSimulation') throw new Error('沙箱启动失败');
          },
          async firstAdvance() {
            if (failing === 'firstAdvance') throw new Error('首次编译失败');
          },
        },
        store.dispatch,
      ),
      /沙箱启动失败|首次编译失败/,
    );
    assert.equal(store.get().phase, 'failed');
    assert.match(store.get().failure, /沙箱启动失败|首次编译失败/);
    assert.equal(prepareText(store.get()), undefined);
  }
});

test('读取阶段的计数来自真实解析数量，并能接着走进仿真', () => {
  const store = createSimulationPrepareStore();
  store.dispatch({ type: 'read-start' });
  assert.match(prepareText(store.get()), /正在读取器件库/);
  for (const count of [1, 2, 17]) {
    store.dispatch({ type: 'device-read', count });
    assert.match(prepareText(store.get()), new RegExp(`已解析 ${count} 个器件包`));
  }
  store.endReading();
  assert.equal(store.get().phase, 'idle');
  assert.equal(store.get().devicesRead, 17);

  for (const event of [{ type: 'assemble' }, { type: 'first-advance' }, { type: 'settle' }])
    store.dispatch(event);
  assert.equal(store.get().phase, 'ready');
});

test('非法迁移直接报错，不允许跳过阶段或从中途复原', () => {
  assert.throws(() => reducePrepare(idlePrepare, { type: 'settle' }), /first advance/);
  assert.throws(() => reducePrepare(idlePrepare, { type: 'device-read', count: 1 }), /in idle/);
  assert.throws(() => reducePrepare(idlePrepare, { type: 'fail', failure: 'x' }), /from idle/);
  assert.throws(
    () => reducePrepare({ phase: 'assembling', devicesRead: 0 }, { type: 'assemble' }),
    /from assembling/,
  );
  assert.throws(
    () => reducePrepare({ phase: 'ready', devicesRead: 0 }, { type: 'first-advance' }),
    /before assembling/,
  );
});

test('可达状态里只有就绪与失败是终点，准备状态一定有出路', () => {
  const alphabet = [
    { type: 'read-start' },
    { type: 'device-read', count: 3 },
    { type: 'read-done' },
    { type: 'assemble' },
    { type: 'first-advance' },
    { type: 'settle' },
    { type: 'fail', failure: 'boom' },
    { type: 'reset' },
  ];
  const key = (state) => `${state.phase}:${state.devicesRead}`;
  const edges = new Map();
  const queue = [idlePrepare];
  while (queue.length > 0) {
    const state = queue.shift();
    const outgoing = [];
    for (const event of alphabet) {
      let next;
      try {
        next = reducePrepare(state, event);
      } catch {
        continue;
      }
      outgoing.push(event.type);
      if (!edges.has(key(next))) queue.push(next);
    }
    edges.set(key(state), outgoing);
  }

  // 状态图必须真的展开过：只有 idle 可达说明穷举本身坏了。
  assert.ok(edges.size >= 6, `只枚举到 ${edges.size} 个状态`);

  for (const [stateKey, outgoing] of edges) {
    const phase = stateKey.slice(0, stateKey.indexOf(':'));
    if (outgoing.length === 0) {
      assert.ok(phase === 'ready' || phase === 'failed', `${stateKey} 是终点，但不属于就绪/失败`);
      continue;
    }
    if (preparing.has(phase)) {
      // 每个准备状态都能经 settle 或 fail 离开，界面因此不会停在「正在准备」。
      assert.ok(
        outgoing.includes('settle') || outgoing.includes('fail'),
        `${stateKey} 无法离开准备状态`,
      );
    }
  }
});
