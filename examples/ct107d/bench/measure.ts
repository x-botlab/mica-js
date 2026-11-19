import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createCt107dBoard, demoFirmware } from './board';
import type { BoardFingerprints } from './board';

/**
 * CT107D 整板基准的测量核心：与 `stm32g431rbt6/bench/measure.mjs` 同构，但读数用
 * **进程 CPU 时间**（`process.cpuUsage`）而不是挂钟，避免并行 agent 抢 CPU 时抖动。
 *
 * 口径固定为「稳态窗口」：装配 → `runUntil(0)` → 预热 → 测量窗口。仿真时间以皮秒计，
 * `simMs` 只写毫秒读数。
 *
 * 两组指标的取样范围不同：
 * - 计数与计时（`boundaryCalls`、`publishCalls`、`solves`、`directCalls` …）只累加测量窗口内的事件；
 * - `compileDirectJit` / `directPrograms` 是整轮累加：直接程序编译是一次性事件，
 *   预热期间就会完成，只统计窗口内会恒为 0。
 *
 * `topicDigest` 把窗口内每条话题消息按 `(simTime, topic, payload)` 规范成一行再取 SHA-256，
 * 用作「行为不变」的统一对照值；同一次测量内多轮取值必须完全一致。
 */

const MS_PS = 1_000_000_000;

export const WARM_UP_MS = 20;
export const MEASURE_MS = 500;
export const ROUNDS = 3;
/** 兼容旧字段：默认固件名；实际固件可用 `firmwareName` 覆盖。 */
export const FIRMWARE = 'ct107d-demo';

interface ElectricalStats {
  readonly solves: number;
  readonly components: number;
  readonly floatingComponents: number;
  readonly factorizations: number;
  readonly factorizationReuses: number;
  readonly cacheHits: number;
  readonly leafPlans: number;
  readonly leafPropagations: number;
  readonly topologyPrepares: number;
}

interface ElectricalNetwork {
  solveSlots(changedSlots?: number | Iterable<number>): readonly number[];
  readonly stats: ElectricalStats;
}

/** Deterministic counters the runtime keeps on each JIT; no runtime patching required. */
interface DirectStats {
  readonly directCompiles: number;
  readonly directCalls: number;
  readonly directFallbacks: number;
}

/**
 * 发射器挂在每个直接程序上的统计（#256）。在这里汇总而不是自己重算，是为了让验收指标
 * ——「每条 IR op 花几条宿主语句」——测的是真实固件，而不是手写的复刻。
 */
interface EmitStats {
  readonly blocks: number;
  readonly operations: number;
  readonly nestedOperations: number;
  readonly statements: number;
  readonly statementsPerOperation: number;
  readonly foldedOperations: number;
  readonly selectBlocks: number;
  readonly worst: {
    readonly pc: number;
    readonly operations: number;
    readonly statements: number;
    readonly statementsPerOperation: number;
    readonly foldedOperations: number;
    readonly selectBlocks: number;
  } | null;
}

interface JitLike {
  readonly directPrograms: ReadonlyMap<string, unknown>;
  readonly directStats?: DirectStats;
  readonly cache: ReadonlyMap<number, { readonly polling: boolean }>;
  readonly directFallbackPcs: ReadonlySet<number>;
  readonly directFallbacksExhausted: boolean;
}

/** 运行时内部结构：`Board` 只公开 `runUntil`，其余字段按现有实现读取。 */
interface RuntimeLike {
  time: number;
  /**
   * 当前正在同步/执行/发布话题的器件实例。话题桥本身只带端口名，
   * 用它把每条消息归属到 `Instance.id`，再由 `designators` 换成板面位号。
   */
  readonly current: { readonly id: string } | undefined;
  readonly dirtyElectricalCount: number | undefined;
  readonly network: ElectricalNetwork | undefined;
  readonly jits: readonly JitLike[] | undefined;
  boundary(): void;
  publish(): void;
}

export interface WindowCounters {
  boundaryCalls: number;
  publishCalls: number;
  electricalPublishes: number;
  topicMessages: number;
  dirtySlots: number;
  solveCalls: number;
  solveUs: number;
  directCalls: number;
  directFallbacks: number;
}

interface ProbeSnapshot {
  readonly counters: WindowCounters;
  readonly compileDirectJit: number;
  readonly directPrograms: number;
  readonly cachedInstructions: number;
  readonly pollingInstructions: number;
  readonly directFallbackPcs: number;
  readonly directFallbacksExhausted: boolean;
  readonly emit: EmitStats & { readonly statementsPerNestedOperation: number };
  readonly direct: boolean;
  readonly digest: string;
  readonly finalDigest: string;
  readonly finalDigestLegacy: string;
  /** 每个「实例 ID/端口」的最新值，包含预热期；窗口结束时的完全可观测状态。 */
  readonly finalTopics: Readonly<Record<string, string>>;
  /** 旧口径：窗口内按裸端口名的最后值（后写覆盖前写）；仅为兼容保留。 */
  readonly finalPorts: Readonly<Record<string, string>>;
  /** 实例 ID → 板面位号；仅辅助人读，不参与话题唯一键。 */
  readonly instanceDesignators: Readonly<Record<string, string>>;
}

interface Probe {
  begin(): void;
  end(): void;
  /** 当前完整可观测状态（含预热期），键为「实例 ID/端口」。 */
  checkpoint(): Readonly<Record<string, string>>;
  read(): ProbeSnapshot;
  dispose(): void;
}

const cpuMs = (usage: NodeJS.CpuUsage): number => (usage.user + usage.system) / 1000;

const elapsed = (before: NodeJS.CpuUsage): number => cpuMs(process.cpuUsage(before));

/** 稳定顺序：检查点快照可逐字比较，不依赖话题首次出现的顺序。 */
function sortedTopics(topics: ReadonlyMap<string, string>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...topics.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function digestTopics(topics: ReadonlyMap<string, string>): string {
  return `sha256:${createHash('sha256')
    .update(
      [...topics.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([topic, text]) => `${topic}|${text}\n`)
        .join(''),
    )
    .digest('hex')
    .slice(0, 16)}`;
}

/** 话题负载的规范化：数值用最短表示、字节用十六进制、记录按键名排序。 */
function canonical(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? `${value}` : `nonfinite:${value}`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Uint8Array) return `u8:${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    return `{${entries
      .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`)
      .join(',')}}`;
  }

  return typeof value;
}

interface TopicBridge {
  onDidReceive(listener: (message: { topic: string; payload: unknown }) => unknown): {
    dispose(): void;
  };
}

function createProbe(board: unknown, designators: ReadonlyMap<string, string>): Probe {
  const runtime = board as RuntimeLike;
  const hasher = createHash('sha256');
  const counters: WindowCounters = {
    boundaryCalls: 0,
    publishCalls: 0,
    electricalPublishes: 0,
    topicMessages: 0,
    dirtySlots: 0,
    solveCalls: 0,
    solveUs: 0,
    directCalls: 0,
    directFallbacks: 0,
  };
  const restores: (() => void)[] = [];
  let active = false;
  /** Counter totals sampled when the window opens; `directCalls` stays window-scoped. */
  let directBaseline = 0;
  let fallbackBaseline = 0;

  /** Every JIT that ran the direct backend; the counters appear with its first direct run. */
  const directJits = (): JitLike[] =>
    (runtime.jits ?? []).filter((jit) => jit.directStats !== undefined);

  const totalDirect = (field: 'directCalls' | 'directFallbacks'): number =>
    directJits().reduce((sum, jit) => sum + (jit.directStats?.[field] ?? 0), 0);

  /**
   * 板级话题桥只传端口名；`runtime.current` 在同步/执行/发布期间指向发布者。
   * 唯一键用「实例 ID / 端口」，避免 U7/U8 都发 `latch`、DS1/DS2 都发 `digit1`
   * 时互相覆盖。位号只做辅助映射，可能重复，不能当唯一键。
   */
  const topicKey = (topic: string): string => {
    const current = runtime.current;

    if (current === undefined) return `@host/${topic}`;

    return `${current.id}/${topic}`;
  };

  /** 实例 ID → 位号；仅用于结果展示和测试定位，不参与话题键。 */
  const instanceDesignators = sortedTopics(designators);
  /** 全量最新值（含预热期），供窗口检查点读取完整可观测状态。 */
  const latest = new Map<string, string>();
  /** 窗口内按「实例 ID/端口」的最后值。 */
  const windowFinals = new Map<string, string>();
  /** 旧口径：窗口内按裸端口名的最后值（后写覆盖前写）。 */
  const legacyFinals = new Map<string, string>();
  const stream: string[] = [];
  const subscription = (board as { topics: TopicBridge }).topics.onDidReceive((message) => {
    const text = canonical(message.payload);
    const key = topicKey(message.topic);

    latest.set(key, text);
    if (!active) return;
    counters.topicMessages++;
    hasher.update(`${runtime.time}|${message.topic}|${text}\n`);
    windowFinals.set(key, text);
    legacyFinals.set(message.topic, text);
    if (process.env['MICA_PERF_STREAM']) stream.push(`${runtime.time}|${message.topic}|${text}`);
  });

  // `boundary()` / `publish()` 是原型方法，实例自有属性会遮蔽它们，内部 `this.boundary()` 同样命中。
  const boundary = runtime.boundary;
  runtime.boundary = function boundaryCounted(this: unknown) {
    if (active) counters.boundaryCalls++;

    return boundary.call(runtime);
  };
  restores.push(() => {
    delete (runtime as Partial<RuntimeLike>).boundary;
  });

  const publish = runtime.publish;
  runtime.publish = function publishCounted(this: unknown) {
    // `publish()` 只在有脏槽时推进求解；这里同时记录调用数、真正求解的次数与脏槽峰值。
    if (active) {
      const dirty = runtime.dirtyElectricalCount ?? 0;

      counters.publishCalls++;
      if (dirty > 0) counters.electricalPublishes++;
      counters.dirtySlots = Math.max(counters.dirtySlots, dirty);
    }

    return publish.call(runtime);
  };
  restores.push(() => {
    delete (runtime as Partial<RuntimeLike>).publish;
  });

  const network = runtime.network;

  if (network !== undefined && typeof network.solveSlots === 'function') {
    const original = network.solveSlots.bind(network);
    const counted = (slots?: number | Iterable<number>): readonly number[] => {
      if (!active) return original(slots);

      // `process.cpuUsage` 的粒度是 1 µs，单次求解只有几十微秒，改用单调时钟累计。
      const before = process.hrtime.bigint();
      const changed = original(slots);
      counters.solveCalls++;
      counters.solveUs += Number(process.hrtime.bigint() - before) / 1000;

      return changed;
    };

    try {
      (network as { solveSlots: typeof counted }).solveSlots = counted;
      restores.push(() => {
        (network as { solveSlots: typeof counted }).solveSlots = original;
      });
    } catch {
      // 网络对象不可写时退回「整窗 CPU / solves」，不阻断基准。
    }
  }

  return {
    begin() {
      active = true;
      directBaseline = totalDirect('directCalls');
      fallbackBaseline = totalDirect('directFallbacks');
    },
    end() {
      active = false;
    },
    checkpoint() {
      return sortedTopics(latest);
    },
    read() {
      let directPrograms = 0;
      let cachedInstructions = 0;
      let pollingInstructions = 0;
      let directFallbackPcs = 0;
      let directFallbacksExhausted = false;
      const emit = {
        blocks: 0,
        operations: 0,
        nestedOperations: 0,
        statements: 0,
        foldedOperations: 0,
        selectBlocks: 0,
      };
      let worst: EmitStats['worst'] = null;

      for (const jit of runtime.jits ?? []) {
        directPrograms += jit.directPrograms.size;
        cachedInstructions += jit.cache.size;
        pollingInstructions += [...jit.cache.values()].filter((entry) => entry.polling).length;
        directFallbackPcs += jit.directFallbackPcs.size;
        directFallbacksExhausted ||= jit.directFallbacksExhausted;
        for (const execution of jit.directPrograms.values()) {
          const stats = (execution as { program?: { emitStats?: EmitStats } } | undefined)?.program
            ?.emitStats;
          if (stats === undefined) continue;
          emit.blocks += stats.blocks;
          emit.operations += stats.operations;
          emit.nestedOperations += stats.nestedOperations;
          emit.statements += stats.statements;
          emit.foldedOperations += stats.foldedOperations;
          emit.selectBlocks += stats.selectBlocks;
          if (
            stats.worst !== null &&
            (worst === null || stats.worst.statementsPerOperation > worst.statementsPerOperation)
          )
            worst = stats.worst;
        }
      }

      // `compileDirectJit` 整轮累加（编译只在装配与预热期发生），调用与回退取窗口增量。
      counters.directCalls = totalDirect('directCalls') - directBaseline;
      counters.directFallbacks = totalDirect('directFallbacks') - fallbackBaseline;

      return {
        counters: { ...counters },
        compileDirectJit: directJits().reduce(
          (sum, jit) => sum + (jit.directStats?.directCompiles ?? 0),
          0,
        ),
        directPrograms,
        cachedInstructions,
        pollingInstructions,
        directFallbackPcs,
        directFallbacksExhausted,
        emit: {
          ...emit,
          worst,
          statementsPerOperation:
            emit.operations === 0 ? 0 : Number((emit.statements / emit.operations).toFixed(3)),
          statementsPerNestedOperation:
            emit.nestedOperations === 0
              ? 0
              : Number((emit.statements / emit.nestedOperations).toFixed(3)),
        },
        direct: directJits().length > 0 && counters.directCalls > 0,
        digest: `sha256:${hasher.digest('hex').slice(0, 16)}`,
        finalDigest: digestTopics(windowFinals),
        finalDigestLegacy: digestTopics(legacyFinals),
        finalTopics: sortedTopics(latest),
        finalPorts: sortedTopics(legacyFinals),
        instanceDesignators,
      };
    },
    dispose() {
      subscription.dispose();

      // Diagnostic only: `MICA_PERF_STREAM=<path>` dumps the raw (simTime, topic, payload) stream.
      const streamPath = process.env['MICA_PERF_STREAM'];
      if (streamPath && stream.length) writeFileSync(streamPath, `${stream.join('\n')}\n`);

      for (const restore of restores.reverse()) restore();
    },
  };
}

export interface MeasureOptions {
  /** 固件镜像；默认 `assets/ct107d-demo.bin`（8051 演示固件）。 */
  readonly firmware?: Uint8Array;
  /** 固件名（写进结果与产物指纹）；默认 `ct107d-demo`。 */
  readonly firmwareName?: string;
  /** 覆盖 MCU 属性，例如 `clockFrequency`。 */
  readonly props?: Readonly<Record<string, unknown>>;
  /** 执行后端；`precise` 走解释器，用于与直接后端做差分对照。 */
  readonly execution?: 'throughput' | 'precise';
  readonly warmUpMs?: number;
  readonly measureMs?: number;
  /** Optional simulation time advanced by each runUntil call, as in the canvas frame loop. */
  readonly tickMs?: number;
  readonly rounds?: number;
  /**
   * 测量窗口内的共同仿真时间检查点（绝对毫秒，从板启动算起）。
   * 除窗口终点外，检查点必须落在 `warmUpMs + k * tickMs` 的推进网格上；
   * 否则为了命中检查点会额外切分一次 `runUntil`，改变批处理口径。
   */
  readonly checkpointMs?: readonly number[];
}

/** 共同仿真时间检查点上的完整可观测状态，键为「实例 ID/端口」。 */
export interface TopicCheckpoint {
  readonly simMs: number;
  readonly topics: Readonly<Record<string, string>>;
}

export interface MeasureResult {
  readonly board: 'ct107d';
  /** 固件名；兼容字段，等价于 `firmwareName`。 */
  readonly firmware: string;
  readonly firmwareName: string;
  readonly firmwareBytes: number;
  /** 固件镜像的完整 SHA-256（十六进制），用于复现实验产物。 */
  readonly firmwareSha256: string;
  /** 原理图、固件与器件产物的哈希清单；`source` 标明基准读取的是 `src`。 */
  readonly fingerprints: BoardFingerprints;
  /** 实例 ID → 位号；仅辅助人读，话题唯一键仍为「实例 ID/端口」。 */
  readonly instanceDesignators: Readonly<Record<string, string>>;
  /** 实际使用的执行后端。 */
  readonly execution: 'throughput' | 'precise';
  readonly clockFrequency: number;
  readonly devices: number;
  readonly nets: number;
  /** 测量窗口的仿真时长（毫秒）。 */
  readonly simMs: number;
  readonly warmUpMs: number;
  readonly tickMs: number;
  readonly rounds: number;
  /** 测量窗口在板时间轴上的起止（绝对毫秒）。 */
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** 稳态窗口的进程 CPU 时间（`user + system`，毫秒）。 */
  readonly cpuMs: number;
  /** 稳态窗口的真实墙钟时间（毫秒）。 */
  readonly elapsedWallMs: number;
  /** `simMs / elapsedWallMs`：真实墙钟口径下每墙钟秒推进的仿真秒数。 */
  readonly realtimeRatio: number;
  /** 冷启动阶段（装配 + `runUntil(0)` + 预热）的进程 CPU 时间（毫秒）。 */
  readonly coldCpuMs: number;
  /** 冷启动阶段的真实墙钟时间（毫秒）。 */
  readonly coldElapsedWallMs: number;
  /** `warmUpMs / coldElapsedWallMs`；预热为 0 时记为 0。 */
  readonly coldRealtimeRatio: number;
  /**
   * @deprecated 历史 CPU 指标：等价于 `cpuMs`（进程 CPU 时间），不是墙钟。
   * 新代码请读 `cpuMs` / `elapsedWallMs` / `realtimeRatio`。
   */
  readonly wallMs: number;
  /**
   * @deprecated 历史 CPU 指标：`cpuMs / simMs`（CPU 时间 / 仿真时间），不是 `simMs / wall`。
   * 实时比请读 `realtimeRatio`。
   */
  readonly rtf: number;
  /** @deprecated 历史 CPU 指标：等价于 `coldCpuMs`。 */
  readonly coldMs: number;
  readonly usPerSolve: number;
  readonly solves: number;
  /** Whole-graph topology rebuilds; a transition-bucket hit restores instead. */
  readonly prepareTopology: number;
  readonly components: number;
  readonly factorizations: number;
  readonly leafPlans: number;
  readonly boundaryCalls: number;
  readonly publishCalls: number;
  readonly electricalPublishes: number;
  readonly topicMessages: number;
  readonly dirtySlots: number;
  readonly direct: boolean;
  readonly directPrograms: number;
  readonly compileDirectJit: number;
  readonly cachedInstructions: number;
  readonly pollingInstructions: number;
  readonly directFallbackPcs: number;
  readonly directFallbacksExhausted: boolean;
  readonly directCalls: number;
  readonly fallbackRate: number;
  /**
   * 语句/IR op 比（#256 验收口径）：分子是发射器为指令体写出的宿主语句数（写栅栏、
   * 忙等折叠、前缀与后缀，按字符串字面量之外的 `;` 计数）；分母只算指令体的顶层 IR op，
   * 与 #256 引用的「258 个 IR op → 381 条语句」同口径。
   */
  readonly statementsPerOperation: number;
  /**
   * 同一分子除以**全部** IR op（含 `select`/`if`/`match` 分支里的嵌套 op）。语句数两者相同，
   * 嵌套 op 不会出现在 `body.operations` 里，所以这个比值才是「每条被发射的 IR op 花几条语句」。
   */
  readonly statementsPerNestedOperation: number;
  readonly emittedStatements: number;
  readonly emittedOperations: number;
  readonly emittedNestedOperations: number;
  readonly emittedBlocks: number;
  readonly foldedOperations: number;
  readonly selectBlocks: number;
  /** 语句/op 比最高的那一块，用来定位仍在小号语句的地方。 */
  readonly worstBlock: EmitStats['worst'];
  readonly topicDigest: string;
  readonly topicDigestStable: boolean;
  /** 各轮检查点快照是否完全一致。 */
  readonly checkpointsStable: boolean;
  /** 最佳轮在共同仿真时间检查点上的完整状态。 */
  readonly checkpoints: readonly TopicCheckpoint[];
  /**
   * 旧口径：窗口内按裸端口名取最后载荷后计算的摘要（后写覆盖前写）。
   * 新代码请读 `topicFinalDigestByDevice`（实例 ID + 端口）。
   */
  readonly topicFinalDigest: string;
  /** 窗口内按「实例 ID/端口」最后载荷计算的摘要。 */
  readonly topicFinalDigestByDevice: string;
  /**
   * 窗口结束时的完整状态，键为「实例 ID/端口」（含预热期最后已知值）。
   * 同名端口（U7/U8 的 `latch`、DS1/DS2 的 `digit1`…）不会再互相覆盖。
   * 位号只作辅助映射，见 `instanceDesignators`，可能重复。
   */
  readonly topicFinalTopics: Readonly<Record<string, string>>;
  /**
   * @deprecated 旧口径：窗口内按裸端口名的最后值（后写覆盖前写）。
   * 仅为兼容历史调用保留；需要区分同名器件请读 `topicFinalTopics`。
   */
  readonly topicFinalPorts: Readonly<Record<string, string>>;
  readonly unavailable: Readonly<Record<string, string>>;
  readonly faults: readonly string[];
}

/**
 * `MICA_CT107D_EXECUTION=precise` 让同一窗口走解释器，作为直接后端任何改动的差分对照。
 * 其他取值一律忽略，保持默认后端。
 */
function environmentExecution(): 'throughput' | 'precise' | undefined {
  const value = process.env['MICA_CT107D_EXECUTION'];

  return value === 'precise' || value === 'throughput' ? value : undefined;
}

interface RoundSample {
  /** 稳态窗口的进程 CPU 时间（毫秒）。 */
  cpuMs: number;
  /** 稳态窗口的真实墙钟时间（毫秒）。 */
  wallMs: number;
  /** 装配 + `runUntil(0)` + 预热的进程 CPU 时间（毫秒）。 */
  coldCpuMs: number;
  /** 装配 + `runUntil(0)` + 预热的真实墙钟时间（毫秒）。 */
  coldWallMs: number;
  usPerSolve: number;
  solves: number;
  components: number;
  factorizations: number;
  leafPlans: number;
  topologyPrepares: number;
  checkpoints: readonly TopicCheckpoint[];
  snapshot: ProbeSnapshot;
}

export async function measureCt107d(options: MeasureOptions = {}): Promise<MeasureResult> {
  const firmware = options.firmware ?? demoFirmware();
  const firmwareName = options.firmwareName ?? FIRMWARE;
  const firmwareSha256 = createHash('sha256').update(firmware).digest('hex');
  const execution = options.execution ?? environmentExecution() ?? 'throughput';
  const warmUpMs = options.warmUpMs ?? WARM_UP_MS;
  const warmUpPs = warmUpMs * MS_PS;
  // 预热现在按 `tickMs` 分批推进；`Infinity` 会让批次循环永不终止，NaN / 负数 /
  // 超安全整数也必须在装配前拒绝，保持与单次 `runUntil` 相同的入参约束。
  if (!Number.isSafeInteger(warmUpPs) || warmUpPs < 0)
    throw new RangeError(
      'warmUpMs must represent a non-negative safe integer number of picoseconds.',
    );
  const measureMs = options.measureMs ?? MEASURE_MS;
  const tickMs = options.tickMs ?? measureMs;
  const tickPs = tickMs * MS_PS;
  if (!Number.isSafeInteger(tickPs) || tickPs <= 0)
    throw new RangeError('tickMs must represent a positive safe integer number of picoseconds.');
  const rounds = Math.max(1, options.rounds ?? ROUNDS);
  const checkpointsMs = [...new Set(options.checkpointMs ?? [])].sort(
    (left, right) => left - right,
  );
  for (const checkpoint of checkpointsMs) {
    const checkpointPs = checkpoint * MS_PS;
    if (!Number.isSafeInteger(checkpointPs) || checkpointPs < 0)
      throw new RangeError(
        'checkpointMs must represent a non-negative safe integer number of picoseconds.',
      );
  }
  const samples: RoundSample[] = [];
  const digests: string[] = [];
  const finalDigests: string[] = [];
  const finalDigestsLegacy: string[] = [];
  const faults: string[] = [];
  const unavailable: Record<string, string> = {};
  let devices = 0;
  let nets = 0;
  let clockFrequency = 0;
  let fingerprints: BoardFingerprints | undefined;

  for (let round = 0; round < rounds; round += 1) {
    const coldCpuBefore = process.cpuUsage();
    const coldWallBefore = performance.now();
    const assembled = await createCt107dBoard({
      firmware,
      ...(options.props === undefined ? {} : { props: options.props }),
      execution,
    });
    const probe = createProbe(assembled.board, assembled.designators);

    try {
      devices = assembled.devices;
      nets = assembled.nets;
      clockFrequency = assembled.clockFrequency;
      fingerprints = assembled.fingerprints;

      assembled.board.runUntil(0);
      // 预热与画布帧循环同口径：按 `tickMs` 批次推进到 `warmUpMs`，末尾不足一个
      // tick 时截到终点；512 ms / 64 ms 恰好 8 次。保留首次 `runUntil(0)`，
      // 并在 `warmUpMs = 0` 时仍推进一次到终点，与旧行为一致。
      const warmUpEnd = warmUpPs;

      do {
        assembled.board.runUntil(Math.min(assembled.board.time + tickPs, warmUpEnd));
      } while (assembled.board.time < warmUpEnd);
      // 冷启动只到预热结束；稳态窗口另有 CPU / 墙钟计时，两者不混在一起。
      const coldCpuMs = elapsed(coldCpuBefore);
      const coldWallMs = performance.now() - coldWallBefore;
      const windowStart = assembled.board.time;
      const end = windowStart + measureMs * MS_PS;
      const checkpointPs = checkpointsMs.map((checkpoint) => checkpoint * MS_PS);

      for (const checkpoint of checkpointPs) {
        if (checkpoint < windowStart || checkpoint > end)
          throw new RangeError(
            `checkpointMs ${checkpoint / MS_PS} is outside the measurement window ` +
              `[${windowStart / MS_PS}, ${end / MS_PS}].`,
          );
        if (checkpoint !== end && (checkpoint - windowStart) % tickPs !== 0)
          throw new RangeError(
            `checkpointMs ${checkpoint / MS_PS} is not on the tick grid ` +
              `(window start ${windowStart / MS_PS} ms, tick ${tickMs} ms).`,
          );
      }

      const network = (assembled.board as unknown as RuntimeLike).network;
      const solvesBefore = network?.stats.solves ?? 0;
      const started = process.cpuUsage();
      const wallStarted = performance.now();

      probe.begin();
      const checkpoints: TopicCheckpoint[] = [];
      let checkpointIndex = 0;
      const capture = (timePs: number): void => {
        checkpoints.push({ simMs: timePs / MS_PS, topics: probe.checkpoint() });
      };

      // 窗口起点本身也作为共同检查点；此后每次推进都停在 tick 或检查点边界。
      while (
        checkpointIndex < checkpointPs.length &&
        checkpointPs[checkpointIndex] === windowStart
      ) {
        capture(checkpointPs[checkpointIndex]!);
        checkpointIndex++;
      }
      while (assembled.board.time < end) {
        const nextTick = Math.min(end, assembled.board.time + tickPs);
        const nextCheckpoint = checkpointPs[checkpointIndex] ?? Number.POSITIVE_INFINITY;
        const target = Math.min(nextTick, nextCheckpoint);

        assembled.board.runUntil(target);
        if (target === nextCheckpoint) {
          capture(nextCheckpoint);
          checkpointIndex++;
        }
      }
      probe.end();

      const windowCpuMs = elapsed(started);
      const windowWallMs = performance.now() - wallStarted;
      const snapshot = probe.read();
      const statistics = network?.stats;
      const { solveCalls, solveUs } = snapshot.counters;
      const solves = (statistics?.solves ?? 0) - solvesBefore;

      samples.push({
        cpuMs: windowCpuMs,
        wallMs: windowWallMs,
        coldCpuMs,
        coldWallMs,
        usPerSolve:
          solveCalls > 0 && solveUs > 0
            ? solveUs / solveCalls
            : solves === 0
              ? 0
              : (windowCpuMs * 1000) / solves,
        solves,
        components: statistics?.components ?? 0,
        factorizations: statistics?.factorizations ?? 0,
        leafPlans: statistics?.leafPlans ?? 0,
        topologyPrepares: statistics?.topologyPrepares ?? 0,
        checkpoints,
        snapshot,
      });
      digests.push(snapshot.digest);
      finalDigests.push(snapshot.finalDigest);
      finalDigestsLegacy.push(snapshot.finalDigestLegacy);

      if (statistics === undefined)
        unavailable.solves =
          '运行时没有暴露 `network.stats`，`solves` / `components` / `factorizations` 记为 0。';
      if (snapshot.counters.solveCalls === 0)
        unavailable.usPerSolve =
          '`network.solveSlots` 不可写，无法单独计时；`usPerSolve` 退化为整窗 CPU / `solves`。';
      if (!snapshot.direct)
        unavailable.directCalls =
          '直接 JIT 没有接管 MCU，`directCalls` 为 0（函数走翻译后解释执行）。';
    } finally {
      for (const fault of assembled.faults) if (!faults.includes(fault)) faults.push(fault);
      probe.dispose();
      assembled.dispose();
    }
  }

  const best = samples.reduce((left, right) => (right.cpuMs < left.cpuMs ? right : left));
  const { counters } = best.snapshot;
  const usPerSolve = Math.min(...samples.map((sample) => sample.usPerSolve));
  const cpuMs = Number(best.cpuMs.toFixed(1));
  const coldCpuMs = Number(best.coldCpuMs.toFixed(1));
  const elapsedWallMs = Number(best.wallMs.toFixed(1));
  const coldElapsedWallMs = Number(best.coldWallMs.toFixed(1));

  return {
    board: 'ct107d',
    firmware: firmwareName,
    firmwareName,
    firmwareBytes: firmware.length,
    firmwareSha256,
    fingerprints: fingerprints!,
    instanceDesignators: best.snapshot.instanceDesignators,
    execution,
    clockFrequency,
    devices,
    nets,
    simMs: measureMs,
    warmUpMs,
    tickMs,
    rounds,
    windowStartMs: warmUpMs,
    windowEndMs: warmUpMs + measureMs,
    cpuMs,
    elapsedWallMs,
    realtimeRatio: best.wallMs === 0 ? 0 : Number((measureMs / best.wallMs).toFixed(3)),
    coldCpuMs,
    coldElapsedWallMs,
    coldRealtimeRatio:
      warmUpMs === 0 || best.coldWallMs === 0 ? 0 : Number((warmUpMs / best.coldWallMs).toFixed(3)),
    // 兼容历史字段：这两个值仍然是 CPU 时间口径，不是墙钟。
    wallMs: cpuMs,
    rtf: Number((cpuMs / measureMs).toFixed(3)),
    coldMs: coldCpuMs,
    usPerSolve: Number(usPerSolve.toFixed(2)),
    solves: best.solves,
    prepareTopology: best.topologyPrepares,
    components: best.components,
    factorizations: best.factorizations,
    leafPlans: best.leafPlans,
    boundaryCalls: counters.boundaryCalls,
    publishCalls: counters.publishCalls,
    electricalPublishes: counters.electricalPublishes,
    topicMessages: counters.topicMessages,
    dirtySlots: counters.dirtySlots,
    direct: best.snapshot.direct,
    directPrograms: best.snapshot.directPrograms,
    compileDirectJit: best.snapshot.compileDirectJit,
    cachedInstructions: best.snapshot.cachedInstructions,
    pollingInstructions: best.snapshot.pollingInstructions,
    directFallbackPcs: best.snapshot.directFallbackPcs,
    directFallbacksExhausted: best.snapshot.directFallbacksExhausted,
    directCalls: counters.directCalls,
    fallbackRate:
      counters.directCalls === 0
        ? 0
        : Number((counters.directFallbacks / counters.directCalls).toFixed(4)),
    statementsPerOperation: best.snapshot.emit.statementsPerOperation,
    statementsPerNestedOperation: best.snapshot.emit.statementsPerNestedOperation,
    emittedStatements: best.snapshot.emit.statements,
    emittedOperations: best.snapshot.emit.operations,
    emittedNestedOperations: best.snapshot.emit.nestedOperations,
    emittedBlocks: best.snapshot.emit.blocks,
    foldedOperations: best.snapshot.emit.foldedOperations,
    selectBlocks: best.snapshot.emit.selectBlocks,
    worstBlock: best.snapshot.emit.worst,
    topicDigest: digests[0] ?? '',
    topicDigestStable: new Set(digests).size === 1,
    checkpointsStable:
      new Set(samples.map((sample) => JSON.stringify(sample.checkpoints))).size === 1,
    checkpoints: best.checkpoints,
    topicFinalDigest: finalDigestsLegacy[0] ?? '',
    topicFinalDigestByDevice: finalDigests[0] ?? '',
    topicFinalTopics: best.snapshot.finalTopics,
    topicFinalPorts: best.snapshot.finalPorts,
    unavailable,
    faults,
  };
}
