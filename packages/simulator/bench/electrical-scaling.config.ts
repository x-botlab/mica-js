import { defineConfig } from 'vitest/config';
import base from './electrical-circuit.config';

// Same harness as `electrical-circuit.config.ts` — including its optional
// `MICA_BENCH_REF` Git-source plugin — narrowed to the scaling netlist.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['bench/electrical-scaling.bench.ts'],
  },
});
