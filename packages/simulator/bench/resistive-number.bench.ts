import { createIRInterpreter, createIRJIT, createIRModule, toNumber } from '@mica-js/ir';
import type { Value } from '@mica-js/ir';
import { expect, test } from 'vitest';
import { createModuleValidation } from '../src/unified-ir/validation';

// Three nodes with 1 mS links A-B/B-C and 3/2/2 mS source conductances.
// G = [[4,-1,0],[-1,4,-1],[0,-1,3]] mS; its inverse is exact below.
const INVERSE = [11, 3, 1, 3, 12, 4, 1, 4, 15].map((value) => value / 41);
const TICKS = 1_000_000;
const ROUNDS = 9;
const INITIAL = [0, 1.8, 0.7];

interface Snapshot {
  readonly drive: readonly number[];
  readonly voltage: readonly number[];
  readonly digital: readonly boolean[];
}

interface Probe {
  run(count: number): void;
  snapshot(): Snapshot;
}

function nativeProbe(): Probe {
  const drive = new Float64Array(INITIAL);
  const voltage = new Float64Array(3);
  const digital = new Uint8Array(3);
  const [a, b, c, d, e, f, g, h, i] = INVERSE as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    run(count) {
      for (let tick = 0; tick < count; tick += 1) {
        drive[0] = 3.3 - drive[0]!;
        const x = drive[0]! * 3;
        const y = drive[1]! * 2;
        const z = drive[2]! * 2;
        voltage[0] = 0 + a * x + b * y + c * z;
        voltage[1] = 0 + d * x + e * y + f * z;
        voltage[2] = 0 + g * x + h * y + i * z;
        digital[0] = voltage[0]! > 1.65 ? 1 : 0;
        digital[1] = voltage[1]! > 1.65 ? 1 : 0;
        digital[2] = voltage[2]! > 1.65 ? 1 : 0;
      }
    },
    snapshot: () => ({
      drive: [...drive],
      voltage: [...voltage],
      digital: Array.from(digital, (value) => value !== 0),
    }),
  };
}

function irProbe(engine: 'jit' | 'reference'): Probe {
  const module = createIRModule();
  const drive = module.array('drive', 'f64', INITIAL);
  const voltage = module.array('voltage', 'f64', [0, 0, 0]);
  const digital = module.array('digital', 'bool', [false, false, false]);
  const batch = module.func('batch', { params: ['u32'], results: [] });
  batch.body((b, [count]) => {
    const header = b.block(['u32']);
    const loop = b.block(['u32']);
    const done = b.block([]);
    b.jump(header, [b.const('u32', 0)]);
    b.at(header, (ib, [tick]) =>
      ib.branch(
        ib.int.cmp('lt', tick, count),
        { target: loop, args: [tick] },
        { target: done, args: [] },
      ),
    );
    b.at(loop, (ib, [tick]) => {
      const index = (value: number) => ib.const('u32', value);
      const number = (value: number) => ib.const('f64', value);
      ib.array.store(drive, index(0), ib.float.sub(number(3.3), ib.array.load(drive, index(0))));
      const rhs = [3, 2, 2].map((scale, at) =>
        ib.float.mul(ib.array.load(drive, index(at)), number(scale)),
      );
      for (let row = 0; row < 3; row += 1) {
        let sum: Value<'f64'> = number(0);
        for (let column = 0; column < 3; column += 1) {
          sum = ib.float.add(sum, ib.float.mul(number(INVERSE[row * 3 + column]!), rhs[column]!));
        }
        ib.array.store(voltage, index(row), sum);
      }
      for (let row = 0; row < 3; row += 1) {
        ib.array.store(
          digital,
          index(row),
          ib.float.cmp('gt', ib.array.load(voltage, index(row)), number(1.65)),
        );
      }
      ib.jump(header, [ib.int.add(tick, index(1))]);
    });
    b.at(done, (ib) => ib.return([]));
  });
  const options = { validation: createModuleValidation(module), maxSteps: Number.MAX_SAFE_INTEGER };
  const runtime =
    engine === 'jit'
      ? createIRJIT(module, { ...options, jit: { tierUpThreshold: 0 } })
      : createIRInterpreter(module, options);
  const context = { instanceId: 'resistive-number-probe', virtualTime: 0 };
  return {
    run: (count) => {
      runtime.execute(batch, [count], context);
    },
    snapshot: () => ({
      drive: INITIAL.map((_, at) => toNumber(runtime.storage.loadArray(drive, at))),
      voltage: INITIAL.map((_, at) => toNumber(runtime.storage.loadArray(voltage, at))),
      digital: INITIAL.map((_, at) => runtime.storage.loadArray(digital, at)),
    }),
  };
}

function assertKcl(snapshot: Snapshot): void {
  const [a, b, c] = snapshot.voltage as [number, number, number];
  const rhs = snapshot.drive.map((value, at) => value * [3, 2, 2][at]!);
  for (const residual of [4 * a - b - rhs[0]!, -a + 4 * b - c - rhs[1]!, -b + 3 * c - rhs[2]!]) {
    expect(Math.abs(residual)).toBeLessThan(1e-12);
  }
}

function assertEquivalent(actual: Snapshot, expected: Snapshot): void {
  expect(actual.drive).toEqual(expected.drive);
  expect(actual.digital).toEqual(expected.digital);
  for (let at = 0; at < 3; at += 1) {
    expect(actual.voltage[at]).toBeCloseTo(expected.voltage[at]!, 12);
  }
  assertKcl(actual);
}

test('native, reference and JIT agree across odd/even and split batches', () => {
  const native = nativeProbe();
  const jit = irProbe('jit');
  const reference = irProbe('reference');
  const singleBatch = nativeProbe();
  let total = 0;
  for (const count of [1, 1, 3, 8, 0, 17, 2]) {
    total += count;
    for (const probe of [native, jit, reference]) probe.run(count);
    const expected = reference.snapshot();
    assertEquivalent(native.snapshot(), expected);
    assertEquivalent(jit.snapshot(), expected);
  }
  singleBatch.run(total);
  assertEquivalent(native.snapshot(), singleBatch.snapshot());
});

test('three-node solve: identical fixed matrix, source updates and output stores', () => {
  const probes = [
    { name: 'IR f64 JIT', probe: irProbe('jit'), samples: [] as number[] },
    { name: 'native Float64Array', probe: nativeProbe(), samples: [] as number[] },
  ];
  for (const { probe } of probes) {
    for (let warmup = 0; warmup < 5; warmup += 1) probe.run(100_000);
  }
  // Alternate order to reduce systematic warmup/thermal bias. No reads/assertions in timed regions.
  for (let round = 0; round < ROUNDS; round += 1) {
    const order = round % 2 === 0 ? probes : [...probes].reverse();
    for (const { probe, samples } of order) {
      const start = performance.now();
      probe.run(TICKS);
      samples.push(((performance.now() - start) * 1e6) / TICKS);
      assertKcl(probe.snapshot());
    }
  }
  assertEquivalent(probes[0]!.probe.snapshot(), probes[1]!.probe.snapshot());
  console.log(
    `node=${process.version} platform=${process.platform}/${process.arch}; ticks=${TICKS}; rounds=${ROUNDS}`,
  );
  for (const { name, samples } of probes) {
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(
      `${name}: best=${sorted[0]!.toFixed(2)} median=${sorted[Math.floor(ROUNDS / 2)]!.toFixed(2)} ns/tick; samples=${samples.map((n) => n.toFixed(2)).join(',')}`,
    );
  }
}, 120_000);
