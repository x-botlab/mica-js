import assert from 'node:assert/strict';
import fc from 'fast-check';
import { device, messages } from '../../conformance/semantics/fixture.mjs';

const cleanZero = (value) => (value === 0 ? 0 : value);
const finite = (value) => Number.isFinite(value) && !Object.is(value, -0);

/** Independent dense nodal oracle, using pivoted elimination rather than runtime APIs. */
export function solveNetwork({ nodes, edges }) {
  const unknown = nodes.flatMap((node, index) => (node.voltage === null ? [index] : []));
  const slots = new Map(unknown.map((node, index) => [node, index]));
  const matrix = unknown.map(() => Array(unknown.length + 1).fill(0));
  for (const { from, to, resistance } of edges) {
    assert.ok(finite(resistance) && resistance >= 0.001 && resistance <= 1e9);
    if (from === to) continue;
    const conductance = 1 / resistance;
    for (const [node, other] of [
      [from, to],
      [to, from],
    ]) {
      const row = slots.get(node);
      if (row === undefined) continue;
      matrix[row][row] += conductance;
      const column = slots.get(other);
      if (column === undefined) matrix[row][unknown.length] += conductance * nodes[other].voltage;
      else matrix[row][column] -= conductance;
    }
  }
  for (let column = 0; column < unknown.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < unknown.length; row++) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    assert.ok(
      Number.isFinite(matrix[column][column]) && matrix[column][column] > 0,
      'oracle requires a referenced, nonsingular positive-resistance network',
    );
    for (let row = column + 1; row < unknown.length; row++) {
      const factor = matrix[row][column] / matrix[column][column];
      for (let entry = column + 1; entry <= unknown.length; entry++) {
        matrix[row][entry] -= factor * matrix[column][entry];
      }
      matrix[row][column] = 0;
    }
  }
  const solution = Array(unknown.length).fill(0);
  for (let row = unknown.length - 1; row >= 0; row--) {
    let right = matrix[row][unknown.length];
    for (let column = row + 1; column < unknown.length; column++) {
      right -= matrix[row][column] * solution[column];
    }
    solution[row] = cleanZero(right / matrix[row][row]);
    assert.ok(finite(solution[row]));
  }
  return nodes.map((node, index) =>
    node.voltage === null ? solution[slots.get(index)] : node.voltage,
  );
}

export function digitalLevel(voltage, thresholds) {
  if (thresholds === null) return 'unknown';
  if (voltage <= thresholds.low) return 'low';
  if (voltage >= thresholds.high) return 'high';
  return 'unknown';
}

/** Rebuild the spine after every shrink; no filtered arbitrary or dangling endpoints. */
export function generateNetwork({ nodeSeeds, extraEdges, supply, firstStep, lastStep, scale }) {
  const count = nodeSeeds.length;
  const nodes = nodeSeeds.map((seed, index) => ({
    voltage:
      index === 0
        ? 0
        : index === count - 1
          ? cleanZero(supply / 4)
          : seed.reference
            ? cleanZero(seed.voltage / 4)
            : null,
    thresholds: null,
  }));
  const edges = nodeSeeds.slice(1).map((seed, index) => ({
    from: index,
    to: index + 1,
    resistance: seed.resistance,
  }));
  for (const edge of extraEdges) {
    const from = edge.from % count;
    edges.push({
      from,
      to: (from + 1 + (edge.offset % (count - 1))) % count,
      resistance: edge.resistance,
    });
  }
  const voltages = solveNetwork({ nodes, edges });
  for (let index = 0; index < count; index++) {
    const mode = nodeSeeds[index].thresholdMode;
    const voltage = voltages[index];
    // electrical.rst: exact threshold equality is meaningful only at fixed references here.
    if (mode === 0) continue;
    let low;
    let high;
    if (mode === 1) [low, high] = [voltage + 0.25, voltage + 1];
    else if (mode === 2) [low, high] = [voltage - 1, voltage - 0.25];
    else if (mode === 4 && nodes[index].voltage !== null) [low, high] = [voltage, voltage + 1];
    else if (mode === 5 && nodes[index].voltage !== null) [low, high] = [voltage - 1, voltage];
    else [low, high] = [voltage - 0.25, voltage + 0.25];
    nodes[index].thresholds = { low: cleanZero(low), high: cleanZero(high) };
  }
  return { nodes, edges, runUntil: [0, firstStep, firstStep, firstStep + lastStep + 2], scale };
}

export function arbitrary(size) {
  assert.ok(
    Number.isInteger(size) && size >= 3 && size <= 10,
    'electrical size must be an integer from 3 to 10',
  );
  const resistance = fc.integer({ min: 100, max: 10000 });
  return fc
    .record({
      nodeSeeds: fc.array(
        fc.record({
          reference: fc.boolean(),
          voltage: fc.integer({ min: -40, max: 40 }),
          resistance,
          thresholdMode: fc.integer({ min: 0, max: 5 }),
        }),
        { minLength: 3, maxLength: size },
      ),
      extraEdges: fc.array(
        fc.record({
          from: fc.nat({ max: size - 1 }),
          offset: fc.nat({ max: size - 2 }),
          resistance,
        }),
        { maxLength: size },
      ),
      supply: fc.integer({ min: -40, max: 40 }),
      firstStep: fc.integer({ min: 0, max: 3 }),
      lastStep: fc.integer({ min: 0, max: 3 }),
      scale: fc.integer({ min: 2, max: 4 }),
    })
    .map(generateNetwork);
}

export function scaleResistances(sample) {
  return {
    ...sample,
    edges: sample.edges.map((edge) => ({
      ...edge,
      resistance: edge.resistance * sample.scale,
    })),
  };
}

export function splitResistance(sample) {
  const [first, ...rest] = sample.edges;
  const branch = { ...first, resistance: 2 * first.resistance };
  return { ...sample, edges: [{ ...branch }, { ...branch }, ...rest] };
}

/** Emit samples through a typed record channel, including optional-number narrowing. */
export function buildModel(sample) {
  const declarations = sample.nodes
    .map((node, index) => {
      const threshold =
        node.thresholds === null
          ? ''
          : `(low: ${node.thresholds.low}, high: ${node.thresholds.high})`;
      const branches = sample.edges
        .filter((edge) => edge.from === index)
        .map((edge) => `resistor(to: p${edge.to}, resistance: ${edge.resistance})`);
      return `pin p${index}${threshold} = [${branches.join(', ')}];`;
    })
    .join('\n');
  const readings = sample.nodes
    .map(
      (_, index) => `
    const sampled${index} = p${index}.sample;
    const voltage${index} = sampled${index}.voltage;
    if voltage${index} != none {
      out.send({
        node: ${index}, voltage: voltage${index},
        low: sampled${index}.level == Logic.low,
        high: sampled${index}.level == Logic.high,
        unknown: sampled${index}.level == Logic.unknown,
        valid: sampled${index}.status == SampleStatus.valid
      });
    } else {
      assert false, "generated connected network must have a reference";
    }
  `,
    )
    .join('\n');
  return `device GeneratedElectrical {
    record Reading { node: number; voltage: number; low: bool; high: bool; unknown: bool; valid: bool; }
    output channel out: Reading(capacity: ${sample.nodes.length * 3}, overflow: Overflow.error);
    ${declarations}
    fn readAll() { ${readings} }
    process start {
      readAll();
      await ticks(1);
      readAll();
      await ticks(1);
      readAll();
    }
  }`;
}

function description(sample) {
  return {
    instances: [{ id: 'probe', type: 'probe' }],
    nets: sample.nodes.map((node, index) => ({
      id: `n${index}`,
      pins: [{ instance: 'probe', pin: `p${index}` }],
      ...(node.voltage === null ? {} : { voltage: node.voltage }),
    })),
  };
}

function close(actual, expected, label) {
  assert.ok(finite(actual), `${label}: voltage must be finite and normalize negative zero`);
  assert.ok(
    Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)),
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function checkReadings(sample, delivered) {
  const expected = solveNetwork(sample);
  assert.equal(delivered.length, sample.nodes.length * 3);
  for (let index = 0; index < delivered.length; index++) {
    const nodeIndex = index % sample.nodes.length;
    const node = sample.nodes[nodeIndex];
    const { time, value } = delivered[index];
    assert.equal(time, Math.floor(index / sample.nodes.length));
    assert.equal(value.node, nodeIndex);
    close(value.voltage, expected[nodeIndex], `node ${nodeIndex} at ${time}`);
    if (node.voltage !== null) assert.equal(value.voltage, node.voltage);
    const level = digitalLevel(expected[nodeIndex], node.thresholds);
    assert.equal(value.valid, true);
    for (const name of ['low', 'high', 'unknown']) assert.equal(value[name], level === name);
  }
}

async function execute(adapter, sample, targets) {
  const model = await adapter.compileDDL(buildModel(sample));
  const { board, batches } = await device(adapter, model, {}, description(sample));
  try {
    for (const target of targets) {
      board.runUntil(target);
      assert.equal(board.time, target);
      assert.equal(board.status, 'ready');
    }
    const delivered = messages(batches);
    checkReadings(sample, delivered);
    return delivered;
  } finally {
    board.dispose();
  }
}

/** Requires a real ConformanceAdapter; pure oracle tests do not claim runtime conformance. */
export async function check(adapter, sample) {
  const final = sample.runUntil.at(-1);
  const baseline = await execute(adapter, sample, sample.runUntil);
  const direct = await execute(adapter, sample, [final]);
  assert.deepEqual(direct, baseline, 'runUntil slicing must preserve static-network observations');
  // electrical.rst permits rounding differences after mathematically equivalent branch rewrites.
  for (const transformed of [scaleResistances(sample), splitResistance(sample)]) {
    const delivered = await execute(adapter, transformed, [final]);
    for (let index = 0; index < delivered.length; index++) {
      close(delivered[index].value.voltage, baseline[index].value.voltage, 'metamorphic voltage');
    }
  }
}

export const domain = { name: 'electrical', arbitrary, check };
