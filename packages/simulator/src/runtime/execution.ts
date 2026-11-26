import {
  compileBody,
  compileComputation,
  compileResumableBody,
  compileSynchronousBody,
  type CompiledBody,
  type ExecutionHost,
  type ResumableFrame,
  type ResumableProgram,
  type SynchronousProgram,
} from '@mica-js/compiler';
import type { ComputationIR, DeviceIR, RegionIR } from '@mica-js/device-model';
import type { Instance } from './instance';

const compiledBodies = new WeakMap<RegionIR, CompiledBody>();
/**
 * Deterministic generic-body diagnostics. Translation no longer compiles a body eagerly, so a
 * Direct-resident workload must leave `compiled` unchanged.
 */
const genericBodies = { compiled: 0, reused: 0 };
export interface GenericBodyStats {
  readonly compiled: number;
  readonly reused: number;
}
export function genericBodyStats(): GenericBodyStats {
  return genericBodies;
}
const resumablePrograms = new WeakMap<RegionIR, ResumableProgram | null>();
const compiledComputations = new WeakMap<ComputationIR, (host: ExecutionHost) => unknown>();
/**
 * Synchronous programs are instance independent, but their static function resolution
 * belongs to one device model. The outer key prevents reusing a root region compiled
 * against another model's function table; `null` records a whole-body fallback.
 */
const synchronousPrograms = new WeakMap<DeviceIR, WeakMap<RegionIR, SynchronousProgram | null>>();
export const MAX_TIME = 7_200_000_000_000_000;
export function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value))
    throw new TypeError('Time must be a finite integer');
  if (value < 0 || value > MAX_TIME) throw new RangeError('Time out of range');
  return value === 0 ? 0 : value;
}
export function body(region: RegionIR): CompiledBody {
  let result = compiledBodies.get(region);
  if (!result) {
    result = compileBody(region);
    compiledBodies.set(region, result);
    genericBodies.compiled++;
  } else genericBodies.reused++;
  return result;
}
/**
 * Compile one reaction body for one device model. Static callees are resolved from the
 * same declaration environment the generator uses. A compiler decline is cached as a
 * whole-body fallback; execution errors are never caught here and never replay effects.
 */
export function synchronousBody(
  instance: Instance,
  region: RegionIR,
): SynchronousProgram | undefined {
  const model = instance.entry.model;
  let cache = synchronousPrograms.get(model);
  if (cache === undefined) {
    cache = new WeakMap();
    synchronousPrograms.set(model, cache);
  }
  const cached = cache.get(region);
  if (cached !== undefined) return cached ?? undefined;
  const program = compileSynchronousBody(region, {
    bindResources: true,
    resolveFunction: (name) => {
      const declaration = instance.declarations.get(name);
      return declaration?.kind === 'function' ? declaration.body : undefined;
    },
  });
  cache.set(region, program ?? null);
  return program;
}
export function resumable(region: RegionIR): ResumableProgram | undefined {
  let result = resumablePrograms.get(region);
  if (result === undefined) {
    result = compileResumableBody(region, { bindResources: true }) ?? null;
    resumablePrograms.set(region, result);
  }
  return result ?? undefined;
}
export function frame(program: ResumableProgram): ResumableFrame {
  return {
    pc: program.start,
    slots: new Array<unknown>(program.slotCount),
    kind: 0,
    duration: 0,
    channel: '',
    value: undefined,
  };
}
export function computation(value: ComputationIR, host: ExecutionHost): unknown {
  let result = compiledComputations.get(value);
  if (!result) {
    result = compileComputation(value);
    compiledComputations.set(value, result);
  }
  return result(host);
}
