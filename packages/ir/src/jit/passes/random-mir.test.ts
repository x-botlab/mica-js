import { describe, it } from 'vitest';
import { prepareEngine } from '../../engine-setup';
import { verifyMIR } from '../verify';
import { createLowerContext, lowerFunction } from '../mir';
import type { MFunction } from '../mir';
import { randomProgram } from '../testing/random-ir';
import type { RandomProfile } from '../testing/random-ir';
import { optimizeFunction as dce } from './dce';
import { optimizeFunction as gvn } from './gvn';
import { optimizeFunction as licm } from './licm';
import { optimizeFunction as range } from './range';
import { optimizeFunction as sccp } from './sccp';
import type { OptimizeOptions } from './util';

const PROFILES: readonly RandomProfile[] = [
  'default',
  'float-heavy',
  'provider-heavy',
  'deep-recursion',
  'storage-heavy',
];

const PASSES: readonly (readonly [
  string,
  (fn: MFunction, options: OptimizeOptions) => MFunction,
])[] = [
  ['sccp', sccp],
  ['gvn', gvn],
  ['range', range],
  ['licm', licm],
  ['dce', dce],
];

function check(seed: number, profile: RandomProfile): void {
  const program = randomProgram({ seed, profile });
  const setup = prepareEngine(program.module, {
    validation: program.validation,
    ...(program.maxSteps === undefined ? {} : { maxSteps: program.maxSteps }),
  });
  const lower = createLowerContext(setup.model, [...(setup.executors?.keys() ?? [])]);
  for (let index = 0; index < setup.model.functions.length; index += 1) {
    const definition = setup.model.functions[index]!;
    let current = lowerFunction(lower, definition, index, definition.name);
    for (const [name, pass] of PASSES) {
      current = pass(current, { constants: lower.constants });
      try {
        verifyMIR(current);
      } catch (error) {
        throw new Error(
          `${name} failed on seed=${seed} profile=${profile} function=${index}: ${
            (error as Error).message
          }`,
          { cause: error },
        );
      }
    }
  }
}

describe('optimization pipeline on random MIR', () => {
  it.each(PROFILES)('keeps %s programs verifier-clean', (profile) => {
    for (let seed = 1; seed <= 20; seed += 1) check(seed, profile);
  });
});
