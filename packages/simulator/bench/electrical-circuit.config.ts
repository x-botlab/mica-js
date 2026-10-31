import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

const reference = process.env['MICA_BENCH_REF'];
const compilerFiles = [
  'resistive-solver.ts',
  'electrical-operations.ts',
  'floating-input.ts',
  'mainloop-gen.ts',
];
const baseline: Plugin = {
  name: 'electrical-benchmark-reference',
  enforce: 'pre',
  load(id) {
    if (reference === undefined) return null;
    const path = id.split('?')[0]!.replaceAll('\\', '/');
    const file = compilerFiles.find((name) =>
      path.endsWith(`/packages/simulator/src/unified-ir/compiler/${name}`),
    );
    if (file === undefined) return null;
    return execFileSync(
      'git',
      ['show', `${reference}:packages/simulator/src/unified-ir/compiler/${file}`],
      {
        cwd: resolve(import.meta.dirname, '..', '..', '..'),
        encoding: 'utf8',
        windowsHide: true,
      },
    );
  },
};

// Plain timed loops over the public `Circuit` facade; no Vitest bench harness and no package build.
export default defineConfig({
  plugins: reference === undefined ? [] : [baseline],
  resolve: { conditions: ['source', 'module', 'development|production'] },
  ssr: { resolve: { conditions: ['source', 'module', 'development|production'] } },
  test: {
    environment: 'node',
    include: ['bench/electrical-circuit.bench.ts'],
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
