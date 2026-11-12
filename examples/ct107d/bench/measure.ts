import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createCt107dBoard, demoFirmware } from './board';

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
}

interface ElectricalNetwork {
  solveSlots(changedSlots?: Iterable<number>): readonly number[];
  readonly stats: ElectricalStats;
}

interface DirectProgram {
  run(frame: unknown, deadline: number): string;
}

interface DirectExecution {
  program: DirectProgram;
}

interface JitLike {
  readonly directPrograms: Map<string, DirectExecution | undefined>;
}

/** 运行时内部结构：`Board` 只公开 `runUntil`，其余字段按现有实现读取。 */
interface RuntimeLike {
  time: number;
  readonly dirtyElectricalSlots: Set<number> | undefined;
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
  readonly direct: boolean;
  readonly digest: string;
}

interface Probe {
  begin(): void;
  end(): void;
  read(): ProbeSnapshot;
  dispose(): void;
}

const cpuMs = (usage: NodeJS.CpuUsage): number => (usage.user + usage.system) / 1000;

const elapsed = (before: NodeJS.CpuUsage): number => cpuMs(process.cpuUsage(before));

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

function createProbe(board: unknown): Probe {
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
  let compiles = 0;
  let instrumented = false;

  const subscription = (board as { topics: TopicBridge }).topics.onDidReceive((message) => {
    if (!active) return;
    counters.topicMessages++;
    hasher.update(`${runtime.time}|${message.topic}|${canonical(message.payload)}\n`);
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
      const dirty = runtime.dirtyElectricalSlots?.size ?? 0;

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
    const counted = (slots?: Iterable<number>): readonly number[] => {
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

  for (const jit of runtime.jits ?? []) {
    const programs = jit.directPrograms;

    if (!(programs instanceof Map)) continue;

    const set = programs.set.bind(programs);
    const mutable = programs as Map<string, DirectExecution | undefined>;

    mutable.set = (key: string, execution: DirectExecution | undefined) => {
      if (execution !== undefined) {
        compiles++;
        // 直接程序本身是冻结的，运行时持有的执行壳不是：换掉 `program` 即可统计调用与回退原因。
        try {
          const program = execution.program;
          const run = program.run.bind(program);

          (execution as { program: DirectProgram }).program = {
            ...program,
            run(frame: unknown, deadline: number) {
              const reason = run(frame, deadline);

              if (active) {
                counters.directCalls++;
                if (reason === 'fallback') counters.directFallbacks++;
              }

              return reason;
            },
          };
          instrumented = true;
        } catch {
          // 结构变化时放弃直接 JIT 计数，其余指标照常输出。
        }
      }

      return set(key, execution);
    };
    restores.push(() => {
      delete (mutable as Partial<Map<string, DirectExecution | undefined>>).set;
    });
  }

  return {
    begin() {
      active = true;
    },
    end() {
      active = false;
    },
    read() {
      let directPrograms = 0;

      for (const jit of runtime.jits ?? []) directPrograms += jit.directPrograms.size;

      return {
        counters: { ...counters },
        compileDirectJit: compiles,
        directPrograms,
        direct: instrumented && counters.directCalls > 0,
        digest: `sha256:${hasher.digest('hex').slice(0, 16)}`,
      };
    },
    dispose() {
      subscription.dispose();

      for (const restore of restores.reverse()) restore();
    },
  };
}

export interface MeasureOptions {
  /** 固件镜像；默认 `assets/ct107d-demo.bin`（8051 演示固件）。 */
  readonly firmware?: Uint8Array;
  /** 覆盖 MCU 属性，例如 `clockFrequency`。 */
  readonly props?: Readonly<Record<string, unknown>>;
  readonly warmUpMs?: number;
  readonly measureMs?: number;
  readonly rounds?: number;
}

export interface MeasureResult {
  readonly board: 'ct107d';
  readonly firmware: string;
  readonly clockFrequency: number;
  readonly devices: number;
  readonly nets: number;
  readonly simMs: number;
  readonly wallMs: number;
  readonly coldMs: number;
  readonly rtf: number;
  readonly usPerSolve: number;
  readonly solves: number;
  readonly prepareTopology: number | null;
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
  readonly directCalls: number;
  readonly fallbackRate: number;
  readonly topicDigest: string;
  readonly topicDigestStable: boolean;
  readonly unavailable: Readonly<Record<string, string>>;
  readonly faults: readonly string[];
}

interface RoundSample {
  cpuMs: number;
  usPerSolve: number;
  solves: number;
  components: number;
  factorizations: number;
  leafPlans: number;
  snapshot: ProbeSnapshot;
}

export async function measureCt107d(options: MeasureOptions = {}): Promise<MeasureResult> {
  const firmware = options.firmware ?? demoFirmware();
  const warmUpMs = options.warmUpMs ?? WARM_UP_MS;
  const measureMs = options.measureMs ?? MEASURE_MS;
  const rounds = Math.max(1, options.rounds ?? ROUNDS);
  const samples: RoundSample[] = [];
  const digests: string[] = [];
  const faults: string[] = [];
  const unavailable: Record<string, string> = {
    prepareTopology:
      '`prepareTopology` 是 `packages/simulator/src/electrical.ts` 的模块私有函数，公开的 `ElectricalStats` 没有对应计数；用 `factorizations` / `leafPlans` 观察拓扑重建频率，要精确计数需要给 `ElectricalStats` 补 `topologyPrepares`（#274 后续）。',
  };
  let coldMs = 0;
  let devices = 0;
  let nets = 0;
  let clockFrequency = 0;

  for (let round = 0; round < rounds; round += 1) {
    const coldStart = process.cpuUsage();
    const assembled = await createCt107dBoard({
      firmware,
      ...(options.props === undefined ? {} : { props: options.props }),
    });
    const probe = createProbe(assembled.board);

    try {
      devices = assembled.devices;
      nets = assembled.nets;
      clockFrequency = assembled.clockFrequency;

      assembled.board.runUntil(0);
      assembled.board.runUntil(warmUpMs * MS_PS);
      coldMs = round === 0 ? elapsed(coldStart) : Math.min(coldMs, elapsed(coldStart));

      const network = (assembled.board as unknown as RuntimeLike).network;
      const solvesBefore = network?.stats.solves ?? 0;
      const started = process.cpuUsage();

      probe.begin();
      assembled.board.runUntil(assembled.board.time + measureMs * MS_PS);
      probe.end();

      const windowMs = elapsed(started);
      const snapshot = probe.read();
      const statistics = network?.stats;
      const { solveCalls, solveUs } = snapshot.counters;
      const solves = (statistics?.solves ?? 0) - solvesBefore;

      samples.push({
        cpuMs: windowMs,
        usPerSolve:
          solveCalls > 0 && solveUs > 0
            ? solveUs / solveCalls
            : solves === 0
              ? 0
              : (windowMs * 1000) / solves,
        solves,
        components: statistics?.components ?? 0,
        factorizations: statistics?.factorizations ?? 0,
        leafPlans: statistics?.leafPlans ?? 0,
        snapshot,
      });
      digests.push(snapshot.digest);

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

  return {
    board: 'ct107d',
    firmware: FIRMWARE,
    clockFrequency,
    devices,
    nets,
    simMs: measureMs,
    wallMs: Number(best.cpuMs.toFixed(1)),
    coldMs: Number(coldMs.toFixed(1)),
    rtf: Number((best.cpuMs / measureMs).toFixed(3)),
    usPerSolve: Number(usPerSolve.toFixed(2)),
    solves: best.solves,
    prepareTopology: null,
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
    directCalls: counters.directCalls,
    fallbackRate:
      counters.directCalls === 0
        ? 0
        : Number((counters.directFallbacks / counters.directCalls).toFixed(4)),
    topicDigest: digests[0] ?? '',
    topicDigestStable: new Set(digests).size === 1,
    unavailable,
    faults,
  };
}
