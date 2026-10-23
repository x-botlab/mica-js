/**
 * M3-class DBT throughput benchmark (issue #150).
 *
 * The workload models an ARM Cortex-M3 style guest running from a 16-block
 * ring of translated basic blocks:
 *
 *  - 16 × u32 registers, NZCV flags and 256 KiB of byte-addressed RAM;
 *  - a `blocks` provider keyed by guest pc decodes each basic block from a
 *    read-only flash image and tail-dispatches `blocks(nextPc)`;
 *  - a cycle budget (`sliceEnd`) batches `event.at` calls: the host regains
 *    control once per cycle slice, teaching-mcu style.
 *
 * One `step` invocation executes exactly `SLICE` guest instructions, so the
 * reported ops/sec converts directly to guest M inst/s:
 *
 *     M inst/s = hz × (SLICE / 1_000_000)
 *
 * The JIT entry runs 1,024,000 guest instructions per op; the reference
 * interpreter is much slower, so its comparison uses a 1,024-instruction
 * slice of the same guest loop.
 */
import { test } from 'vitest';
import { createIRInterpreter, createIRJIT } from '../src/index';
import { jitInternals } from '../src/jit-runtime';
import type { IRJITInternals } from '../src/jit-runtime';
import { buildRingFirmware } from './m3/firmware';
import { createM3Fixture, prepareFixture } from './m3/model';
import type { M3Fixture } from './m3/model';

const BLOCK_COUNT = 16;
/** 8,000 laps of the 128-instruction ring. */
const JIT_SLICE = 1_024_000;
/** 8 laps — enough to average out host overhead in the reference engine. */
const REFERENCE_SLICE = 1_024;

/** J0 throughput target: 72 MHz of guest instructions (≥ 72 M inst/s). */
const TARGET_MIPS = 72;

const firmware = buildRingFirmware(BLOCK_COUNT);

const jitFixture = createM3Fixture({ firmware, slice: JIT_SLICE });
const jit = createIRJIT(jitFixture.module, {
  validation: jitFixture.validation,
  maxSteps: Number.MAX_SAFE_INTEGER,
  eventHost: jitFixture.eventHost,
});
prepareFixture(jit, jitFixture);
assertJitTier(jit, jitFixture);

const referenceFixture = createM3Fixture({ firmware, slice: REFERENCE_SLICE });
const reference = createIRInterpreter(referenceFixture.module, {
  validation: referenceFixture.validation,
  maxSteps: Number.MAX_SAFE_INTEGER,
  eventHost: referenceFixture.eventHost,
});
prepareFixture(reference, referenceFixture);

const jitMillionsPerOp = JIT_SLICE / 1_000_000;
const referenceMillionsPerOp = REFERENCE_SLICE / 1_000_000;

console.log(
  `[m3.bench] jit-default: 1 op = ${JIT_SLICE.toLocaleString()} guest instructions ` +
    `→ M inst/s = hz × ${jitMillionsPerOp}`,
);
console.log(
  `[m3.bench] reference:   1 op = ${REFERENCE_SLICE.toLocaleString()} guest instructions ` +
    `→ M inst/s = hz × ${referenceMillionsPerOp}`,
);

const JIT_BENCH = `jit-default / ring / slice=${JIT_SLICE} (M inst/s = hz × ${jitMillionsPerOp})`;
const REFERENCE_BENCH = `reference / ring / slice=${REFERENCE_SLICE} (M inst/s = hz × ${referenceMillionsPerOp})`;

test(`M3-class DBT: ${BLOCK_COUNT} blocks × ${firmware.blockInstructions} guest instructions`, async ({
  bench,
}) => {
  const results = await bench.compare(
    bench(JIT_BENCH, () => {
      jit.execute(jitFixture.step, [], jitFixture.context);
    }),
    bench(REFERENCE_BENCH, () => {
      reference.execute(referenceFixture.step, [], referenceFixture.context);
    }),
    { time: 1_500, warmupTime: 300 },
  );

  const jitMips = (results.get(JIT_BENCH).throughput.mean * JIT_SLICE) / 1_000_000;
  const referenceMips =
    (results.get(REFERENCE_BENCH).throughput.mean * REFERENCE_SLICE) / 1_000_000;
  console.log(
    `[m3.bench] measured: jit-default ${jitMips.toFixed(3)} M inst/s, ` +
      `reference ${referenceMips.toFixed(3)} M inst/s (${(jitMips / referenceMips).toFixed(1)}×)`,
  );
  console.log(
    `[m3.bench] target: ≥ ${TARGET_MIPS} M inst/s; ` +
      `jit-default reaches ${((jitMips / TARGET_MIPS) * 100).toFixed(1)}%`,
  );
  if (!(jitMips > referenceMips)) {
    throw new Error('M3 benchmark lost the JIT tier; check codegen availability');
  }
});

function assertJitTier(runtime: ReturnType<typeof createIRJIT>, fixture: M3Fixture): void {
  const stats = (runtime as unknown as Record<symbol, IRJITInternals | undefined>)[jitInternals];
  if (stats === undefined || stats.mode !== 'jit') {
    throw new Error('M3 benchmark requires the compiled JIT tier (codegen is unavailable)');
  }
  if (stats.compiledArtifacts < fixture.blockPcs.length) {
    throw new Error(
      `M3 benchmark expected ${fixture.blockPcs.length} compiled artifacts, saw ${stats.compiledArtifacts}`,
    );
  }
}
