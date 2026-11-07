import {
  compileBody,
  compileComputation,
  compileResumableBody,
  type CompiledBody,
  type ExecutionHost,
  type ResumableFrame,
  type ResumableProgram,
} from '@mica-js/compiler';
import type { ComputationIR, RegionIR } from '@mica-js/device-model';

const compiledBodies = new WeakMap<RegionIR, CompiledBody>();
const resumablePrograms = new WeakMap<RegionIR, ResumableProgram | null>();
const compiledComputations = new WeakMap<ComputationIR, (host: ExecutionHost) => unknown>();
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
  }
  return result;
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
