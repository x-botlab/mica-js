import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {
  arbitrary,
  digitalLevel,
  scaleResistances,
  solveNetwork,
  splitResistance,
} from './domains/electrical.mjs';

const node = (voltage = null) => ({ voltage, thresholds: null });
const edge = (from, to, resistance) => ({ from, to, resistance });
const close = (actual, expected) => {
  assert.ok(
    Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)),
    `expected ${expected}, received ${actual}`,
  );
};

function assertLegal(sample, size) {
  assert.deepEqual(JSON.parse(JSON.stringify(sample)), sample);
  const inspect = (value) => {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value));
      assert.ok(!Object.is(value, -0));
    } else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) inspect(child);
    }
  };
  inspect(sample);
  assert.ok(sample.nodes.length >= 3 && sample.nodes.length <= size);
  assert.equal(sample.nodes[0].voltage, 0);
  assert.notEqual(sample.nodes.at(-1).voltage, null);
  for (const { voltage, thresholds } of sample.nodes) {
    assert.ok(voltage === null || Number.isFinite(voltage));
    if (thresholds !== null) assert.ok(thresholds.low < thresholds.high);
  }
  const seen = new Set([0]);
  for (const { from, to, resistance } of sample.edges) {
    assert.ok(Number.isInteger(from) && from >= 0 && from < sample.nodes.length);
    assert.ok(Number.isInteger(to) && to >= 0 && to < sample.nodes.length);
    assert.notEqual(from, to);
    assert.ok(resistance >= 0.001 && resistance <= 1e9);
  }
  for (let iteration = 0; iteration < sample.nodes.length; iteration++) {
    for (const { from, to } of sample.edges) {
      if (seen.has(from)) seen.add(to);
      if (seen.has(to)) seen.add(from);
    }
  }
  assert.equal(seen.size, sample.nodes.length, 'every node must reach explicit ground');
  assert.ok(sample.edges.length <= 2 * size - 1);
  assert.ok(Number.isInteger(sample.scale) && sample.scale >= 2 && sample.scale <= 4);
  assert.equal(sample.runUntil[0], 0);
  assert.ok(sample.runUntil.at(-1) >= 2);
  sample.runUntil.forEach((time, index) => {
    assert.ok(Number.isSafeInteger(time) && time >= 0);
    if (index > 0) assert.ok(time >= sample.runUntil[index - 1]);
  });
  const solution = solveNetwork(sample);
  for (let index = 0; index < solution.length; index++) {
    assert.ok(Number.isFinite(solution[index]));
    const current = sample.nodes[index];
    if (current.voltage !== null) {
      assert.equal(solution[index], current.voltage);
      continue;
    }
    let conductance = 0;
    let weighted = 0;
    let absolute = 0;
    for (const { from, to, resistance } of sample.edges) {
      if (from !== index && to !== index) continue;
      const other = from === index ? to : from;
      conductance += 1 / resistance;
      weighted += solution[other] / resistance;
      absolute += Math.abs(solution[other]) / resistance;
    }
    // electrical.rst, "Linear solving and numerical acceptance": original node equations.
    assert.ok(
      Math.abs(solution[index] - weighted / conductance) <=
        1e-12 * (Math.abs(solution[index]) + absolute / conductance),
    );
    if (current.thresholds !== null) {
      assert.ok(Math.abs(solution[index] - current.thresholds.low) >= 0.24);
      assert.ok(Math.abs(solution[index] - current.thresholds.high) >= 0.24);
    }
  }
}

test('nodal oracle matches series divider with negative and positive references', () => {
  const network = {
    nodes: [node(-2), node(), node(4)],
    edges: [edge(0, 1, 100), edge(1, 2, 200)],
  };
  const voltages = solveNetwork(network);
  assert.equal(voltages[0], -2);
  close(voltages[1], 0);
  assert.equal(voltages[2], 4);
});

test('nodal oracle counts parallel branches independently', () => {
  const voltages = solveNetwork({
    nodes: [node(0), node(), node(3.3)],
    edges: [edge(0, 1, 1000), edge(1, 2, 1000), edge(1, 2, 1000)],
  });
  close(voltages[1], 2.2);
});

test('nodal oracle solves a loaded bridge instead of independent unloaded dividers', () => {
  const voltages = solveNetwork({
    nodes: [node(0), node(), node(), node(6)],
    edges: [edge(0, 1, 100), edge(1, 3, 100), edge(0, 2, 100), edge(2, 3, 200), edge(1, 2, 100)],
  });
  close(voltages[1], 36 / 13);
  close(voltages[2], 30 / 13);
});

test('nodal oracle retains fixed references, ignores self loops, and normalizes zero', () => {
  assert.deepEqual(
    solveNetwork({
      nodes: [node(0), node(4)],
      edges: [edge(0, 1, 100)],
    }),
    [0, 4],
  );
  assert.deepEqual(
    solveNetwork({
      nodes: [node(0), node(), node()],
      edges: [edge(0, 1, 100), edge(1, 2, 100), edge(2, 2, 100)],
    }),
    [0, 0, 0],
  );
});

test('digital oracle uses inclusive thresholds without implicit thresholds', () => {
  const thresholds = { low: -1, high: 2 };
  assert.equal(digitalLevel(-1, thresholds), 'low');
  assert.equal(digitalLevel(2, thresholds), 'high');
  assert.equal(digitalLevel(0, thresholds), 'unknown');
  assert.equal(digitalLevel(10, null), 'unknown');
});

for (const size of [3, 5, 6, 7, 10]) {
  test(`electrical size ${size}: generated topology, parameters, and oracle remain legal`, () => {
    fc.assert(
      fc.property(arbitrary(size), (sample) => {
        assertLegal(sample, size);
        const expected = solveNetwork(sample);
        for (const transformed of [scaleResistances(sample), splitResistance(sample)]) {
          const actual = solveNetwork(transformed);
          actual.forEach((voltage, index) => close(voltage, expected[index]));
          for (const branch of transformed.edges) {
            assert.ok(branch.resistance >= 0.001 && branch.resistance <= 1e9);
          }
        }
      }),
      { seed: 20261104, numRuns: 200 },
    );
  });

  test(`electrical size ${size}: shrinking preserves connectedness and all parameter invariants`, () => {
    const invalid = [];
    let visits = 0;
    const result = fc.check(
      fc.property(arbitrary(size), (sample) => {
        visits++;
        try {
          assertLegal(sample, size);
        } catch (error) {
          invalid.push(error);
        }
        return false;
      }),
      { seed: 8675309, numRuns: 1 },
    );
    assert.equal(result.failed, true, 'deliberately false property must initiate shrinking');
    assert.ok(result.numShrinks > 0 && visits > 1);
    assert.deepEqual(invalid, []);
  });
}
