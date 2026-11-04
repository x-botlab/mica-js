import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compileDDL } from '@mica-js/ddl';
import { createBoard, createDeviceLibrary } from '../dist/index.js';

const events = 100_000;
const warmups = 2;
const samples = 20;
const fanout = 32;
const rounds = 1_000;
const dormantModel = await compileDDL('device Dormant {}');
const scenarios = [
  {
    name: 'sparse-time-advance',
    target: 7_200_000_000_000_000,
    expected: 1,
    operations: 1,
    source: `device Sparse {
      output channel out: number(capacity: 1);
      process start {
        await ticks(7_200_000_000_000_000);
        out.send(1);
      }
    }`,
  },
  {
    name: 'timer-boundaries',
    target: events,
    expected: events,
    operations: events,
    source: `device Timers {
      output channel out: number(capacity: 1);
      process start {
        let i: number = 0;
        while (i < ${events}) {
          await ticks(1);
          i = i + 1;
        }
        out.send(i);
      }
    }`,
  },
  {
    name: 'timers-with-1000-dormant-instances',
    target: rounds,
    expected: 1,
    operations: rounds,
    dormant: 1_000,
    source: `device Active {
      output channel out: number(capacity: 1);
      process start {
        let i = 0;
        while (i < ${rounds}) { await ticks(1); i = i + 1; }
        out.send(1);
      }
    }`,
  },
  {
    name: 'reaction-fanout-with-clean-observers',
    target: rounds,
    expected: rounds * fanout,
    operations: rounds * fanout,
    source: `device Reactions {
      state active: number = 0;
      state idle: number = 0;
      public memory evidence[4];
      output channel out: number(capacity: 1);
      ${Array.from(
        { length: fanout },
        (_, i) => `
        derived d${i}: number = active + ${i};
        reaction r${i} on d${i} as (old, current) {
          store32le(evidence, 0, load32le(evidence, 0) + 1);
        }
      `,
      ).join('\n')}
      ${Array.from(
        { length: 128 },
        (_, i) => `
        reaction clean${i} on idle as (old, current) { assert false; }
      `,
      ).join('\n')}
      process start {
        let i = 0;
        while (i < ${rounds}) {
          active = i + 1;
          await ticks(1);
          i = i + 1;
        }
        out.send(load32le(evidence, 0));
      }
    }`,
  },
  {
    name: 'memory-and-channel-snapshots',
    target: 0,
    expected: events - 1,
    expectedCount: events,
    expectedSum: (events * (events - 1)) / 2,
    operations: events,
    source: `device Messages {
      public memory data[4];
      output channel out: number(capacity: ${events});
      process start {
        let i = 0;
        while (i < ${events}) {
          store32le(data, 0, i);
          out.send(load32le(data, 0));
          i = i + 1;
        }
      }
    }`,
  },
];

const results = [];
for (const scenario of scenarios) {
  const model = await compileDDL(scenario.source);
  const timings = [];
  const heapDeltas = [];
  for (let repeat = 0; repeat < warmups + samples; repeat++) {
    let count = 0;
    let sum = 0;
    let last;
    const library = createDeviceLibrary([
      {
        id: 'bench',
        model,
        create() {
          return {
            sync(batch) {
              for (const message of batch.outputs.out) {
                count++;
                sum += message.value;
                last = message.value;
              }
            },
            dispose() {},
          };
        },
      },
      {
        id: 'dormant',
        model: dormantModel,
        create() {
          return { sync() {}, dispose() {} };
        },
      },
    ]);
    const board = createBoard(library, {
      instances: [
        { id: 'bench', type: 'bench' },
        ...Array.from({ length: scenario.dormant ?? 0 }, (_, i) => ({
          id: `sleep${i}`,
          type: 'dormant',
        })),
      ],
      nets: [],
    });
    try {
      const heapBefore = process.memoryUsage().heapUsed;
      const start = performance.now();
      board.runUntil(scenario.target);
      const elapsed = performance.now() - start;
      const heapDelta = process.memoryUsage().heapUsed - heapBefore;
      assert.equal(board.time, scenario.target);
      assert.equal(count, scenario.expectedCount ?? 1);
      assert.equal(sum, scenario.expectedSum ?? scenario.expected);
      assert.equal(last, scenario.expected);
      if (repeat >= warmups) {
        timings.push(elapsed);
        heapDeltas.push(heapDelta);
      }
    } finally {
      board.dispose();
    }
  }
  timings.sort((a, b) => a - b);
  heapDeltas.sort((a, b) => a - b);
  const percentile = (values, p) => values[Math.ceil(values.length * p) - 1];
  const medianMs = percentile(timings, 0.5);
  results.push({
    name: scenario.name,
    operations: scenario.operations,
    medianMs,
    p95Ms: percentile(timings, 0.95),
    p99Ms: percentile(timings, 0.99),
    operationsPerSecond: (scenario.operations * 1_000) / medianMs,
    medianHeapDeltaBytes: percentile(heapDeltas, 0.5),
  });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      v8: process.versions.v8,
      warmups,
      samples,
      heapMetric: 'Observed heap delta, including automatic GC; not peak memory',
      results,
    },
    null,
    2,
  ),
);
