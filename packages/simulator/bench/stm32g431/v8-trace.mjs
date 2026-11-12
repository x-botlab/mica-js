import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const file = fileURLToPath(import.meta.url);
const child = process.argv[2] === '--child';

if (child) {
  const workload = process.argv[3] ?? 'stress';
  const cycles = Number(process.argv[4] ?? 60_000);
  const reportPath = process.argv[5];
  if (!reportPath) throw new TypeError('child requires a report path');
  const sdk = await import('../../dist/index.js');
  const { create } = await import('../stm32g431.mjs');
  const bench = create(sdk, { workload });
  try {
    bench.step(cycles);
    bench.verify();
    writeFileSync(reportPath, JSON.stringify({ workload, cycles, profile: bench.profile() }));
  } finally {
    bench.dispose();
  }
} else {
  const workload = process.argv[2] ?? 'stress';
  const cycles = Number(process.argv[3] ?? 60_000);
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 1_000_000)
    throw new RangeError('cycles must be an integer in [1, 1000000]');
  const started = performance.now();
  const directory = mkdtempSync(join(tmpdir(), 'mica-stm32-v8-'));
  const reportPath = join(directory, 'report.json');
  let result;
  let input;
  try {
    result = spawnSync(
      process.execPath,
      ['--trace-opt', '--trace-deopt', file, '--child', workload, String(cycles), reportPath],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `child exited ${result.status}`);
    input = JSON.parse(readFileSync(reportPath, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const stdout = result.stdout.replace(/\r/g, '');
  const report = {
    workload,
    cycles,
    wallMs: performance.now() - started,
    tiers: {},
    functions: {},
    deopts: [],
  };
  for (const line of stdout.split('\n')) {
    const identity = /JSFunction (run|step\d+|resume\d+|stepShard\d+|resumeShard\d+) \(sfi/.exec(
      line,
    )?.[1];
    if (!identity) continue;
    const entry = (report.functions[identity] ??= { tiers: {}, deopts: [] });
    const add = (phase, tier) => {
      if (!tier) return;
      report.tiers[`${phase}:${tier}`] = (report.tiers[`${phase}:${tier}`] ?? 0) + 1;
      entry.tiers[`${phase}:${tier}`] = (entry.tiers[`${phase}:${tier}`] ?? 0) + 1;
    };
    const tier = /\(target (MAGLEV|TURBOFAN_JS)\)/.exec(line)?.[1];
    if (/\[marking /.test(line))
      add('marked', tier ?? /for optimization to (MAGLEV|TURBOFAN_JS)/.exec(line)?.[1]);
    if (/\[compiling method /.test(line)) add('compiling', tier);
    if (/\[completed compiling /.test(line)) add('completed', tier);
    const deopt = /reason: ([^)]+)\).*bytecode offset (\d+)/.exec(line);
    if (deopt) {
      const value = { function: identity, reason: deopt[1], bytecodeOffset: Number(deopt[2]) };
      report.deopts.push(value);
      entry.deopts.push(value);
    }
  }
  report.runObserved = Object.hasOwn(report.functions, 'run');
  report.directFunctions = Object.keys(report.functions).length;
  report.turboFanObserved = Object.values(report.functions).some((entry) =>
    Object.keys(entry.tiers).some((key) => key.endsWith(':TURBOFAN_JS')),
  );
  Object.assign(report, {
    sourceCharacters: input.profile.sourceCharacters,
    translatedInstructions: input.profile.translatedInstructions,
    directCoverage: input.profile.directCoverage,
    operations: input.profile.operations,
    localCount: input.profile.localCount,
    capturedLoads: input.profile.capturedLoads,
    booleanChecks: input.profile.booleanChecks,
    selectLabels: input.profile.selectLabels,
  });
  console.log(JSON.stringify(report, null, 2));
}
