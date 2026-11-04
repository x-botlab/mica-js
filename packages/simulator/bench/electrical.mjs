import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const defaults = { sizes: [8, 32, 96], samples: 200, warmup: 40 };
const options = { ...defaults };
let verifyOnly = false;
const seen = new Set();
for (const argument of process.argv.slice(2)) {
  if (argument === '--help') {
    console.log(
      'Usage: node packages\\simulator\\bench\\electrical.mjs ' +
        '[--sizes=8,32,96] [--samples=200] [--warmup=40] [--verify-only]\n' +
        'Bounds: 1-4 distinct sizes in [2,128], samples [20,2000], warmup [1,1000], ' +
        'and a combined dense-work estimate <= 3e9. Output is JSON.',
    );
    process.exit(0);
  }
  if (argument === '--verify-only') {
    assert.ok(!verifyOnly, 'Duplicate option: verify-only');
    verifyOnly = true;
    continue;
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
// Includes fresh solves, merged/split chains and isolated blocks sharing rails.
const denseWorkEstimate =
  (options.samples + options.warmup) *
  options.sizes.reduce((total, size) => total + 12 * size ** 3, 0);
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
      this.changed = this.network.solve(name === 'static-dirty-hint' ? [] : undefined);
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
      if (name === 'static-reuse' || name === 'static-dirty-hint')
        assert.equal(this.changed.length, 0);
      else assert.ok(this.changed.length > 0);
      return checksum;
    },
    expectedCounters() {
      return {
        solves: 1,
        factorizations: name === 'resistance-update' || name === 'reference-rebuild' ? 1 : 0,
        factorizationReuses: name === 'rhs-reuse' ? 1 : 0,
        cacheHits: name === 'static-reuse' || name === 'static-dirty-hint' ? 1 : 0,
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

function sharedRailsWorkload(size) {
  const first = chain(size, 'shared-first', -2, 10);
  const second = chain(size, 'shared-second', -2, 10);
  const network = createElectricalNetwork(
    [...first.pins, ...second.pins],
    [
      { id: 'left', pins: [first.left, second.left], voltage: -2 },
      { id: 'right', pins: [first.right, second.right], voltage: 10 },
    ],
  );
  network.solve();
  assert.equal(network.stats.factorizations, 2, 'shared rails must not couple unknown blocks');
  return {
    name: 'shared-rails-isolation',
    size,
    unknownNodes: size * 2,
    pins: size * 2 + 4,
    network,
    doubled: false,
    run(iteration) {
      this.doubled = iteration % 2 === 0;
      first.setBoundaryBranches(
        first.left,
        first.right,
        this.doubled ? resistance * 2 : resistance,
      );
      this.changed = network.solve();
    },
    verify() {
      const leading = this.doubled ? 2 : 1;
      assert.equal(network.stats.components, 1, 'physical connectivity stays unchanged');
      assert(this.changed.every((pin) => first.unknown.includes(pin)));
      return (
        checkChain(first, (index) => -2 + (12 * (leading + index)) / (size + leading)) +
        checkChain(second, (index) => -2 + (12 * (index + 1)) / (size + 1))
      );
    },
    expectedCounters() {
      return { solves: 1, factorizations: 1, factorizationReuses: 0, cacheHits: 1 };
    },
  };
}

function digitalReferenceWorkload(size) {
  const high = pin('digital-high');
  const low = pin('digital-low');
  const outputs = Array.from({ length: size }, (_, index) => pin(`digital-output.${index}`, true));
  for (const output of outputs) output.intent = [{ to: low, resistance }];
  const touched = new Set(outputs);
  const network = createElectricalNetwork(
    [high, low, ...outputs],
    [
      { id: 'high', pins: [high], voltage: 5 },
      { id: 'low', pins: [low], voltage: 0 },
    ],
  );
  network.solve(touched);
  const references = [high.sample, low.sample];
  return {
    name: 'digital-reference-switch',
    size,
    unknownNodes: size,
    pins: size + 2,
    network,
    run(iteration) {
      this.high = iteration % 2 === 0;
      for (const output of outputs) output.intent = [{ to: this.high ? high : low, resistance }];
      this.changed = network.solve(touched);
    },
    verify() {
      assert.deepEqual(this.changed, outputs);
      assert.equal(network.stats.components, 2);
      assert.equal(network.stats.floatingComponents, 0);
      assert.equal(high.sample, references[0]);
      assert.equal(low.sample, references[1]);
      return outputs.reduce(
        (total, output) => total + checkPin(output, this.high ? 5 : 0, true),
        0,
      );
    },
    expectedCounters() {
      return { solves: 1, factorizations: 0, factorizationReuses: 0, cacheHits: 0 };
    },
  };
}

async function verifyCacheTransitions() {
  // Separate, untimed module probes private preparation calls without changing public counters.
  let instrumented = compiled.outputText;
  for (const [name, counter] of [
    ['prepareTopology', 'topology'],
    ['prepareBlock', 'adjacency'],
    ['solveBlocks', 'partitions'],
    ['restoreTopology', 'restores'],
  ]) {
    const signature = new RegExp(`function ${name}\\([^)]*\\) \\{`, 'g');
    assert.equal([...instrumented.matchAll(signature)].length, 1, `Probe ${name}`);
    instrumented = instrumented.replace(signature, `$& probes.${counter}++;`);
  }
  for (const [before, after] of [
    [
      /const transitions = new Map\(\);/g,
      'const transitions = new Map(); probes.caches.push({ transitions, ages: transitionAges, current: () => snapshot });',
    ],
    [
      /if \(edges === undefined\)\s+return block;/g,
      'if (edges === undefined) return block; probes.reboundBlocks++;',
    ],
    [
      /return blocks === undefined \? topology : \{ \.\.\.topology, blocks \};/g,
      'if (blocks === undefined) probes.zeroCopyRestores++; return blocks === undefined ? topology : { ...topology, blocks };',
    ],
  ]) {
    assert.equal([...instrumented.matchAll(before)].length, 1, `Ownership probe: ${before}`);
    instrumented = instrumented.replace(before, after);
  }
  assert.equal(instrumented.split('return solution;').length, 2);
  instrumented = instrumented.replace(
    'return solution;',
    'if (probes.badSolution) solution[0] += 1e-8; return solution;',
  );
  const factorSignature = /function factorize\([^)]*\) \{/g;
  assert.equal([...instrumented.matchAll(factorSignature)].length, 1);
  instrumented = instrumented.replace(
    factorSignature,
    "$& if (matrix.length === 0) probes.diagonal++; if (probes.failAfter !== null && probes.failAfter-- === 0) fail('Injected LDL failure.');",
  );
  const { createElectricalNetwork: createNetwork, probes } = await import(
    `data:text/javascript;base64,${Buffer.from(
      'export const probes = { topology: 0, adjacency: 0, partitions: 0, restores: 0, diagonal: 0, failAfter: null, badSolution: false, caches: [], reboundBlocks: 0, zeroCopyRestores: 0 };\n' +
        instrumented,
    ).toString('base64')}`
  );
  const ownership = (handle) => {
    assert.ok(handle.transitions.size <= 8, 'transition entry bound');
    assert.equal(handle.ages.size, handle.transitions.size, 'recency metadata is evicted together');
    for (const [key, age] of handle.ages) {
      assert.ok(handle.transitions.has(key));
      assert.equal(typeof age, 'number');
    }
    const roots = [...handle.transitions.values(), handle.current()].filter(Boolean);
    const seen = new Set();
    let snapshots = 0;
    let topologies = 0;
    let numericArrays = 0;
    const visit = (value) => {
      assert.notEqual(typeof value, 'function', 'topology ownership must not capture closures');
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (value instanceof Float64Array) {
        numericArrays++;
        return;
      }
      if (value instanceof Map) {
        for (const [key, item] of value) {
          visit(key);
          visit(item);
        }
        return;
      }
      if (value instanceof Set) {
        for (const item of value) visit(item);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if ('topology' in value) {
        snapshots++;
        assert.deepEqual(Object.keys(value).sort(), ['cost', 'id', 'topology']);
      }
      if ('blocks' in value && 'edgeBlocks' in value) topologies++;
      if (value.physical !== undefined)
        assert.equal(value.physical.physical, undefined, 'physical ownership depth');
      for (const item of Object.values(value)) visit(item);
    };
    for (const root of roots) visit(root);
    assert.ok(snapshots <= 9, 'eight transitions plus current snapshot');
    assert.ok(topologies <= snapshots, 'no hidden historical topology chain');
    assert.equal(numericArrays, 0, 'topology snapshots retain no numerical factorization caches');
    for (const [descriptor, target] of handle.transitions) {
      assert.equal(typeof descriptor, 'string');
      if (target !== undefined) assert.ok(target.cost <= 65_536);
    }
    return { snapshots, topologies };
  };
  const builds = (operation, topology, adjacency) => {
    const before = { ...probes };
    const result = operation();
    assert.equal(probes.topology - before.topology, topology, 'physical topology builds');
    assert.equal(probes.adjacency - before.adjacency, adjacency, 'block adjacency builds');
    if (topology === 0) assert.equal(probes.partitions, before.partitions, 'cached solve blocks');
    return result;
  };
  const first = chain(4, 'cache-first');
  const second = chain(4, 'cache-second');
  const allPins = [...first.pins, ...second.pins];
  const accesses = new Map();
  let branchReads = 0;
  for (const endpoint of allPins) {
    const reads = { intent: 0, sample: 0, writes: 0 };
    accesses.set(endpoint, reads);
    let currentIntent = Object.freeze(
      endpoint.intent.map((branch) =>
        Object.freeze({
          get to() {
            branchReads++;
            return branch.to;
          },
          get resistance() {
            branchReads++;
            return branch.resistance;
          },
        }),
      ),
    );
    let currentSample = endpoint.sample;
    Object.defineProperties(endpoint, {
      intent: {
        get() {
          reads.intent++;
          return currentIntent;
        },
        set(value) {
          currentIntent = value;
        },
      },
      sample: {
        get() {
          reads.sample++;
          return currentSample;
        },
        set(value) {
          reads.writes++;
          currentSample = value;
        },
      },
    });
  }
  const resetReads = () => {
    branchReads = 0;
    for (const reads of accesses.values())
      Object.assign(reads, { intent: 0, sample: 0, writes: 0 });
  };
  const network = createNetwork(allPins, [
    { id: 'left', pins: [first.left, second.left], voltage: -2 },
    { id: 'right', pins: [first.right, second.right], voltage: 10 },
  ]);
  builds(() => network.solve([]), 1, 2);
  assert.equal(network.stats.factorizations, 2);
  const baselineSamples = allPins.map((endpoint) => endpoint.sample);
  assert.ok(baselineSamples.every(Object.isFrozen));
  resetReads();
  builds(() => assert.equal(network.solve().length, 0), 0, 0);
  assert.equal(branchReads, 0, 'stable intents must not read branches');
  for (const reads of accesses.values())
    assert.deepEqual(reads, { intent: 1, sample: 0, writes: 0 });
  resetReads();
  builds(() => assert.equal(network.solve([]).length, 0), 0, 0);
  for (const reads of accesses.values())
    assert.deepEqual(reads, { intent: 0, sample: 0, writes: 0 });
  assert.equal(branchReads, 0);
  builds(() => assert.equal(network.solve(new Set()).length, 0), 0, 0);
  for (const reads of accesses.values())
    assert.deepEqual(reads, { intent: 0, sample: 0, writes: 0 });
  const original = first.unknown[0].intent;
  const leading = (fixture, value) => {
    fixture.unknown[0].intent = [
      { to: fixture.unknown[1], resistance },
      { to: fixture.left, resistance: resistance * value },
    ];
  };
  leading(first, 2);
  resetReads();
  const beforeResistance = network.stats;
  builds(() => network.solve([first.unknown[0], first.unknown[0]]), 0, 0);
  assert.equal(network.stats.factorizations - beforeResistance.factorizations, 1);
  assert.equal(network.stats.cacheHits - beforeResistance.cacheHits, 1);
  for (const endpoint of second.unknown)
    assert.deepEqual(accesses.get(endpoint), { intent: 0, sample: 0, writes: 0 });
  checkChain(first, (index) => -2 + (12 * (2 + index)) / 6);
  checkChain(second, (index) => -2 + (12 * (1 + index)) / 5);
  for (const endpoint of second.pins)
    assert.equal(endpoint.sample, baselineSamples[allPins.indexOf(endpoint)]);
  first.unknown[0].intent = [...first.unknown[0].intent];
  resetReads();
  const beforeEqual = network.stats;
  builds(() => network.solve(), 0, 0);
  assert.equal(network.stats.cacheHits - beforeEqual.cacheHits, 2, 'equal replacement intent');
  for (const reads of accesses.values()) assert.equal(reads.sample, 0);
  first.unknown[0].intent = [...original].reverse();
  builds(() => network.solve(), 1, 2);
  checkChain(first, (index) => -2 + (12 * (1 + index)) / 5);
  first.unknown[0].intent = [...original, { to: first.left, resistance }];
  builds(() => network.solve(), 1, 2);
  checkChain(first, (index) => -2 + (12 * (0.5 + index)) / 4.5);
  first.unknown[0].intent = original;
  builds(() => network.solve(), 1, 2);
  first.unknown[0].intent = [...original, { to: second.unknown[0], resistance }];
  builds(() => network.solve(), 1, 1);
  checkChain(first, (index) => -2 + (12 * (1 + index)) / 5);
  first.unknown[0].intent = original;
  builds(() => network.solve(), 0, 0);
  // A late block failure must roll back numeric caches, identity snapshots and prepared topology.
  for (const connectivityChange of [false, true]) {
    const retained = allPins.map((endpoint) => endpoint.sample);
    const beforeFailure = network.stats;
    const multiplier = connectivityChange ? 3 : 2;
    first.setBoundaryBranches(
      connectivityChange ? first.right : first.left,
      connectivityChange ? first.left : first.right,
      multiplier * resistance,
    );
    leading(second, multiplier);
    probes.failAfter = 1;
    assert.throws(
      () => network.solve(),
      (error) => {
        assert.equal(error.code, 'ELECTRICAL_SOLVE_FAILED');
        assert.equal(error.reason, 'Injected LDL failure.');
        assert.deepEqual(new Set(error.component), new Set(allPins.map((endpoint) => endpoint.id)));
        assert.deepEqual(new Set(error.networks), new Set(['left', 'right']));
        assert.ok(Object.isFrozen(error.component) && Object.isFrozen(error.networks));
        return true;
      },
    );
    probes.failAfter = null;
    assert.deepEqual(network.stats, beforeFailure);
    allPins.forEach((endpoint, index) => assert.equal(endpoint.sample, retained[index]));
    builds(() => network.solve(), connectivityChange ? 1 : 0, connectivityChange ? 2 : 0);
    assert.equal(network.stats.factorizations - beforeFailure.factorizations, 2);
    checkChain(first, (index) =>
      connectivityChange
        ? 10 - (12 * (multiplier + index)) / (4 + multiplier)
        : -2 + (12 * (multiplier + index)) / (4 + multiplier),
    );
    checkChain(second, (index) => -2 + (12 * (multiplier + index)) / (4 + multiplier));
  }
  const beforeResidual = network.stats;
  const residualSamples = allPins.map((endpoint) => endpoint.sample);
  leading(second, 4);
  probes.badSolution = true;
  assert.throws(() => network.solve(), {
    code: 'ELECTRICAL_SOLVE_FAILED',
    reason: 'Unknown-node normalized residual exceeds 1e-12.',
  });
  probes.badSolution = false;
  assert.deepEqual(network.stats, beforeResidual);
  allPins.forEach((endpoint, index) => assert.equal(endpoint.sample, residualSamples[index]));
  builds(() => network.solve([second.unknown[0]]), 0, 0);
  assert.equal(network.stats.factorizations - beforeResidual.factorizations, 1);
  assert.equal(network.stats.cacheHits - beforeResidual.cacheHits, 1);
  checkChain(second, (index) => -2 + (12 * (4 + index)) / 8);
  for (const count of [1, 2, 32, 33]) {
    const high = pin(`independent.${count}.high`);
    const low = pin(`independent.${count}.low`);
    const unknown = Array.from({ length: count }, (_, index) =>
      pin(`independent.${count}.${index}`),
    );
    for (const endpoint of unknown)
      endpoint.intent = [
        { to: high, resistance },
        { to: low, resistance },
      ];
    const independent = createNetwork(
      [high, low, ...unknown],
      [
        { id: 'high', pins: [high], voltage: 10 },
        { id: 'low', pins: [low], voltage: 0 },
      ],
    );
    const blocks = count <= 32 ? 1 : count;
    const beforeDiagonal = probes.diagonal;
    builds(() => independent.solve(), 1, blocks);
    assert.equal(independent.stats.factorizations, blocks);
    assert.equal(
      probes.diagonal - beforeDiagonal,
      blocks,
      'independent pivots avoid dense zero matrices',
    );
    unknown.forEach((endpoint) => checkPin(endpoint, 5, true));
    unknown[0].intent = [
      { to: high, resistance: 2 * resistance },
      { to: low, resistance },
    ];
    const before = independent.stats;
    builds(() => independent.solve([unknown[0]]), 0, 0);
    assert.equal(independent.stats.factorizations - before.factorizations, 1);
    assert.equal(independent.stats.cacheHits - before.cacheHits, blocks - 1);
    checkPin(unknown[0], 10 / 3);
    unknown.slice(1).forEach((endpoint) => checkPin(endpoint, 5, true));
    if (count > 1) {
      const diagonalIntent = unknown[0].intent;
      unknown[0].intent = [...diagonalIntent, { to: unknown[1], resistance }];
      builds(() => independent.solve([unknown[0]]), 1, count - 1);
      checkPin(unknown[0], 50 / 13);
      checkPin(unknown[1], 60 / 13);
      unknown[0].intent = diagonalIntent;
      builds(() => independent.solve([unknown[0]]), 1, blocks);
      checkPin(unknown[0], 10 / 3);
      checkPin(unknown[1], 5, true);
    }
  }
  for (const count of [1, 16]) {
    const high = pin(`digital.${count}.high`);
    const low = pin(`digital.${count}.low`);
    const outputs = Array.from({ length: count }, (_, index) => pin(`digital.${count}.${index}`));
    for (const output of outputs) output.intent = [{ to: high, resistance }];
    const digital = createNetwork(
      [high, low, ...outputs],
      [
        { id: 'high', pins: [high], voltage: 5 },
        { id: 'low', pins: [low], voltage: 0 },
      ],
    );
    builds(() => digital.solve(new Set()), 1, 2);
    const fixed = [high.sample, low.sample];
    for (let step = 0; step < 8; step++) {
      const target = step % 2 === 0 ? low : high;
      for (const output of outputs)
        output.intent = [{ to: target, resistance: resistance * (step + 1) }];
      const before = digital.stats;
      const touched = new Set(step % 2 === 0 ? outputs : [...outputs].reverse());
      const changed = builds(() => digital.solve(touched), step < 3 ? 1 : 0, step < 3 ? 2 : 0);
      assert.deepEqual(changed, outputs, 'changed pins retain board ordering');
      assert.equal(digital.stats.components, 2);
      assert.equal(digital.stats.floatingComponents, 0);
      assert.equal(digital.stats.factorizations, 0);
      assert.equal(digital.stats.factorizationReuses, 0);
      assert.equal(
        digital.stats.cacheHits - before.cacheHits,
        0,
        'topology reuse is not a numeric cache hit',
      );
      outputs.forEach((output) => checkPin(output, target === high ? 5 : 0, true));
      assert.equal(high.sample, fixed[0]);
      assert.equal(low.sample, fixed[1]);
    }
  }
  const railHigh = pin('restored.high');
  const railLow = pin('restored.low');
  const signal = pin('restored.signal');
  signal.intent = [
    { to: railHigh, resistance },
    { to: railLow, resistance },
  ];
  const switched = createNetwork(
    [railHigh, railLow, signal],
    [
      { id: 'high', pins: [railHigh], voltage: 10 },
      { id: 'low', pins: [railLow], voltage: 0 },
    ],
  );
  builds(() => switched.solve(), 1, 1);
  checkPin(signal, 5, true);
  signal.intent = [
    { to: railLow, resistance },
    { to: railLow, resistance },
  ];
  builds(() => switched.solve([signal]), 1, 2);
  const switchedHandle = probes.caches.at(-1);
  const admissionBeforeFailure = [...switchedHandle.transitions];
  const agesBeforeFailure = [...switchedHandle.ages];
  const lowSnapshot = signal.sample;
  const lowStats = switched.stats;
  signal.intent = [
    { to: railHigh, resistance: resistance * 3 },
    { to: railLow, resistance },
  ];
  probes.badSolution = true;
  assert.throws(
    () => switched.solve([signal]),
    (error) => {
      assert.equal(error.reason, 'Unknown-node normalized residual exceeds 1e-12.');
      assert.deepEqual(new Set(error.component), new Set([railHigh.id, railLow.id, signal.id]));
      return true;
    },
  );
  probes.badSolution = false;
  assert.equal(signal.sample, lowSnapshot);
  assert.deepEqual(switched.stats, lowStats);
  assert.deepEqual(
    [...switchedHandle.transitions],
    admissionBeforeFailure,
    'failed solve cannot admit a graph',
  );
  assert.deepEqual(
    [...switchedHandle.ages],
    agesBeforeFailure,
    'failed solve cannot advance admission recency',
  );
  signal.intent = [
    { to: railHigh, resistance: resistance * 5 },
    { to: railLow, resistance },
  ];
  builds(() => switched.solve([signal]), 1, 1);
  checkPin(signal, 10 / 6);
  assert.equal(switched.stats.components, 1);
  assert.equal(switched.stats.factorizations - lowStats.factorizations, 1);
  const a = pin('transition.a');
  const b = pin('transition.b');
  const high = pin('transition.high');
  const low = pin('transition.low');
  const transitions = createNetwork(
    [a, b, high, low],
    [
      { id: 'high', pins: [high], voltage: 10 },
      { id: 'low', pins: [low], voltage: 0 },
    ],
  );
  builds(() => transitions.solve(), 1, 4);
  const floating = a.sample;
  a.intent = [{ to: b, resistance }];
  builds(() => transitions.solve(), 1, 3);
  assert.equal(transitions.stats.floatingComponents, 1);
  assert.equal(a.sample, floating);
  a.intent = [...a.intent, { to: high, resistance }];
  builds(() => transitions.solve(), 1, 2);
  checkPin(a, 10, true);
  checkPin(b, 10, true);
  b.intent = [{ to: low, resistance }];
  builds(() => transitions.solve(), 1, 1);
  checkPin(a, 20 / 3);
  checkPin(b, 10 / 3);
  b.intent = [{ to: low, resistance: resistance * 2 }];
  builds(() => transitions.solve(), 0, 0);
  checkPin(a, 7.5);
  checkPin(b, 5);
  a.intent = [];
  builds(() => transitions.solve(), 1, 3);
  assert.deepEqual(a.sample, { voltage: null, level: 'unknown', status: 'floating' });
  assert.equal(transitions.stats.floatingComponents, 1);
  checkPin(b, 0, true);
  const beforeReferenceEdge = [high.sample, low.sample];
  high.intent = [{ to: low, resistance }];
  builds(() => transitions.solve(), 1, 2);
  high.intent = [{ to: low, resistance: 2 * resistance }];
  builds(() => transitions.solve(), 0, 0);
  assert.equal(high.sample, beforeReferenceEdge[0]);
  assert.equal(low.sample, beforeReferenceEdge[1]);
  const beforeInvalid = transitions.stats;
  a.intent = [{ to: a, resistance: 0 }];
  assert.throws(() => transitions.solve(), {
    code: 'INVALID_ELECTRICAL_PARAMETER',
    resource: a.name,
  });
  assert.deepEqual(transitions.stats, beforeInvalid);
  a.intent = [{ to: pin('foreign'), resistance }];
  assert.throws(() => transitions.solve(), {
    code: 'INVALID_ELECTRICAL_PARAMETER',
    resource: a.name,
  });
  a.intent = [];
  builds(() => transitions.solve(), 0, 0);
  const censusHigh = pin('ownership.high');
  const censusLow = pin('ownership.low');
  const divider = pin('ownership.divider');
  divider.intent = [
    { to: censusHigh, resistance },
    { to: censusLow, resistance },
  ];
  const censusOutputs = Array.from({ length: 51 }, (_, index) => pin(`ownership.${index}`));
  for (const output of censusOutputs) output.intent = [{ to: censusLow, resistance }];
  const retained = createNetwork(
    [censusHigh, censusLow, divider, ...censusOutputs],
    [
      { id: 'high', pins: [censusHigh], voltage: 10 },
      { id: 'low', pins: [censusLow], voltage: 0 },
    ],
  );
  const retainedHandle = probes.caches.at(-1);
  builds(() => retained.solve(), 1, 52);
  const toggled = censusOutputs[0];
  toggled.intent = [{ to: censusHigh, resistance }];
  builds(() => retained.solve([toggled]), 1, 52);
  assert.ok(
    [...retainedHandle.transitions.values()].every((value) => value === undefined),
    'first observations retain descriptors only',
  );
  assert.deepEqual(ownership(retainedHandle), { snapshots: 1, topologies: 1 });
  for (const target of [censusLow, censusHigh]) {
    toggled.intent = [{ to: target, resistance }];
    builds(() => retained.solve([toggled]), 1, 52);
  }
  assert.equal(
    [...retainedHandle.transitions.values()].filter(Boolean).length,
    2,
    'second observations admit both reusable shapes',
  );
  const beforeRebinding = probes.reboundBlocks;
  const beforeZeroCopy = probes.zeroCopyRestores;
  for (let step = 0; step < 8; step++) {
    const target = step % 2 === 0 ? censusLow : censusHigh;
    toggled.intent = [{ to: target, resistance }];
    builds(() => retained.solve([toggled]), 0, 0);
    checkPin(toggled, target === censusHigh ? 10 : 0, true);
  }
  assert.equal(
    probes.reboundBlocks,
    beforeRebinding,
    '52-block same-value restores allocate no block copies',
  );
  assert.equal(probes.zeroCopyRestores - beforeZeroCopy, 8);
  assert.deepEqual(ownership(retainedHandle), { snapshots: 2, topologies: 2 });
  const beforeStableResistance = retained.stats;
  toggled.intent = [{ to: censusHigh, resistance: resistance * 2 }];
  builds(() => retained.solve([toggled]), 0, 0);
  assert.equal(
    probes.reboundBlocks - beforeRebinding,
    1,
    'stable slots find older equivalent edge objects',
  );
  assert.equal(retained.stats.cacheHits - beforeStableResistance.cacheHits, 51);
  toggled.intent = [{ to: censusLow, resistance: resistance * 2 }];
  builds(() => retained.solve([toggled]), 0, 0);
  assert.equal(
    probes.reboundBlocks - beforeRebinding,
    2,
    'only the changed block is copied on restoration',
  );
  checkPin(toggled, 0, true);
  const coldHigh = pin('cold.high');
  const coldLow = pin('cold.low');
  const coldDivider = pin('cold.divider');
  coldDivider.intent = [
    { to: coldHigh, resistance },
    { to: coldLow, resistance },
  ];
  const coldBus = Array.from({ length: 51 }, (_, index) => pin(`cold.${index}`));
  for (const output of coldBus) output.intent = [{ to: coldLow, resistance }];
  const cold = createNetwork(
    [coldHigh, coldLow, coldDivider, ...coldBus],
    [
      { id: 'high', pins: [coldHigh], voltage: 10 },
      { id: 'low', pins: [coldLow], voltage: 0 },
    ],
  );
  const coldHandle = probes.caches.at(-1);
  builds(() => cold.solve(), 1, 52);
  const beforeColdRestores = probes.restores;
  const coldTouched = new Set(coldBus);
  for (let round = 0; round < 2; round++) {
    for (let frame = 1; frame <= 24; frame++) {
      coldBus.forEach((output, index) => {
        output.intent = [{ to: (frame >> (index % 5)) & 1 ? coldHigh : coldLow, resistance }];
      });
      builds(() => cold.solve(coldTouched), 1, 52);
      coldBus.forEach((output, index) =>
        checkPin(output, (frame >> (index % 5)) & 1 ? 10 : 0, true),
      );
      checkPin(coldDivider, 5, true);
      assert.ok(
        [...coldHandle.transitions.values()].every((value) => value === undefined),
        'cold bus churn must not retain historical graphs',
      );
      assert.deepEqual(ownership(coldHandle), { snapshots: 1, topologies: 1 });
    }
  }
  assert.equal(
    probes.restores,
    beforeColdRestores,
    '24 distinct frames exceed the eight-descriptor window',
  );
  assert.equal(coldHandle.transitions.size, 8);
  let maximumSnapshots = 0;
  let maximumTopologies = 0;
  for (const handle of probes.caches) {
    const census = ownership(handle);
    maximumSnapshots = Math.max(maximumSnapshots, census.snapshots);
    maximumTopologies = Math.max(maximumTopologies, census.topologies);
  }
  for (const count of [1, 16]) {
    const workload = digitalReferenceWorkload(count);
    for (let step = 0; step < 4; step++) {
      const before = workload.network.stats;
      workload.run(step);
      workload.verify();
      const after = workload.network.stats;
      const expected = workload.expectedCounters();
      for (const name of counterNames) assert.equal(after[name] - before[name], expected[name]);
    }
  }
  return {
    topology_builds: probes.topology,
    adjacency_builds: probes.adjacency,
    physical_partitions: probes.partitions,
    topology_restores: probes.restores,
    diagonal_factorizations: probes.diagonal,
    zero_copy_restores: probes.zeroCopyRestores,
    rebound_blocks: probes.reboundBlocks,
    ownership_maximum_snapshots: maximumSnapshots,
    ownership_maximum_topologies: maximumTopologies,
    cold_observations: 48,
    cold_descriptor_entries: coldHandle.transitions.size,
    cold_retained_graphs: [...coldHandle.transitions.values()].filter(Boolean).length,
    assertions:
      'stable identity/dirty hints, resistance adjacency reuse, exact reference-switch restoration, order/multiplicity, shared-reference merge/split, diagonal/coupled 32/33-node transitions, floating/reference-only transitions, 1e-12 residual rejection, complete failure diagnostics and atomic cache retry, 52-block zero-copy restores, two-observation admission, cold bus churn retains descriptors only, bounded ownership without history or numerical-cache chains',
    instrumentation:
      'separate untimed module only; measured workloads use unmodified transpilation',
  };
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

const cacheVerification = await verifyCacheTransitions();
if (verifyOnly) {
  console.log(
    JSON.stringify(
      { benchmark: 'standalone-electrical-verification', cache_verification: cacheVerification },
      null,
      2,
    ),
  );
  process.exit(0);
}
const started = performance.now();
const results = [];
for (const size of options.sizes) {
  for (const name of [
    'static-reuse',
    'static-dirty-hint',
    'rhs-reuse',
    'resistance-update',
    'reference-rebuild',
  ]) {
    results.push(measure(singleChainWorkload(name, size)));
  }
  results.push(measure(mergeSplitWorkload(size)));
  results.push(measure(sharedRailsWorkload(size)));
  results.push(measure(digitalReferenceWorkload(size)));
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
      cache_verification: cacheVerification,
      results,
    },
    null,
    2,
  ),
);
