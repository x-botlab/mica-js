/**
 * Batch-execution acceptance benchmark for the published simulator dist.
 *
 * Defaults match the acceptance proposal: a 65,536-byte fill with one 10 ps tick per
 * round, 5 warmups and 25 alternating paired samples, comparing the board with the
 * feature disabled, enabled with process registration, and enabled without a
 * registration. Correctness (all bytes, cursor and done timestamp) is checked for every
 * run before its timing is recorded. Only `runUntil` is timed; run probes are installed
 * only for the separate untimed evidence run.
 *
 * Run from the repository root:
 *   node packages/simulator/bench/batch-execution.mjs
 *   node packages/simulator/bench/batch-execution.mjs --baseline-sdk=/tmp/.../dist/index.js
 *   node packages/simulator/bench/batch-execution.mjs --require-batch --require-targets
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acceptanceSummary,
  candidateVariants,
  fillDeviceSource,
  normalizeConfig,
  probeBatchSupport,
  runSeries,
} from './batch-execution-fixture.mjs';

export const BASELINE_SHA = '8a36ed4';
export const defaultSdkPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const defaults = {
  samples: 25,
  warmup: 5,
  iterations: 65_536,
  tickPs: 10,
  execution: 'throughput',
  sdk: defaultSdkPath,
  baselineSdk: undefined,
  baselineSha: BASELINE_SHA,
  requireBatch: false,
  requireTargets: false,
  smoke: false,
};

const usage =
  'Usage: node packages/simulator/bench/batch-execution.mjs ' +
  '[--samples=25] [--warmup=5] [--iterations=65536] [--tick-ps=10] ' +
  '[--sdk=packages/simulator/dist/index.js] [--baseline-sdk=<dist/index.js>] ' +
  '[--baseline-sha=8a36ed4] [--execution=throughput|precise] [--require-batch] ' +
  '[--require-targets] [--smoke]\n' +
  'Defaults: 65,536 store8 rounds at 10 ps, 5 warmups, 25 alternating paired samples. ' +
  'Samples [1,200], warmup [0,50], iterations [2,1000000]. JSON stdout; only runUntil ' +
  'is timed and timed runs install no probes.';

export function parseArgs(args) {
  const options = { ...defaults };
  const seen = new Set();
  for (const argument of args) {
    if (argument === '--help') return null;
    if (
      argument === '--require-batch' ||
      argument === '--require-targets' ||
      argument === '--smoke'
    ) {
      const name = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (seen.has(name)) throw new Error(`Duplicate option: ${argument}`);
      seen.add(name);
      options[name] = true;
      continue;
    }
    const match =
      /^--(samples|warmup|iterations|tick-ps|execution|sdk|baseline-sdk|baseline-sha)=(.+)$/.exec(
        argument,
      );
    if (!match) throw new Error(`Unknown or malformed argument: ${argument}`);
    const [, rawName, value] = match;
    const name =
      rawName === 'tick-ps'
        ? 'tickPs'
        : rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (seen.has(name)) throw new Error(`Duplicate option: --${rawName}`);
    seen.add(name);
    if (
      name === 'sdk' ||
      name === 'baselineSdk' ||
      name === 'baselineSha' ||
      name === 'execution'
    ) {
      if (value.length === 0) throw new Error(`Option --${rawName} requires a value`);
      options[name] = value;
      continue;
    }
    if (!/^\d+$/.test(value))
      throw new Error(`Option --${rawName} requires a non-negative integer`);
    options[name] = Number(value);
  }
  if (options.smoke) {
    if (!seen.has('iterations')) options.iterations = 256;
    if (!seen.has('samples')) options.samples = 3;
    if (!seen.has('warmup')) options.warmup = 1;
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1 || options.samples > 200)
    throw new RangeError('samples must be in [1,200]');
  if (!Number.isSafeInteger(options.warmup) || options.warmup < 0 || options.warmup > 50)
    throw new RangeError('warmup must be in [0,50]');
  if (
    !Number.isSafeInteger(options.iterations) ||
    options.iterations < 2 ||
    options.iterations > 1_000_000
  )
    throw new RangeError('iterations must be in [2,1000000]');
  if (!Number.isSafeInteger(options.tickPs) || options.tickPs < 1 || options.tickPs > 1_000_000_000)
    throw new RangeError('tick-ps must be in [1,1000000000]');
  if (options.execution !== 'throughput' && options.execution !== 'precise')
    throw new RangeError('execution must be throughput or precise');
  if (options.baselineSha === '') throw new RangeError('baseline-sha must not be empty');
  options.sdk = resolve(options.sdk);
  if (options.baselineSdk !== undefined) options.baselineSdk = resolve(options.baselineSdk);
  return options;
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function importSdk(path) {
  return import(pathToFileURL(path).href);
}

function environment(options, sdkInfo, baselineSdkInfo) {
  const processors = cpus();
  return Object.freeze({
    collectedAt: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    arch: arch(),
    release: release(),
    cpuModel: processors[0]?.model ?? 'unknown',
    cpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    command: Object.freeze([...process.argv]),
    cwd: process.cwd(),
    baselineSha: options.baselineSha,
    execution: options.execution,
    warmup: options.warmup,
    samples: options.samples,
    sdk: sdkInfo,
    baselineSdk: baselineSdkInfo,
    probePolicy:
      'Correctness, real EventQueue push/pop counts and prepareBatch admissions use one ' +
      'untimed run per variant; new-board create-to-complete and warmed timings run without ' +
      'probes; the cold label does not represent process startup.',
  });
}

function variantPublicOptions(options) {
  return Object.freeze({ ...options });
}

/**
 * Execute the benchmark and return a JSON-safe report. The CLI prints this object;
 * tests import the function and run a small smoke configuration.
 */
export async function runBenchmark(options) {
  const config = normalizeConfig(options);
  const { compileDDL } = await import('@mica-js/ddl');
  const model = await compileDDL(fillDeviceSource(config));
  const sdk = await importSdk(options.sdk);
  const sdkInfo = Object.freeze({ path: options.sdk, sha256: await sha256(options.sdk) });
  const support = probeBatchSupport(sdk, model, config, options.execution);
  if (options.requireBatch) {
    if (!support.option)
      throw new Error(
        'batchExecution option is not supported by the selected SDK; choose a build with ' +
          'the batch-execution implementation or omit --require-batch',
      );
    if (!support.registration)
      throw new Error(
        'batchExecution is accepted but context.registerProcessBatch is unavailable; ' +
          'the process acceptance fixture cannot exercise an active registration',
      );
  }

  const variants = candidateVariants(sdk, support);
  let baselineSdkInfo = null;
  if (options.baselineSdk !== undefined) {
    const baselineSdk = await importSdk(options.baselineSdk);
    baselineSdkInfo = Object.freeze({
      path: options.baselineSdk,
      sha256: await sha256(options.baselineSdk),
    });
    variants.push({
      name: 'baseline-disabled',
      sdk: baselineSdk,
      register: false,
    });
  }

  const series = runSeries({
    model,
    variants,
    configInput: config,
    warmup: options.warmup,
    samples: options.samples,
    now: () => performance.now(),
  });
  const acceptance = support.option
    ? acceptanceSummary(series, { baseline: baselineSdkInfo !== null })
    : null;
  for (const variant of Object.values(series.variants))
    variant.options = variantPublicOptions(variant.options);

  const failures = [];
  if (options.requireTargets) {
    if (acceptance === null) failures.push('--require-targets needs a supported batch SDK');
    else if (acceptance.passed !== true)
      failures.push('acceptance thresholds were not met; inspect acceptance.checks');
  }
  return Object.freeze({
    kind: 'batch-execution-benchmark',
    environment: environment(options, sdkInfo, baselineSdkInfo),
    fixture: Object.freeze({
      source: fillDeviceSource(config),
      ...config,
    }),
    support,
    variants: series.variants,
    samples: series.samples,
    acceptance,
    failures: Object.freeze(failures),
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options === null) {
      console.log(usage);
    } else {
      const result = await runBenchmark(options);
      console.log(JSON.stringify(result, null, 2));
      if (result.failures.length) {
        console.error(result.failures.join('\n'));
        process.exitCode = 1;
      }
    }
  } catch (cause) {
    console.error(cause?.stack ?? String(cause));
    process.exitCode = 1;
  }
}
