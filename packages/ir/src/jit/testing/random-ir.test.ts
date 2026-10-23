import { describe, expect, it } from 'vitest';
import { validateIR } from '../../validate';
import type { RandomProfile } from './random-ir';
import { mulberry32, randomProgram } from './random-ir';

const PROFILES: readonly RandomProfile[] = [
  'default',
  'float-heavy',
  'provider-heavy',
  'deep-recursion',
  'storage-heavy',
];

function operations(program: ReturnType<typeof randomProgram>): readonly string[] {
  const names: string[] = [];
  for (const fn of program.module.functions) {
    for (const block of fn.body?.blocks ?? []) {
      for (const instruction of block.instructions) names.push(instruction.op);
      if (block.terminator !== undefined) names.push(block.terminator.kind);
    }
  }
  return names;
}

describe('random IR generator', () => {
  it('is deterministic for one seed and profile', () => {
    const first = randomProgram({ seed: 42, profile: 'default' });
    const second = randomProgram({ seed: 42, profile: 'default' });
    expect(second.summary).toEqual(first.summary);
    expect(operations(second)).toEqual(operations(first));
    expect(second.invocations).toEqual(first.invocations);
  });

  it('produces different programs for different seeds', () => {
    const first = operations(randomProgram({ seed: 1 }));
    const second = operations(randomProgram({ seed: 2 }));
    expect(second).not.toEqual(first);
  });

  it('keeps mulberry32 reproducible and in [0, 1)', () => {
    const first = mulberry32(123);
    const second = mulberry32(123);
    for (let index = 0; index < 32; index += 1) {
      const value = first();
      expect(value).toBe(second());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it.each(PROFILES)('generates valid programs for all 80 seeds (%s)', (profile) => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const program = randomProgram({ seed, profile });
      const validation = validateIR(program.module, program.validation);
      expect(
        validation.diagnostics.map((diagnostic) => diagnostic.message),
        `seed=${seed} profile=${profile}`,
      ).toEqual([]);
      expect(validation.ok, `seed=${seed} profile=${profile}`).toBe(true);
      expect(program.summary.instructions, `seed=${seed}`).toBeGreaterThan(0);
      expect(program.invocations.length).toBeGreaterThan(0);
    }
  });

  it('covers the advertised instruction surface across seeds', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 120; seed += 1) {
      for (const operation of operations(randomProgram({ seed }))) seen.add(operation);
    }
    for (const expected of [
      'const',
      'const.bits',
      'bool.not',
      'bool.and',
      'bool.or',
      'bool.xor',
      'int.add',
      'int.sub',
      'int.mul',
      'int.div',
      'int.rem',
      'int.and',
      'int.or',
      'int.xor',
      'int.not',
      'int.shl',
      'int.lshr',
      'int.ashr',
      'int.cmp',
      'int.zext',
      'int.sext',
      'int.trunc',
      'int.reinterpret',
      'float.add',
      'float.sub',
      'float.mul',
      'float.div',
      'float.fma',
      'float.cmp',
      'float.isNaN',
      'float.isFinite',
      'convert.intToFloat',
      'convert.floatToInt',
      'convert.float',
      'bitcast',
      'select',
      'state.load',
      'state.store',
      'array.load',
      'array.store',
      'bytes.load',
      'bytes.store',
      'bytes.copy',
      'resource.update_bytes',
      'resource.fill_bytes',
      'call',
      'jump',
      'branch',
      'dispatch',
      'return',
    ]) {
      expect(seen.has(expected), `expected generator to emit ${expected}`).toBe(true);
    }
  });

  it('emits loops, diamonds and provider dispatches', () => {
    let loops = 0;
    let branches = 0;
    let providers = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const program = randomProgram({ seed });
      loops += program.summary.loops;
      branches += program.summary.branches;
      providers += program.summary.providers;
    }
    expect(loops).toBeGreaterThan(0);
    expect(branches).toBeGreaterThan(0);
    expect(providers).toBe(120);
  });

  it('honours explicit instruction and depth bounds', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const program = randomProgram({
        seed,
        instructionRange: [8, 8],
        maxDepth: 0,
        controlFlow: false,
        provider: false,
        storage: false,
      });
      expect(program.summary.instructions).toBeLessThanOrEqual(16);
      expect(program.summary.loops).toBe(0);
      expect(program.summary.branches).toBe(0);
      expect(program.summary.providers).toBe(0);
    }
  });

  it('can omit control flow, storage and providers', () => {
    const program = randomProgram({
      seed: 7,
      controlFlow: false,
      storage: false,
      provider: false,
    });
    expect(program.summary.providers).toBe(0);
    expect(program.summary.loops).toBe(0);
    expect(program.summary.branches).toBe(0);
    expect(validateIR(program.module, program.validation).ok).toBe(true);
  });
});
