import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BYTECODE_BUDGET,
  parseBytecode,
  parseFunctions,
  parseTrace,
  summarize,
} from './v8-optimize.mjs';

/**
 * 直接程序的 V8 优化状态基准。
 *
 * 这套断言是 issue #253 验收的可执行版本：分片必须真的存在（不许退回单函数巨石），
 * 且 V8 不许因为函数体积拒绝优化。若某天 `too big to be optimized` 真的出现了，
 * 允许的做法是把它写进报告，不是放宽这里。
 */

const CLI = fileURLToPath(new URL('./v8-optimize.mjs', import.meta.url));
const BENCH = join(CLI, '..');

/** `stress` 需要约 100 万 cycles 才会把分片推进到 TurboFan（更短的窗口只有 Maglev）。 */
const CYCLES = 1_000_000;

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: BENCH,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return { report: JSON.parse(result.stdout), summary: result.stderr };
}

describe('v8-optimize 基准', () => {
  let measured;

  // 一次测量覆盖三条断言：`stress` 单次约 6–8 s，重复跑只会拉长测试而不增加信息。
  before(() => {
    measured = run(['--workload', 'stress', '--cycles', String(CYCLES)]);
  });

  it('产出三个维度：生成源码规模、V8 优化事件、优化状态', () => {
    const { report, summary } = measured;

    assert.equal(report.workload, 'stress');
    assert.equal(report.cycles, CYCLES);
    assert.ok(report.generatedSource.programs > 0);
    assert.ok(report.generatedSource.largestProgramCharacters > 0);
    assert.ok(report.generatedSource.largestFunction.characters > 0);
    assert.ok(report.optimizationEvents.count.completedTurboFan > 0);
    assert.ok(report.optimizationStatus.functions.length > 0);
    assert.match(summary, /源码\[代理\]/);
    assert.match(summary, /字节码\[精确\]/);
  });

  it('直接程序被拆成多个分片函数，而不是一个巨石', () => {
    const source = measured.report.generatedSource;

    assert.ok(source.shardedPrograms > 0, '至少有一个直接程序走了分片路径');
    assert.ok(source.stepShards >= 2, `stepShard 数量 ${source.stepShards} 应远大于 1`);
    const names = source.functions.map((fn) => fn.name);
    assert.ok(names.includes('run'), '保留轻量派发器');
    assert.ok(
      source.largestFunction.characters < source.largestProgramCharacters,
      '最大函数必须小于整个程序的源码，否则说明还是一体化生成',
    );
    assert.ok(source.stepShards + source.resumeShards >= 4);
  });

  it('没有函数因体积被 V8 拒绝优化', () => {
    const report = measured.report;

    // 已知失败只允许写进报告；这里不放宽。
    assert.deepEqual(report.optimizationEvents.tooBigToBeOptimized, []);
    assert.equal(report.verdict.tooBigToBeOptimized, false);
    assert.deepEqual(report.generatedSource.bytecodeOverBudget, []);
    assert.ok(
      report.generatedSource.maxShardBytecode < BYTECODE_BUDGET,
      `分片字节码 ${report.generatedSource.maxShardBytecode} 必须低于 ${BYTECODE_BUDGET}`,
    );
  });

  it('生成函数真的进了 TurboFan，且 run 的位图带 TurboFan 位', () => {
    const report = measured.report;

    assert.equal(report.verdict.turboFanObserved, true);
    assert.ok(report.optimizationEvents.shardFunctions.turboFan.length > 0);
    const turboFanned = report.optimizationStatus.functions.filter((entry) => entry.turboFanned);
    assert.ok(turboFanned.length > 0, '%GetOptimizationStatus 里应至少有一个 run 带 TurboFan 位');
    for (const entry of turboFanned) assert.ok(entry.bits.includes('turbo-fanned'));
  });

  it('交叉包负载被显式拒绝，而不是给出无法比较的读数', () => {
    const result = spawnSync(process.execPath, [CLI, '--workload', 'ct107d-demo'], {
      cwd: BENCH,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ct107d-demo is not supported/);
    assert.match(result.stderr, /examples\/ct107d\/dist/);
  });
});

describe('v8-optimize 解析', () => {
  it('从 trace 里区分 TurboFan、Maglev 与体积拒绝', () => {
    const trace = [
      '[marking 0x1 <JSFunction stepShard3 (sfi = 0x2)> for optimization to MAGLEV, ConcurrencyMode::kConcurrent, reason: hot and stable]',
      '[completed compiling 0x1 <JSFunction stepShard3 (sfi = 0x2)> (target MAGLEV) - took 0.000, 1.000, 0.000 ms]',
      '[completed compiling 0x1 <JSFunction stepShard3 (sfi = 0x2)> (target TURBOFAN_JS) - took 0.000, 2.000, 0.000 ms]',
      '[disabled optimization for 0x3 <SharedFunctionInfo run>, reason: Function is too big to be optimized]',
      '[bailout (kind: deopt-eager, reason: Insufficient type feedback for generic keyed access): begin. deoptimizing 0x1 <JSFunction stepShard3 (sfi = 0x2)>, 0x4 <Code MAGLEV>, opt id 7, bytecode offset 42, deopt exit 1]',
    ].join('\n');
    const events = parseTrace(trace);

    assert.deepEqual(events.turboFan, ['stepShard3']);
    assert.deepEqual(events.maglev, ['stepShard3']);
    assert.deepEqual(events.disabled, [
      { function: 'run', reason: 'Function is too big to be optimized' },
    ]);
    assert.deepEqual(events.deopts, [
      {
        function: 'stepShard3',
        kind: 'deopt-eager',
        reason: 'Insufficient type feedback for generic keyed access',
        bytecodeOffset: 42,
      },
    ]);
  });

  it('按 SFI 对齐字节码，按名字只统计分片', () => {
    const text = [
      '[generated bytecode for function: stepShard0 (0x00aa <SharedFunctionInfo stepShard0>)]',
      'Bytecode length: 1200',
      'Parameter count 4',
      '[generated bytecode for function: run (0x00bb <SharedFunctionInfo run>)]',
      'Bytecode length: 900',
      'Parameter count 3',
      '[generated bytecode for function: run (0x00cc <SharedFunctionInfo run>)]',
      'Bytecode length: 60',
      'Parameter count 3',
      '[generated bytecode for function: helper (0x00dd <SharedFunctionInfo helper>)]',
      'Bytecode length: 10',
    ].join('\n');
    const parsed = parseBytecode(text);

    assert.equal(parsed.bySfi.get('00aa').length, 1200);
    assert.equal(parsed.bySfi.get('00bb').length, 900);
    assert.deepEqual(parsed.byName.get('stepShard0'), {
      name: 'stepShard0',
      count: 1,
      min: 1200,
      max: 1200,
    });
    assert.deepEqual(parsed.byName.get('run'), { name: 'run', count: 2, min: 60, max: 900 });
    assert.equal(parsed.byName.has('helper'), false);
  });

  it('按花括号切分生成源码里的函数，忽略字符串与注释里的括号', () => {
    const source = [
      '"use strict";',
      'function stepShard0(F, deadline, pc) {',
      'switch (pc) { case 1: return "a}b"; }',
      '}',
      'function run(F, deadline) {',
      '// } 注释里的括号不算',
      'while (true) { if (F.time >= deadline) return "deadline"; }',
      '}',
    ].join('\n');
    const functions = parseFunctions(source);

    assert.deepEqual(
      functions.map((fn) => [fn.name, fn.kind]),
      [
        ['stepShard0', 'step'],
        ['run', 'dispatcher'],
      ],
    );
    assert.equal(
      functions[0].characters,
      source.indexOf('\nfunction run') - source.indexOf('function stepShard0'),
    );
    assert.equal(functions[1].characters, source.length - source.indexOf('function run'));
  });

  it('汇总时把分片形态与单函数形态分开计数', () => {
    const report = summarize({
      workload: 'unit',
      cycles: 10,
      trace: {
        text: '',
        report: {
          wallMs: 1,
          programs: [
            {
              index: 0,
              characters: 500,
              cases: 3,
              functions: [
                { name: 'run', kind: 'dispatcher', characters: 100 },
                { name: 'stepShard0', kind: 'step', characters: 300 },
                { name: 'resumeShard0', kind: 'resume', characters: 80 },
              ],
              status: 16 | 64,
            },
            {
              index: 1,
              characters: 200,
              cases: 2,
              functions: [{ name: 'run', kind: 'dispatcher', characters: 200 }],
              status: 128,
            },
          ],
        },
      },
    });

    assert.equal(report.generatedSource.programs, 2);
    assert.equal(report.generatedSource.shardedPrograms, 1);
    assert.equal(report.generatedSource.stepShards, 1);
    assert.equal(report.generatedSource.resumeShards, 1);
    assert.equal(report.generatedSource.largestMonolithCharacters, 200);
    assert.equal(report.verdict.sharded, true);
    assert.equal(report.optimizationStatus.turboFanned, 1);
    assert.deepEqual(report.optimizationStatus.functions[0].bits, ['optimized', 'turbo-fanned']);
  });
});
