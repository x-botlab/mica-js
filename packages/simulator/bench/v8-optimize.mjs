import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

/**
 * 直接程序的 V8 优化状态基准。
 *
 * issue #253 的验收项（每个生成函数字节码 < 61440、`--trace-opt` 出现 TurboFan、
 * 不再出现 `too big to be optimized`）此前没有可复现的产出方式：仓库里只有
 * `stm32g431/v8-trace.mjs`，它统计分层事件，既不报告函数规模，也不保留原始 trace。
 *
 * 三个维度，每个指标都标注是精确值还是代理值：
 * 1. `generatedSource`：生成源码的函数划分（分片数、最大函数字符数，代理指标）与
 *    V8 打印的 `Bytecode length`（精确）；
 * 2. `optimizationEvents`：`--trace-opt` / `--trace-deopt` 的事件计数与涉及函数名（精确）；
 * 3. `optimizationStatus`：直接程序 `run` 对象上 `%GetOptimizationStatus` 的位图（精确）。
 *
 * 两次子进程：`trace` 用请求的窗口测事件与优化状态，`bytecode` 用短窗口打开
 * `--print-bytecode` 取字节码（同一窗口下输出过大）。子进程只回写 JSON 摘要，
 * V8 trace 走 **stdout**（Node 24 实测 stderr 为空），两个流都落盘后再由父进程解析。
 */

/** V8 `--max-optimized-bytecode-size` 的默认值，超过即 `too big to be optimized`。 */
export const BYTECODE_BUDGET = 61_440;

export const WORKLOADS = Object.freeze([
  'stress',
  'gpio-blink',
  'mixed',
  'systick-irq',
  'alu-branch',
  'ram-copy',
]);

/**
 * `stress` 指令最多、当前唯一会分片；`gpio-blink` 与 #252–#256 的旧读数同源。
 * 新增负载只需提供 `bench/stm32g431.mjs` 那样的 `create(sdk, { workload })` 适配器——
 * CT107D（#274）也走直接后端，缺的是可裸 node 加载的器件入口，不是 JIT。
 */
export const DEFAULT_WORKLOADS = Object.freeze(['stress', 'gpio-blink']);

/** 交叉包负载本轮未纳入；入口处直接拒绝，避免给出无法与旧数字比较的读数。 */
const UNSUPPORTED = Object.freeze({
  'ct107d-demo':
    'CT107D 的器件源码用无扩展名相对引用，只有打包器产出的 examples/ct107d/dist 才能加载，裸 node 跑不起来；' +
    '接入需要先依赖别的包的构建产物（整板基准见 #274），本轮只保留包内的 stm32 负载',
});

const TRACE_FLAGS = ['--trace-opt', '--trace-deopt', '--allow-natives-syntax', '--no-warnings'];
const BYTECODE_FLAGS = ['--print-bytecode', '--allow-natives-syntax', '--no-warnings'];

const SHARD_NAME = /^(?:stepShard|resumeShard)\d+$/;

const file = fileURLToPath(import.meta.url);
const BENCH = join(file, '..');

function fail(error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
}

// ---------------------------------------------------------------- 子进程

async function child([kind, workload, cyclesText, reportPath]) {
  const cycles = Number(cyclesText);
  const started = performance.now();
  const programs = [];
  const nativeFunction = globalThis.Function;
  // 生成源码只有一条出口：`compileDirectJit` 里的 `new Function(...)`。拦下构造参数即得到
  // 每次下发的完整源码；再包一层工厂调用，就拿到运行时真正持有的 `run` 对象句柄。
  globalThis.Function = new Proxy(nativeFunction, {
    construct(target, args) {
      const factory = Reflect.construct(target, args);
      const source = args.at(-1);
      if (typeof source !== 'string' || !source.includes('F.states')) return factory;
      const program = parseProgram(source);
      if (!program) return factory;
      programs.push(program);
      return (...callArgs) => {
        const run = factory(...callArgs);
        program.run ??= run;
        return run;
      };
    },
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, args);
    },
  });
  const optimizationStatus = nativeFunction('fn', 'return %GetOptimizationStatus(fn)');
  // `%DebugPrint` 打印的 `shared_info: 0x…` 与 `--print-bytecode` 头里的 SFI 地址同源，
  // 因此字节码能按对象对齐，不必按函数名猜（宿主里也有叫 run 的函数）。
  const debugPrint =
    kind === 'bytecode' ? nativeFunction('fn', 'return %DebugPrint(fn)') : undefined;
  const sdk = await import('../dist/index.js');
  const { create } = await import('./stm32g431.mjs');
  const bench = create(sdk, { workload });
  try {
    bench.step(cycles);
    const wallMs = performance.now() - started;
    for (const jit of bench.board.jits ?? []) {
      for (const [key, execution] of jit.directPrograms ?? []) {
        const program = programs.find((entry) => entry.run === execution?.program?.run);
        if (program) program.key = key.slice(0, 120);
      }
    }
    programs.forEach((program, index) => {
      program.index = index;
      program.status = typeof program.run === 'function' ? optimizationStatus(program.run) : null;
      program.dispatcherCharacters = program.run?.toString().length ?? 0;
      if (debugPrint && program.run) {
        process.stdout.write(`MICA_DIRECT_RUN ${index} ${program.dispatcherCharacters}\n`);
        debugPrint(program.run);
      }
      program.run = undefined;
    });
    writeFileSync(reportPath, JSON.stringify({ kind, workload, cycles, wallMs, programs }));
  } finally {
    bench.dispose();
  }
}

function parseProgram(source) {
  let functions;
  try {
    functions = parseFunctions(source);
  } catch {
    return undefined;
  }
  return {
    run: undefined,
    characters: source.length,
    functions,
    cases: (source.match(/^case /gm) ?? []).length,
  };
}

// ---------------------------------------------------------------- 父进程

async function main(argv) {
  const options = parseArgs(argv);
  if (options.list) {
    console.log(JSON.stringify({ workloads: WORKLOADS, unsupported: UNSUPPORTED }, null, 2));
    return;
  }
  if (!existsSync(join(BENCH, '..', 'dist', 'index.js')))
    throw new Error(
      'Missing packages/simulator/dist; run `pnpm --filter @mica-js/simulator build`',
    );
  const reports = [];
  for (const workload of options.workloads) reports.push(measure(workload, options));
  if (!options.quiet) for (const report of reports) printSummary(report);
  console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
}

function parseArgs(argv) {
  const options = {
    workloads: [...DEFAULT_WORKLOADS],
    cycles: 1_000_000,
    bytecodeCycles: 5_000,
    bytecode: true,
    quiet: false,
    list: false,
    keepTrace: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new TypeError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === '--workload') options.workloads = [workloadName(value())];
    else if (arg === '--all') options.workloads = [...WORKLOADS];
    else if (arg === '--cycles') options.cycles = integer(value(), 1, 2_000_000, 'cycles');
    else if (arg === '--bytecode-cycles')
      options.bytecodeCycles = integer(value(), 1, 2_000_000, 'bytecode-cycles');
    else if (arg === '--no-bytecode') options.bytecode = false;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--keep-trace') options.keepTrace = true;
    else if (arg === '--list' || arg === '--help') options.list = true;
    else throw new TypeError(`Unknown option: ${arg}`);
  }
  return options;
}

function workloadName(name) {
  if (UNSUPPORTED[name]) throw new TypeError(`${name} is not supported: ${UNSUPPORTED[name]}`);
  if (!WORKLOADS.includes(name))
    throw new RangeError(`Unknown workload: ${name}; expected one of ${WORKLOADS.join(', ')}`);
  return name;
}

function integer(text, min, max, name) {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  return value;
}

function measure(workload, options) {
  const directory = mkdtempSync(join(BENCH, '.v8-optimize-'));
  try {
    const trace = spawn(directory, 'trace', workload, options.cycles);
    const bytecode = options.bytecode
      ? spawn(directory, 'bytecode', workload, Math.min(options.cycles, options.bytecodeCycles))
      : undefined;
    return summarize({ workload, cycles: options.cycles, trace, bytecode });
  } finally {
    if (options.keepTrace) console.error(`trace kept in ${directory}`);
    else rmSync(directory, { recursive: true, force: true });
  }
}

function spawn(directory, kind, workload, cycles) {
  const flags = kind === 'trace' ? TRACE_FLAGS : BYTECODE_FLAGS;
  const reportPath = join(directory, `${kind}.report.json`);
  const result = spawnSync(
    process.execPath,
    [...flags, file, '--child', kind, workload, String(cycles), reportPath],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `child exited ${result.status}`);
  writeFileSync(join(directory, `${kind}.stdout.log`), result.stdout ?? '');
  writeFileSync(join(directory, `${kind}.stderr.log`), result.stderr ?? '');
  return {
    kind,
    cycles,
    directory,
    text: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    report: JSON.parse(readFileSync(reportPath, 'utf8')),
  };
}

// ---------------------------------------------------------------- 解析

/** `[marking|compiling method|completed compiling 0x… <JSFunction name (sfi = …)> (target TIER) …]`. */
export function parseTrace(text) {
  const events = {
    marking: [],
    compiling: [],
    completed: [],
    disabled: [],
    deopts: [],
    turboFan: [],
    maglev: [],
    completedOptimizing: 0,
  };
  for (const line of text.split('\n')) {
    if (!line.startsWith('[')) continue;
    const name =
      /<JSFunction (\S*?) \(sfi/.exec(line)?.[1] ??
      /<SharedFunctionInfo (\S*?)[,>]/.exec(line)?.[1] ??
      '';
    const tier = /\(target (MAGLEV|TURBOFAN_JS)\)/.exec(line)?.[1];
    const phase = /^\[(marking|compiling method|completed compiling) /.exec(line)?.[1];
    if (phase && tier) {
      const key =
        phase === 'marking' ? 'marking' : phase === 'compiling method' ? 'compiling' : 'completed';
      events[key].push({ function: name, tier });
      if (key === 'completed')
        (tier === 'TURBOFAN_JS' ? events.turboFan : events.maglev).push(name);
      continue;
    }
    if (line.startsWith('[completed optimizing ')) {
      events.completedOptimizing += 1;
      continue;
    }
    const disabled = /^\[disabled optimization for .*?, reason: (.+)\]$/.exec(line);
    if (disabled) {
      events.disabled.push({ function: name, reason: disabled[1] });
      continue;
    }
    const deopt = /^\[bailout \(kind: ([^,]+), reason: ([^)]+)\): begin\. deoptimizing /.exec(line);
    if (deopt)
      events.deopts.push({
        function: name,
        kind: deopt[1],
        reason: deopt[2],
        bytecodeOffset: Number(/bytecode offset (\d+)/.exec(line)?.[1] ?? -1),
      });
  }
  return events;
}

/**
 * `--print-bytecode` 的 `[generated bytecode for function: name (0x<sfi> …)]` 加
 * `Bytecode length: N`。按 SFI 索引可精确对齐 `%DebugPrint` 报告的对象；按名字索引
 * 只能取同名函数所有实例的最大值（分片是惰性编译，只有真正跑到的分片才会出现）。
 */
export function parseBytecode(text) {
  const lines = text.split('\n');
  const bySfi = new Map();
  const byName = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\[generated bytecode for function: (\S*) \(0x([0-9a-f]+) </.exec(lines[index]);
    if (!header) continue;
    const name = header[1] || '(anonymous)';
    let length;
    for (let next = index + 1; next < Math.min(index + 8, lines.length); next += 1) {
      const match = /^Bytecode length: (\d+)/.exec(lines[next]);
      if (match) {
        length = Number(match[1]);
        break;
      }
    }
    if (length === undefined) continue;
    bySfi.set(header[2], { name, length });
    if (!SHARD_NAME.test(name) && name !== 'run') continue;
    const entry = byName.get(name) ?? { name, count: 0, min: Infinity, max: 0 };
    entry.count += 1;
    entry.min = Math.min(entry.min, length);
    entry.max = Math.max(entry.max, length);
    byName.set(name, entry);
  }
  return { bySfi, byName };
}

/** 子进程在 `%DebugPrint` 前打的哨兵行，后接该对象的 `shared_info` 地址。 */
export function parseDirectRuns(text) {
  const lines = text.split('\n');
  const runs = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^MICA_DIRECT_RUN (\d+) (\d+)$/.exec(lines[index]);
    if (!marker) continue;
    let print = index + 1;
    while (print < lines.length && !lines[print].startsWith('DebugPrint: ')) print += 1;
    let sfi;
    // `%DebugPrint` 先整段打印该函数的源码，`shared_info` 排在几百行之后。
    for (let next = print + 1; next < Math.min(print + 4000, lines.length); next += 1) {
      if (lines[next].startsWith('DebugPrint: ') || /^MICA_DIRECT_RUN /.test(lines[next])) break;
      const shared = /^\s*- shared_info: 0x([0-9a-f]+) </.exec(lines[next]);
      if (shared) {
        sfi = shared[1];
        break;
      }
    }
    runs.push({
      index: Number(marker[1]),
      dispatcherCharacters: Number(marker[2]),
      sfi: sfi ?? null,
    });
  }
  return runs;
}

/** 生成源码里的函数及其字符数；括号配对跳过字符串与注释。 */
export function parseFunctions(source) {
  const functions = [];
  for (const match of source.matchAll(/function ([A-Za-z_$][\w$]*)\(/g)) {
    const brace = source.indexOf('{', match.index + match[0].length);
    if (brace === -1) continue;
    const name = match[1];
    functions.push({
      name,
      characters: sliceFunction(source, match.index, brace, name),
      kind: name.startsWith('stepShard')
        ? 'step'
        : name.startsWith('resumeShard')
          ? 'resume'
          : name === 'run'
            ? 'dispatcher'
            : 'other',
    });
  }
  return functions;
}

function sliceFunction(text, index, brace, name) {
  let depth = 0;
  let quote;
  for (let cursor = brace; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (quote) {
      if (character === '\\') cursor += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '/' && text[cursor + 1] === '/') {
      const end = text.indexOf('\n', cursor);
      cursor = end === -1 ? text.length : end;
    } else if (character === '/' && text[cursor + 1] === '*') {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end === -1 ? text.length : end + 1;
    } else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return cursor + 1 - index;
    }
  }
  throw new SyntaxError(`Unterminated function ${name}`);
}

// ---------------------------------------------------------------- 汇总

export function summarize(input) {
  const events = parseTrace(input.trace.text);
  const programs = input.trace.report.programs;
  const bytecodePrograms = input.bytecode?.report.programs ?? [];
  const bytecode = input.bytecode
    ? parseBytecode(input.bytecode.text)
    : { bySfi: new Map(), byName: new Map() };
  const ranks = new Map(
    (input.bytecode ? parseDirectRuns(input.bytecode.text) : []).map((run) => [run.index, run]),
  );
  const dispatchers = bytecodePrograms
    .map((program) => {
      const run = ranks.get(program.index);
      const measured = run?.sfi ? bytecode.bySfi.get(run.sfi) : undefined;
      return {
        index: program.index,
        characters: program.characters,
        shards: program.functions.filter((fn) => fn.kind !== 'dispatcher').length,
        bytecode: measured?.length ?? null,
      };
    })
    .sort((left, right) => right.characters - left.characters);

  const selected = [...programs].sort((left, right) => right.characters - left.characters)[0];
  const monoliths = programs.filter(
    (program) => !program.functions.some((fn) => fn.kind === 'step'),
  );
  const largestMonolith = monoliths.sort((left, right) => right.characters - left.characters)[0];
  const sharded = programs.filter((program) => program.functions.some((fn) => fn.kind === 'step'));
  const largestFunction = selected
    ? [...selected.functions].sort((left, right) => right.characters - left.characters)[0]
    : undefined;
  const selectedShards = (selected?.functions ?? []).filter((fn) => fn.kind !== 'dispatcher');
  const shardBytecode = [...bytecode.byName.values()]
    .filter((entry) => SHARD_NAME.test(entry.name))
    .sort((left, right) => right.max - left.max);
  const maxShardBytecode = shardBytecode[0]?.max ?? 0;
  const measuredDispatchers = dispatchers.filter((entry) => entry.bytecode !== null);
  const maxDispatcherBytecode = Math.max(0, ...measuredDispatchers.map((entry) => entry.bytecode));
  const maxMonolithDispatcherBytecode = Math.max(
    0,
    ...measuredDispatchers.filter((entry) => entry.shards === 0).map((entry) => entry.bytecode),
  );
  const overBudget = [
    ...shardBytecode
      .filter((entry) => entry.max > BYTECODE_BUDGET)
      .map((entry) => ({ name: entry.name, bytecode: entry.max })),
    ...measuredDispatchers
      .filter((entry) => entry.bytecode > BYTECODE_BUDGET)
      .map((entry) => ({ name: 'run', program: entry.index, bytecode: entry.bytecode })),
  ];

  const generatedTurboFan = [...new Set(events.turboFan.filter((name) => SHARD_NAME.test(name)))];
  const generatedMaglev = [...new Set(events.maglev.filter((name) => SHARD_NAME.test(name)))];
  const tooBig = events.disabled.filter((entry) => /too big/i.test(entry.reason));
  const deoptReasons = {};
  for (const deopt of events.deopts)
    deoptReasons[deopt.reason] = (deoptReasons[deopt.reason] ?? 0) + 1;

  const statuses = programs.map((program) => ({
    index: program.index,
    key: program.key ?? null,
    status: program.status ?? 0,
    bits: decodeStatus(program.status ?? 0),
    turboFanned: ((program.status ?? 0) & TURBOFAN_BIT) !== 0,
  }));
  const turboFanned = statuses.filter((entry) => entry.turboFanned);

  return {
    workload: input.workload,
    cycles: input.cycles,
    bytecodeCycles: input.bytecode?.cycles ?? null,
    wallMs: Math.round(input.trace.report.wallMs),
    node: process.version,
    precision: {
      'generatedSource.characters': 'proxy（生成源码字符数；V8 比较的是字节码，通常小 3–5 倍）',
      'generatedSource.functions': 'exact（解析自实际下发给 new Function 的源码）',
      'generatedSource.shardBytecode':
        'exact（V8 打印的 Bytecode length，同名分片取所有实例最大值）',
      'generatedSource.dispatcherBytecode':
        'exact（%DebugPrint 的 shared_info 与 --print-bytecode 头按地址对齐）',
      optimizationEvents: 'exact（V8 --trace-opt / --trace-deopt 原文）',
      optimizationStatus: 'exact（%GetOptimizationStatus 位图，位定义按 V8 runtime-test.cc）',
    },
    generatedSource: {
      programs: programs.length,
      shardedPrograms: sharded.length,
      monolithicPrograms: programs.length - sharded.length,
      largestProgramCharacters: selected?.characters ?? 0,
      largestMonolithCharacters: largestMonolith?.characters ?? null,
      stepShards: countKind(selected, 'step'),
      resumeShards: countKind(selected, 'resume'),
      cases: selected?.cases ?? 0,
      largestFunction: largestFunction && {
        name: largestFunction.name,
        characters: largestFunction.characters,
      },
      functions: (selected?.functions ?? []).map((fn) => ({
        name: fn.name,
        kind: fn.kind,
        characters: fn.characters,
        bytecode: bytecode.byName.get(fn.name) ?? null,
      })),
      bytecodeBudget: BYTECODE_BUDGET,
      measuredShards: shardBytecode.length,
      shardBytecodeCoverage: `${shardBytecode.length}/${selectedShards.length}`,
      maxShardBytecode: maxShardBytecode || null,
      maxShardBytecodeFunction: shardBytecode[0]?.name ?? null,
      dispatchers,
      dispatcherBytecodeCoverage: `${measuredDispatchers.length}/${dispatchers.length}`,
      maxDispatcherBytecode: maxDispatcherBytecode || null,
      maxMonolithDispatcherBytecode: maxMonolithDispatcherBytecode || null,
      bytecodeOverBudget: overBudget,
    },
    optimizationEvents: {
      count: {
        marking: events.marking.length,
        compiling: events.compiling.length,
        completedMaglev: events.maglev.length,
        completedTurboFan: events.turboFan.length,
        completedOptimizing: events.completedOptimizing,
        deopts: events.deopts.length,
      },
      shardFunctions: {
        turboFan: generatedTurboFan,
        maglevOnly: generatedMaglev.filter((name) => !generatedTurboFan.includes(name)),
      },
      tooBigToBeOptimized: tooBig,
      disabledOptimization: events.disabled.filter((entry) => !/too big/i.test(entry.reason)),
      deopts: events.deopts,
      deoptReasons,
      dispatcherEvents: {
        turboFan: events.turboFan.includes('run'),
        maglev: events.maglev.includes('run'),
        note: 'trace 里的 run 可能与宿主同名函数混淆，run 的结论以 optimizationStatus 为准',
      },
    },
    optimizationStatus: {
      turboFanBit: TURBOFAN_BIT,
      functions: statuses,
      turboFanned: turboFanned.length,
      optimized: statuses.filter((entry) => entry.bits.includes('optimized')).length,
      interpreted: statuses.filter((entry) => entry.bits.includes('interpreted')).length,
    },
    verdict: {
      sharded: selectedShards.length >= 2,
      shardFunctionCount: selectedShards.length,
      turboFanObserved: generatedTurboFan.length > 0 || turboFanned.length > 0,
      allShardsTurboFanned:
        generatedMaglev.length > 0 &&
        generatedMaglev.every((name) => generatedTurboFan.includes(name)),
      tooBigToBeOptimized: tooBig.length > 0,
      bytecodeOverBudget: overBudget.length > 0,
      maxFunctionCharacters: largestFunction?.characters ?? 0,
      maxBytecode: Math.max(maxShardBytecode, maxDispatcherBytecode) || null,
    },
  };
}

function countKind(program, kind) {
  return (program?.functions ?? []).filter((fn) => fn.kind === kind).length;
}

/** V8 8.9 起 `%GetOptimizationStatus` 的位定义（runtime-test.cc）。 */
const TURBOFAN_BIT = 64;
const STATUS_BITS = Object.freeze([
  [1, 'is-function'],
  [2, 'never-optimize'],
  [4, 'always-optimize'],
  [8, 'maybe-deopted'],
  [16, 'optimized'],
  [32, 'maglev'],
  [64, 'turbo-fanned'],
  [128, 'interpreted'],
  [256, 'marked-for-optimization'],
  [512, 'marked-for-concurrent-optimization'],
  [1024, 'optimizing-concurrently'],
  [2048, 'is-executing'],
  [4096, 'topmost-frame-turbo-fanned'],
  [8192, 'lite-mode'],
  [16384, 'marked-for-deoptimization'],
  [32768, 'baseline'],
  [65536, 'topmost-frame-interpreted'],
  [131072, 'is-lazy'],
  [262144, 'topmost-frame-baseline'],
]);

function decodeStatus(status) {
  return STATUS_BITS.filter(([bit]) => (status & bit) !== 0).map(([, name]) => name);
}

function printSummary(report) {
  const source = report.generatedSource;
  const events = report.optimizationEvents;
  const status = report.optimizationStatus;
  const verdict = report.verdict;
  console.error(
    [
      `V8 优化状态 · ${report.workload} · ${report.cycles.toLocaleString('en-US')} cycles · ${report.wallMs} ms · ${report.node}`,
      `源码[代理] 最大程序 ${source.largestProgramCharacters.toLocaleString('en-US')} 字符 / ${source.stepShards} step + ${source.resumeShards} resume 分片；` +
        `${source.programs} 个直接程序（${source.shardedPrograms} 个分片形态，最大单函数形态 ${source.largestMonolithCharacters ?? 'n/a'} 字符）；` +
        `最大函数 ${source.largestFunction?.name ?? 'n/a'} = ${source.largestFunction?.characters ?? 0} 字符`,
      `字节码[精确] 分片最大 ${source.maxShardBytecode ?? 'n/a'} B（${source.maxShardBytecodeFunction ?? 'n/a'}，覆盖 ${source.shardBytecodeCoverage}）；` +
        `派发器最大 ${source.maxDispatcherBytecode ?? 'n/a'} B（单函数形态 ${source.maxMonolithDispatcherBytecode ?? 'n/a'} B，` +
        `覆盖 ${source.dispatcherBytecodeCoverage}，窗口 ${report.bytecodeCycles ?? 'n/a'} cycles）；阈值 ${source.bytecodeBudget}，超限 ${source.bytecodeOverBudget.length}`,
      `事件[精确] 完成编译 TurboFan ${events.count.completedTurboFan} / Maglev ${events.count.completedMaglev}，deopt ${events.count.deopts}，too big ${events.tooBigToBeOptimized.length}`,
      `分片 TurboFan ${events.shardFunctions.turboFan.length} 个${events.shardFunctions.maglevOnly.length ? `；仅 Maglev：${events.shardFunctions.maglevOnly.join(', ')}` : ''}`,
      `状态[精确] ${status.functions.length} 个 run：turbo-fanned ${status.turboFanned}，optimized ${status.optimized}，interpreted ${status.interpreted}`,
      `结论：分片 ${verdict.sharded ? '成立' : `未触发（最大程序仅 ${source.largestProgramCharacters} 字符）`}；TurboFan ${verdict.turboFanObserved ? '已出现' : '未出现'}；` +
        `字节码超限 ${verdict.bytecodeOverBudget ? '存在' : '无'}；too big ${verdict.tooBigToBeOptimized ? '存在（已知失败）' : '无'}`,
    ].join('\n'),
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === file) {
  if (process.argv[2] === '--child') child(process.argv.slice(3)).catch(fail);
  else main(process.argv.slice(2)).catch(fail);
}
