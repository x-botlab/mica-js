/**
 * JIT public surface (J7). The implementation lives in `../jit-runtime.ts` so
 * the engine can be imported without pulling in the whole `jit/` directory.
 */
export { createIRJIT } from '../jit-runtime';
export type {
  IRJITCodegen,
  IRJITOptimization,
  IRJITOptions,
  IRJITTier,
  IRJITTuning,
  IRJITWarmup,
} from '../jit-runtime';
