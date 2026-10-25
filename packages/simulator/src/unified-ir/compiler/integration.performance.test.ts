/**
 * Compiler performance observations.
 *
 * Reports how long `compileCircuit` takes and how fast the compiled batch loop
 * runs for the MCU + LED scene.
 *
 * This file only reports numbers: there are no thresholds and no assertions,
 * because performance must never decide whether a test run passes. It is
 * excluded from `pnpm test` and runs on demand with `pnpm test:perf`.
 * Compilation correctness is covered by `compiler.test.ts` and
 * `integration.test.ts`.
 */
import { performance } from 'node:perf_hooks';
import { createIRJIT } from '@mica-js/ir';
import type { IRExecutionContext, IRInterpreter } from '@mica-js/ir';
import { describe, it } from 'vitest';
import {
  compileCircuit,
  createLedDescription,
  createMcuDescription,
  type CircuitCompilationInput,
  type CompiledCircuit,
} from './index';

const CONTEXT: IRExecutionContext = Object.freeze({
  instanceId: 'unified-ir-compiler-perf',
  virtualTime: 0,
});

function createRuntime(compiled: CompiledCircuit): IRInterpreter {
  return createIRJIT(compiled.module, {
    validation: compiled.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
    jit: { tierUpThreshold: 0 },
  });
}

function mcuLedInput(): CircuitCompilationInput {
  return {
    devices: [
      { id: 'mcu1', type: 'teaching-mcu', description: createMcuDescription() },
      { id: 'led1', type: 'ideal-led', description: createLedDescription() },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  };
}

describe('CompiledCircuit performance', () => {
  it('reports compile time and batch tick cost', () => {
    const compileStart = performance.now();
    const compiled = compileCircuit(mcuLedInput());
    const compileMs = performance.now() - compileStart;

    const jit = createRuntime(compiled);
    jit.execute(compiled.entryPoints.refs.initialize, [], CONTEXT);
    jit.execute(compiled.entryPoints.refs.tick, [], CONTEXT);
    // Warm the compiled loop so the measurement excludes code generation.
    jit.execute(compiled.entryPoints.refs.batch, [100], CONTEXT);

    const ticks = 1000;
    const start = performance.now();
    jit.execute(compiled.entryPoints.refs.batch, [ticks], CONTEXT);
    const elapsedMs = performance.now() - start;

    console.log(
      `compile: ${compileMs.toFixed(3)} ms, batch: ${((elapsedMs * 1e6) / ticks).toFixed(0)} ns/tick ` +
        `(${ticks} ticks in ${elapsedMs.toFixed(3)} ms)`,
    );
  });
});
