import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector';
import { join, resolve } from 'node:path';
import { arch, cpus, platform, release } from 'node:os';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { compileDDL } from '@mica-js/ddl';
import { createBoard, createDeviceLibrary } from '../dist/index.js';
import { digitalNames, prepareDigital } from './workloads/digital.mjs';
import { physicalNames, preparePhysical } from './workloads/physical.mjs';

const names = [...digitalNames, ...physicalNames];
const options = {
  workloads: names,
  sizes: [1, 4, 16],
  samples: 100,
  warmup: 5,
  allocations: false,
  cpuProfileDir: null,
};
const seen = new Set();
for (const argument of process.argv.slice(2)) {
  if (argument === '--help') {
    console.log(
      'Usage: pnpm --filter @mica-js/simulator bench:workloads ' +
        '[--workloads=' +
        names.join(',') +
        '] [--sizes=1,4,16] [--samples=100] [--warmup=5] [--allocations] [--cpu-profile-dir=PATH]\n' +
        'Bounds: 1-3 distinct sizes in [1,16], samples [20,200], warmup [1,20]. ' +
        'JSON on stdout, progress on stderr. Allocation sampling is optional and perturbs timing.',
    );
    process.exit(0);
  }
  if (argument.startsWith('--cpu-profile-dir=')) {
    const directory = argument.slice('--cpu-profile-dir='.length);
    assert(
      directory.length && !seen.has('cpuProfileDir'),
      'Empty or duplicate CPU profile directory',
    );
    seen.add('cpuProfileDir');
    options.cpuProfileDir = resolve(directory);
    continue;
  }
  if (argument === '--allocations') {
    assert(!seen.has('allocations'), 'Duplicate allocations option');
    seen.add('allocations');
    options.allocations = true;
    continue;
  }
  const match = /^--(workloads|sizes|samples|warmup)=(.+)$/.exec(argument);
  assert(match, `Unknown or malformed argument: ${argument}`);
  const [, name, value] = match;
  assert(!seen.has(name), `Duplicate option: ${name}`);
  seen.add(name);
  if (name === 'workloads') options.workloads = value.split(',');
  else {
    assert(/^\d+(?:,\d+)*$/.test(value), `Invalid integer option: ${argument}`);
    if (name === 'sizes') options.sizes = value.split(',').map(Number);
    else {
      assert(!value.includes(','));
      options[name] = Number(value);
    }
  }
}
assert(
  options.workloads.length && options.workloads.every((name) => names.includes(name)),
  'Unknown workload',
);
assert.equal(
  new Set(options.workloads).size,
  options.workloads.length,
  'Workloads must be distinct',
);
assert(options.sizes.length >= 1 && options.sizes.length <= 3, 'Use 1-3 sizes');
assert.equal(new Set(options.sizes).size, options.sizes.length, 'Sizes must be distinct');
assert(options.sizes.every((size) => Number.isSafeInteger(size) && size >= 1 && size <= 16));
assert(Number.isSafeInteger(options.samples) && options.samples >= 20 && options.samples <= 200);
assert(Number.isSafeInteger(options.warmup) && options.warmup >= 1 && options.warmup <= 20);
const denseEstimate = options.workloads.includes('electrical-chain')
  ? options.sizes.reduce((total, size) => total + (size * 8) ** 3, 0) *
    (options.samples + options.warmup)
  : 0;
assert(denseEstimate <= 8e8, 'Combined dense workload exceeds budget 8e8');

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}

function gcSummary(entries, windows) {
  let count = 0;
  let durationMs = 0;
  for (const entry of entries) {
    let included = false;
    for (const [start, end] of windows) {
      const overlap = Math.max(
        0,
        Math.min(end, entry.startTime + entry.duration) - Math.max(start, entry.startTime),
      );
      if (overlap > 0) {
        durationMs += overlap;
        included = true;
      }
    }
    if (included) count++;
  }
  return { count, durationMs };
}

function inspectorConnection() {
  const session = new Session();
  session.connect();
  const post = (method, parameters = {}) =>
    new Promise((resolve, reject) =>
      session.post(method, parameters, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
  return { session, post };
}

async function cpuSampler(name, size) {
  if (!options.cpuProfileDir) return null;
  const { session, post } = inspectorConnection();
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
  } catch (error) {
    session.disconnect();
    throw error;
  }
  return async () => {
    try {
      const { profile } = await post('Profiler.stop');
      await mkdir(options.cpuProfileDir, { recursive: true });
      const path = join(options.cpuProfileDir, `${name}-${size}-${Date.now()}.cpuprofile`);
      await writeFile(path, JSON.stringify(profile), { flag: 'wx' });
      return { path, samplingIntervalMicroseconds: 1000 };
    } finally {
      session.disconnect();
    }
  };
}

async function allocationSampler() {
  if (!options.allocations) return null;
  const { session, post } = inspectorConnection();
  try {
    await post('HeapProfiler.startSampling', {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } catch (error) {
    session.disconnect();
    throw error;
  }
  return async () => {
    try {
      const { profile } = await post('HeapProfiler.stopSampling');
      let estimatedBytes = 0;
      const sites = [];
      const visit = (node) => {
        estimatedBytes += node.selfSize;
        if (node.selfSize)
          sites.push({
            function: node.callFrame.functionName || '(anonymous)',
            url: node.callFrame.url,
            line: node.callFrame.lineNumber + 1,
            estimatedBytes: node.selfSize,
          });
        for (const child of node.children) visit(child);
      };
      visit(profile.head);
      sites.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
      return {
        samplingIntervalBytes: 32768,
        sampledAllocationBytesEstimate: estimatedBytes,
        includesCollectedObjects: true,
        topSites: sites.slice(0, 10),
      };
    } finally {
      session.disconnect();
    }
  };
}

const gcEntries = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    gcEntries.push({ startTime: entry.startTime, duration: entry.duration });
});
observer.observe({ entryTypes: ['gc'] });
const results = [];
let compilationSequence = 0;
try {
  for (const name of options.workloads) {
    for (const size of options.sizes) {
      console.error(`[workloads] ${name}, size=${size}`);
      const preparation = { ddlCalls: 0, frontendMs: 0, libraryMs: 0 };
      const preparationStart = performance.now();
      const prepare = digitalNames.includes(name) ? prepareDigital : preparePhysical;
      const prepared = await prepare(name, {
        size,
        async compile(source) {
          const start = performance.now();
          try {
            return await compileDDL(source, {
              uri: `memory:///bench/${compilationSequence++}.ddl`,
            });
          } finally {
            preparation.ddlCalls++;
            preparation.frontendMs += performance.now() - start;
          }
        },
        createDeviceLibrary(entries) {
          const start = performance.now();
          try {
            return createDeviceLibrary(entries);
          } finally {
            preparation.libraryMs += performance.now() - start;
          }
        },
        createBoard,
      });
      preparation.totalMs = performance.now() - preparationStart;
      preparation.otherMs = preparation.totalMs - preparation.frontendMs - preparation.libraryMs;
      const assemblyStart = performance.now();
      const session = prepared.create();
      const assemblyMs = performance.now() - assemblyStart;
      let stopSampling = null;
      let stopCpu = null;
      try {
        assert(Number.isSafeInteger(session.operationsPerStep) && session.operationsPerStep > 0);
        const firstAdvanceStart = performance.now();
        session.initialize();
        const firstAdvanceMs = performance.now() - firstAdvanceStart;
        for (let i = 0; i < options.warmup; i++) {
          session.step(i);
          session.verify(i + 1);
        }
        await yieldTurn();
        await yieldTurn();
        gcEntries.length = 0;
        stopSampling = await allocationSampler();
        stopCpu = await cpuSampler(name, size);
        const windows = [];
        const latencies = [];
        const heapBefore = process.memoryUsage();
        let maximumObservedHeapUsed = heapBefore.heapUsed;
        const runStart = performance.now();
        for (let i = 0; i < options.samples; i++) {
          const start = performance.now();
          session.step(options.warmup + i);
          const end = performance.now();
          windows.push([start, end]);
          latencies.push(end - start);
          maximumObservedHeapUsed = Math.max(
            maximumObservedHeapUsed,
            process.memoryUsage().heapUsed,
          );
          session.verify(options.warmup + i + 1);
          await yieldTurn();
        }
        const runEnd = performance.now();
        const heapAfter = process.memoryUsage();
        await yieldTurn();
        await yieldTurn();
        const finishCpu = stopCpu;
        stopCpu = null;
        const cpuProfile = finishCpu ? await finishCpu() : null;
        const finishSampling = stopSampling;
        stopSampling = null;
        const allocations = finishSampling ? await finishSampling() : null;
        const operationCount = options.samples * session.operationsPerStep;
        const totalStepMs = latencies.reduce((a, b) => a + b, 0);
        const result = {
          workload: name,
          size,
          description: prepared.description,
          unit: prepared.unit,
          operationsPerStep: session.operationsPerStep,
          measuredOperations: operationCount,
          preparation,
          assemblyMs,
          firstAdvanceMs,
          steady: {
            stepMs: summary(latencies),
            totalStepMs,
            runWallMs: runEnd - runStart,
            operationsPerSecond: (operationCount * 1000) / totalStepMs,
            operationsPerWallSecond: (operationCount * 1000) / (runEnd - runStart),
          },
          memory: {
            heapUsedBeforeBytes: heapBefore.heapUsed,
            heapUsedAfterBytes: heapAfter.heapUsed,
            netHeapDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
            maximumObservedHeapUsedBytes: Math.max(maximumObservedHeapUsed, heapAfter.heapUsed),
            externalDeltaBytes: heapAfter.external - heapBefore.external,
            arrayBuffersDeltaBytes: heapAfter.arrayBuffers - heapBefore.arrayBuffers,
          },
          gc: {
            duringSteps: gcSummary(gcEntries, windows),
            duringMeasuredRun: gcSummary(gcEntries, [[runStart, runEnd]]),
          },
          allocations,
          cpuProfile,
        };
        results.push(result);
      } finally {
        try {
          if (stopCpu) await stopCpu();
        } finally {
          try {
            if (stopSampling) await stopSampling();
          } finally {
            session.dispose();
          }
        }
      }
    }
  }
} finally {
  observer.disconnect();
}
console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        v8: process.versions.v8,
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        revision: execFileSync('git', ['--no-pager', 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        worktreeDirty: Boolean(
          execFileSync('git', ['--no-pager', 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
        ),
      },
      options,
      notes: [
        'One preparation/assembly/first-advance observation per case, not startup percentiles. Each case owns a fresh board.',
        'Frontend timing uses unique source URIs to avoid the DDL result cache; parser and V8 remain warm across cases. Builder/transpilation work is in other preparation or module startup.',
        'Lazy JavaScript compilation and initial solve are included in first advance or warmup, not reported as isolated backend compilation.',
        'Step latency includes driver inputs, SDK advancement and adapter collection; verify assertions, memory sampling and event-loop yields are outside step timing.',
        'Wall throughput includes verification, memory sampling and event-loop yields. Warmups are excluded from all measured operation counts.',
        'Net heap change is not allocation or retained size. Observed heap maximum is not a peak. GC is reported both inside steps and across their full run.',
        `P99 uses nearest-rank over ${options.samples} samples; empirical tail resolution is ${100 / options.samples} percent.`,
        'Optional allocation sampling estimates allocations including collected objects; it also samples benchmark/verification scaffolding and perturbs latency. Compare timing only in the same mode.',
        'Optional CPU profiles cover only the post-warmup measurement region, including verification and event-loop gaps; startup and warmups are excluded. Profiling perturbs timing.',
        'Sizes mean UART pairs, processors, SRAMs or PWMs; electrical workloads use size*8 unknown nodes. These fixtures are representative models, not complete chips.',
      ],
      results,
    },
    null,
    2,
  ),
);
