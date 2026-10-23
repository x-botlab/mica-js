/**
 * Device-side mirror of `@mica-js/ir`'s test engine matrix.
 *
 * The IR helper is package-private, so device suites keep their own copy over
 * the public engine exports. `MICA_IR_ENGINES` narrows the matrix for local
 * debugging; the default is every engine.
 */
import { createIRInterpreter, createIRJIT } from '@mica-js/ir';
import type {
  IRInterpreter,
  IRInterpreterOptions,
  IRJITOptions,
  IRJITTuning,
  IRModule,
} from '@mica-js/ir';

export type EngineName = 'reference' | 'jit' | 'jit-heap' | 'jit-default';

export interface EngineCase {
  readonly name: EngineName;
  readonly create: (module: IRModule, options: IRInterpreterOptions) => IRInterpreter;
}

function withJit(options: IRInterpreterOptions, tuning: IRJITTuning): IRJITOptions {
  // Invalid options are forwarded untouched so `prepareEngine` keeps owning the
  // `invalid-options` error and its ordering.
  if (options === null || typeof options !== 'object') {
    return options as unknown as IRJITOptions;
  }
  const caller = (options as IRJITOptions).jit;
  return { ...options, jit: { ...tuning, ...caller } };
}

const ALL_ENGINES: readonly EngineCase[] = [
  {
    name: 'reference',
    create: (module: IRModule, options: IRInterpreterOptions) =>
      createIRInterpreter(module, options),
  },
  {
    name: 'jit',
    create: (module: IRModule, options: IRInterpreterOptions) =>
      createIRJIT(
        module,
        withJit(options, { tier: 'compiled', artifactWarmup: 0, debug: { verify: true } }),
      ),
  },
  {
    name: 'jit-heap',
    create: (module: IRModule, options: IRInterpreterOptions) =>
      createIRJIT(module, withJit(options, { tier: 'heap' })),
  },
  {
    name: 'jit-default',
    create: (module: IRModule, options: IRInterpreterOptions) => createIRJIT(module, options),
  },
];

function selectEngines(all: readonly EngineCase[]): readonly EngineCase[] {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const requested = env?.['MICA_IR_ENGINES'];
  if (requested === undefined) return all;
  const names = requested
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return all;
  const known = all.map((engine) => engine.name);
  const unknown = names.filter((name) => !known.includes(name as EngineName));
  if (unknown.length > 0) {
    throw new Error(
      `MICA_IR_ENGINES contains unknown engine(s): ${unknown.join(', ')}; expected one of ${known.join(', ')}`,
    );
  }
  return all.filter((engine) => names.includes(engine.name));
}

export const ENGINES: readonly EngineCase[] = selectEngines(ALL_ENGINES);
