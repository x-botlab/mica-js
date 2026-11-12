/**
 * 「进入仿真 → 首帧」的准备状态机。
 *
 * 冷启动的大头在第一次推进：器件程序要逐块翻译、直接程序要首次编译，这段工作期间宿主
 * 没有任何可观测输出，用户只会看到界面不动，很容易当成卡死。这里把准备过程拆成
 * 「读库 / 装配 / 首次推进」三个显式阶段，宿主在每段之间真正画一帧，状态文本只描述
 * 当前在做哪一步——没有可用读数的地方不编造百分比。
 *
 * 模块不碰 DOM 也不碰编辑器：异步步骤由调用方注入，`test/simulation-prepare.test.mjs`
 * 用假实现验证「一旦出现准备状态，就必然走到就绪或失败」，以及每个阶段都先画后干。
 */

export type SimulationPreparePhase =
  'idle' | 'reading' | 'assembling' | 'first-advance' | 'ready' | 'failed';

export interface SimulationPrepareState {
  readonly phase: SimulationPreparePhase;
  /** 已解析完成的器件包数量；读取窗口结束后保留最后一次读数。 */
  readonly devicesRead: number;
  /** 失败阶段的诊断文本。 */
  readonly failure?: string;
}

export type SimulationPrepareEvent =
  /** 打开文档时开始读取器件库。 */
  | { readonly type: 'read-start' }
  /** 宿主读到第 `count` 个（去重后的）器件包。 */
  | { readonly type: 'device-read'; readonly count: number }
  /** 读取窗口结束，回到空闲。 */
  | { readonly type: 'read-done' }
  /** 切到仿真模式：导入器件模块、校验 IR、建立板级资源。 */
  | { readonly type: 'assemble' }
  /** 装配完成，开始首次推进（翻译与首次编译）。 */
  | { readonly type: 'first-advance' }
  /** 首次推进返回，仿真已经能按帧推进。 */
  | { readonly type: 'settle' }
  | { readonly type: 'fail'; readonly failure: string }
  | { readonly type: 'reset' };

export const idlePrepare: SimulationPrepareState = Object.freeze({
  phase: 'idle',
  devicesRead: 0,
});

const readingPhases: ReadonlySet<SimulationPreparePhase> = new Set([
  'reading',
  'assembling',
  'first-advance',
]);

/**
 * 唯一的状态迁移入口。
 *
 * 非法迁移直接抛错而不是悄悄忽略：准备状态一旦出现，就只能经 `settle` 或 `fail` 离开，
 * 这条约束由测试守住，界面因此不会停在「正在准备」上。
 */
export function reducePrepare(
  state: SimulationPrepareState,
  event: SimulationPrepareEvent,
): SimulationPrepareState {
  switch (event.type) {
    case 'reset':
      return idlePrepare;
    case 'fail':
      if (!readingPhases.has(state.phase))
        throw new Error(`Cannot fail simulation preparation from ${state.phase}`);
      return { phase: 'failed', devicesRead: state.devicesRead, failure: event.failure };
    case 'read-start':
      if (state.phase !== 'idle')
        throw new Error(`Cannot start reading devices from ${state.phase}`);
      return { phase: 'reading', devicesRead: 0 };
    case 'device-read':
      if (state.phase !== 'reading') throw new Error(`Cannot count devices in ${state.phase}`);
      return { phase: 'reading', devicesRead: event.count };
    case 'read-done':
      if (state.phase !== 'reading')
        throw new Error(`Cannot finish reading devices from ${state.phase}`);
      return { ...idlePrepare, devicesRead: state.devicesRead };
    case 'assemble':
      if (state.phase !== 'idle' && state.phase !== 'reading')
        throw new Error(`Cannot assemble simulation from ${state.phase}`);
      return { phase: 'assembling', devicesRead: state.devicesRead };
    case 'first-advance':
      if (state.phase !== 'assembling')
        throw new Error(`Cannot advance before assembling (from ${state.phase})`);
      return { phase: 'first-advance', devicesRead: state.devicesRead };
    case 'settle':
      if (state.phase !== 'first-advance')
        throw new Error(`Cannot settle before the first advance (from ${state.phase})`);
      return { phase: 'ready', devicesRead: state.devicesRead };
  }
}

/** 状态文本；返回 `undefined` 表示不需要向用户展示准备过程。 */
export function prepareText(state: SimulationPrepareState): string | undefined {
  switch (state.phase) {
    case 'reading':
      return state.devicesRead === 0
        ? '正在读取器件库…'
        : `正在读取器件库（已解析 ${state.devicesRead} 个器件包）`;
    case 'assembling':
      return '正在装配仿真电路（导入器件模块、校验 IR、建立板级资源）';
    case 'first-advance':
      return '正在首次推进：翻译器件程序并完成首次编译';
    default:
      return undefined;
  }
}

export interface SimulationPrepareStore {
  readonly get: () => SimulationPrepareState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (event: SimulationPrepareEvent) => void;
  /** 读取窗口收尾；不在读取阶段时什么也不做，好让宿主在任意分支里调用。 */
  readonly endReading: () => void;
}

export function createSimulationPrepareStore(): SimulationPrepareStore {
  let state = idlePrepare;
  const listeners = new Set<() => void>();
  const get = () => state;
  return {
    get,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(event) {
      const next = reducePrepare(state, event);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    endReading() {
      if (state.phase === 'reading') state = { ...idlePrepare, devicesRead: state.devicesRead };
      for (const listener of listeners) listener();
    },
  };
}

export interface SimulationPrepareSteps {
  /** 切到仿真模式（装配 + 建立板级资源）。 */
  readonly switchToSimulation: () => Promise<void>;
  /**
   * 主动跑一个极短时间片，把首次翻译与首次编译从帧循环里挪到可见的准备阶段。
   *
   * 时间片长度由宿主的步长配置决定（Playground 是 2–20 ms），这里只负责「先跑一次」。
   */
  readonly firstAdvance: () => Promise<void>;
  /** 等宿主把当前状态真正画到屏幕上；回报后才会开始下一段重活。 */
  readonly paint: () => Promise<void>;
}

/**
 * 按「装配 → 首次推进 → 就绪」推进准备过程。
 *
 * 每个阶段都先 `paint()` 再干活，所以用户看到的状态文本永远对应正在发生的那一步。
 * 任何一步失败都会落到 `failed` 并继续抛出，让宿主按既有错误通道呈现原因。
 */
export async function runSimulationPrepare(
  steps: SimulationPrepareSteps,
  transition: (event: SimulationPrepareEvent) => void,
): Promise<void> {
  transition({ type: 'assemble' });
  try {
    await steps.paint();
    await steps.switchToSimulation();
    transition({ type: 'first-advance' });
    await steps.paint();
    await steps.firstAdvance();
    transition({ type: 'settle' });
  } catch (error) {
    transition({
      type: 'fail',
      failure: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
