import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const defaults = { sizes: [8, 32, 96], samples: 200, warmup: 40 };
const options = { ...defaults };
const seen = new Set();
for (const argument of process.argv.slice(2)) {
  if (argument === '--help') {
    console.log(
      'Usage: node packages\\simulator\\bench\\electrical.mjs ' +
        '[--sizes=8,32,96] [--samples=200] [--warmup=40]\n' +
        'Bounds: 1-4 distinct sizes in [2,128], samples [20,2000], warmup [1,1000], ' +
        'and a combined dense-work estimate <= 3e9. Output is JSON.',
    );
    process.exit(0);
  }
  const match = /^--(sizes|samples|warmup)=(\d+(?:,\d+)*)$/.exec(argument);
  assert.ok(match, `Unknown or malformed argument: ${argument}`);
  const [, name, value] = match;
  assert.ok(!seen.has(name), `Duplicate option: ${name}`);
  seen.add(name);
  if (name === 'sizes') options.sizes = value.split(',').map(Number);
  else {
    assert.ok(!value.includes(','), `${name} requires one integer`);
    options[name] = Number(value);
  }
}
assert.ok(options.sizes.length >= 1 && options.sizes.length <= 4, 'Use 1-4 sizes');
assert.equal(new Set(options.sizes).size, options.sizes.length, 'Sizes must be distinct');
assert.ok(options.sizes.every((size) => Number.isSafeInteger(size) && size >= 2 && size <= 128));
assert.ok(Number.isInteger(options.samples) && options.samples >= 20 && options.samples <= 2000);
assert.ok(Number.isInteger(options.warmup) && options.warmup >= 1 && options.warmup <= 1000);
// Includes fresh solves, a two-chain merged component, and split components.
const denseWorkEstimate =
  (options.samples + options.warmup) *
  options.sizes.reduce((total, size) => total + 10 * size ** 3, 0);
assert.ok(denseWorkEstimate <= 3e9, 'Combined workload exceeds the dense-work budget of 3e9');

const source = await readFile(new URL('../src/electrical.ts', import.meta.url), 'utf8');
const compilationStart = performance.now();
const compiled = ts.transpileModule(source, {
  fileName: 'electrical.ts',
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
const compilationMs = performance.now() - compilationStart;
const errors = compiled.diagnostics?.filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.equal(
  errors?.length ?? 0,
  0,
  ts.formatDiagnostics(errors ?? [], {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }),
);
const { createElectricalNetwork } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
);
const resistance = 1000;
const counterNames = ['solves', 'factorizations', 'factorizationReuses', 'cacheHits'];
const emptyCounters = () => Object.fromEntries(counterNames.map((name) => [name, 0]));

function pin(id, thresholds = false) {
  return {
    id,
    instance: 'benchmark',
    name: id,
    ...(thresholds ? { low: 0, high: 5 } : {}),
    intent: [],
    sample: { voltage: null, level: 'unknown', status: 'floating' },
  };
}

function chain(size, prefix, leftVoltage = -2, rightVoltage = 10) {
  const left = pin(`${prefix}.left`);
  const right = pin(`${prefix}.right`);
  const unknown = Array.from({ length: size }, (_, index) => pin(`${prefix}.${index}`, true));
  for (let index = 0; index < size - 1; index++) {
    unknown[index].intent = [{ to: unknown[index + 1], resistance }];
  }
  const result = {
    left,
    right,
    unknown,
    leftVoltage,
    rightVoltage,
    pins: [left, right, ...unknown],
    nets: [
      { id: left.id, pins: [left], voltage: leftVoltage },
      { id: right.id, pins: [right], voltage: rightVoltage },
    ],
    setBoundaryBranches(first = left, last = right, firstResistance = resistance) {
      unknown[0].intent = [
        { to: unknown[1], resistance },
        { to: first, resistance: firstResistance },
      ];
      unknown[size - 1].intent = [{ to: last, resistance }];
    },
  };
  result.setBoundaryBranches();
  return result;
}

function checkPin(endpoint, expected, fixed = false) {
  const { voltage, status, level } = endpoint.sample;
  assert.equal(status, 'valid', endpoint.id);
  assert.ok(Number.isFinite(voltage) && !Object.is(voltage, -0), endpoint.id);
  if (fixed) assert.equal(voltage, expected, endpoint.id);
  else {
    assert.ok(
      Math.abs(voltage - expected) <= 1e-10 * Math.max(1, Math.abs(expected)),
      `${endpoint.id}: expected ${expected}, got ${voltage}`,
    );
  }
  assert.equal(
    level,
    endpoint.low === undefined
      ? 'unknown'
      : voltage <= endpoint.low
        ? 'low'
        : voltage >= endpoint.high
          ? 'high'
          : 'unknown',
  );
  return voltage;
}

function checkChain(fixture, expectedVoltage) {
  let checksum = checkPin(fixture.left, fixture.leftVoltage, true);
  checksum += checkPin(fixture.right, fixture.rightVoltage, true);
  fixture.unknown.forEach((endpoint, index) => {
    checksum += checkPin(endpoint, expectedVoltage(index));
  });
  return checksum;
}

function singleChainWorkload(name, size) {
  let fixture = chain(size, name);
  const workload = {
    name,
    size,
    unknownNodes: size,
    pins: size + 2,
    network: createElectricalNetwork(fixture.pins, fixture.nets),
    phase: false,
    run(iteration) {
      this.phase = iteration % 2 === 0;
      if (name === 'rhs-reuse') {
        // Swap fixed-reference endpoints, preserving the unknown matrix and node set.
        fixture.setBoundaryBranches(
          this.phase ? fixture.right : fixture.left,
          this.phase ? fixture.left : fixture.right,
        );
      } else if (name === 'resistance-update') {
        fixture.setBoundaryBranches(
          fixture.left,
          fixture.right,
          this.phase ? 2 * resistance : resistance,
        );
      } else if (name === 'reference-rebuild') {
        // Ideal reference potentials are immutable for a network's lifetime.
        fixture = chain(size, name, this.phase ? -4 : -2, this.phase ? 8 : 10);
        this.network = createElectricalNetwork(fixture.pins, fixture.nets);
      }
      this.changed = this.network.solve();
    },
    verify() {
      const reversed = name === 'rhs-reuse' && this.phase;
      const left = reversed ? fixture.rightVoltage : fixture.leftVoltage;
      const right = reversed ? fixture.leftVoltage : fixture.rightVoltage;
      const firstResistance =
        name === 'resistance-update' && this.phase ? 2 * resistance : resistance;
      const totalResistance = firstResistance + size * resistance;
      // A series string has constant current; this does not use nodal elimination.
      const checksum = checkChain(
        fixture,
        (index) =>
          left + ((right - left) * (firstResistance + index * resistance)) / totalResistance,
      );
      if (name === 'static-reuse') assert.equal(this.changed.length, 0);
      else assert.ok(this.changed.length > 0);
      return checksum;
    },
    expectedCounters() {
      return {
        solves: 1,
        factorizations: name === 'resistance-update' || name === 'reference-rebuild' ? 1 : 0,
        factorizationReuses: name === 'rhs-reuse' ? 1 : 0,
        cacheHits: name === 'static-reuse' ? 1 : 0,
      };
    },
  };
  workload.network.solve();
  return workload;
}

function mergeSplitWorkload(size) {
  const first = chain(size, 'first', -2, 10);
  const second = chain(size, 'second', 14, 26);
  const baseIntent = first.unknown[0].intent;
  const workload = {
    name: 'merge-split',
    size,
    unknownNodes: 2 * size,
    pins: 2 * size + 4,
    network: createElectricalNetwork(
      [...first.pins, ...second.pins],
      [...first.nets, ...second.nets],
    ),
    merged: false,
    run(iteration) {
      this.merged = iteration % 2 === 0;
      first.unknown[0].intent = this.merged
        ? [...baseIntent, { to: second.unknown[0], resistance }]
        : baseIntent;
      this.changed = this.network.solve();
    },
    verify() {
      const openFirst = first.leftVoltage + (first.rightVoltage - first.leftVoltage) / (size + 1);
      const openSecond =
        second.leftVoltage + (second.rightVoltage - second.leftVoltage) / (size + 1);
      // Two independent Thevenin equivalents joined by the switched bridge.
      const theveninResistance = (resistance * size) / (size + 1);
      const bridgeCurrent = this.merged
        ? (openFirst - openSecond) / (2 * theveninResistance + resistance)
        : 0;
      const firstTap = openFirst - bridgeCurrent * theveninResistance;
      const secondTap = openSecond + bridgeCurrent * theveninResistance;
      assert.equal(this.network.stats.components, this.merged ? 1 : 2);
      assert.ok(this.changed.length > 0);
      return (
        checkChain(first, (index) => firstTap + ((first.rightVoltage - firstTap) * index) / size) +
        checkChain(
          second,
          (index) => secondTap + ((second.rightVoltage - secondTap) * index) / size,
        )
      );
    },
    expectedCounters() {
      return {
        solves: 1,
        factorizations: this.merged ? 1 : 2,
        factorizationReuses: 0,
        cacheHits: 0,
      };
    },
  };
  workload.network.solve();
  return workload;
}

function measure(workload) {
  for (let iteration = 0; iteration < options.warmup; iteration++) {
    workload.run(iteration);
    workload.verify();
  }
  const durations = [];
  const totals = emptyCounters();
  let checksum = 0;
  for (let sample = 0; sample < options.samples; sample++) {
    const previousNetwork = workload.network;
    const previous = previousNetwork.stats;
    const start = performance.now();
    workload.run(options.warmup + sample);
    durations.push((performance.now() - start) * 1000);
    checksum += workload.verify();
    const after = workload.network.stats;
    const expected = workload.expectedCounters();
    for (const name of counterNames) {
      const delta = after[name] - (workload.network === previousNetwork ? previous[name] : 0);
      assert.equal(delta, expected[name], `${workload.name}: ${name}`);
      totals[name] += delta;
    }
  }
  durations.sort((first, second) => first - second);
  const percentile = (fraction) =>
    Number(durations[Math.ceil(fraction * durations.length) - 1].toFixed(3));
  return {
    workload: workload.name,
    chain_size: workload.size,
    unknown_nodes: workload.unknownNodes,
    pins: workload.pins,
    median_us: percentile(0.5),
    p95_us: percentile(0.95),
    p99_us: percentile(0.99),
    measured_counters: totals,
    final_components: workload.network.stats.components,
    final_floating_components: workload.network.stats.floatingComponents,
    checksum,
  };
}

const started = performance.now();
const results = [];
for (const size of options.sizes) {
  for (const name of ['static-reuse', 'rhs-reuse', 'resistance-update', 'reference-rebuild']) {
    results.push(measure(singleChainWorkload(name, size)));
  }
  results.push(measure(mergeSplitWorkload(size)));
}
console.log(
  JSON.stringify(
    {
      benchmark: 'standalone-electrical',
      node: process.version,
      typescript: ts.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      build: {
        source: 'packages/simulator/src/electrical.ts',
        source_sha256: createHash('sha256').update(source).digest('hex'),
        output_sha256: createHash('sha256').update(compiled.outputText).digest('hex'),
        target: 'ES2022',
        module: 'ES2022',
        transpile_ms: Number(compilationMs.toFixed(3)),
        loading:
          'typescript.transpileModule then in-memory data URL; no emitted files or source dependencies',
      },
      profiling: {
        execArgv: process.execArgv,
        node_options_present: Boolean(process.env.NODE_OPTIONS),
        forced_gc: false,
      },
      workload: {
        ...options,
        resistance_ohms: resistance,
        dense_work_estimate: denseWorkEstimate,
        random: false,
      },
      measurement: {
        unit: 'microseconds per operation',
        percentile: 'nearest rank',
        includes:
          'intent changes and solve; reference-rebuild also includes pin/network construction; normal JIT and GC effects',
        excludes:
          'startup transpilation/import, initial solve, warmup, verification, counter snapshots',
        counters:
          'measured operations only; exact per-operation cache/factorization deltas are asserted',
        caveat:
          'dense solver: O(U^2) storage, O(U^3) worst-case factorization; series-chain timings are not a dense-graph scaling claim',
      },
      elapsed_ms: Number((performance.now() - started).toFixed(3)),
      results,
    },
    null,
    2,
  ),
);
