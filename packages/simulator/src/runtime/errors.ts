import { BuildError } from '@mica-js/device-model';
import {
  SimulationError,
  type RuntimeDiagnostic,
  type RuntimeDiagnosticCode,
  type RuntimePhase,
} from '../types';
import { snapshot } from '../values';

function thenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
export class AsyncHookError extends TypeError {
  readonly code = 'ASYNC_HOOK_RESULT';
  constructor() {
    super('Device hooks must return synchronously');
  }
}
export class ElectricalParameterError extends RangeError {
  readonly code = 'INVALID_ELECTRICAL_PARAMETER';
}
export function electricalNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ElectricalParameterError('Electrical parameters must be finite numbers');
  return value;
}
export function acceptSync(value: unknown): void {
  if (thenable(value)) {
    void Promise.resolve(value).catch(() => {});
    throw new AsyncHookError();
  }
}
export function modelLocation(cause: unknown): Partial<Pick<RuntimeDiagnostic, 'path' | 'source'>> {
  if (!(cause instanceof BuildError)) return {};
  const diagnostic = cause.diagnostics[0];
  if (!diagnostic) return {};
  return {
    ...(diagnostic.path ? { path: Object.freeze([...diagnostic.path]) } : {}),
    ...(diagnostic.source
      ? { source: snapshot(diagnostic.source) as NonNullable<RuntimeDiagnostic['source']> }
      : {}),
  };
}
export function standalone(
  code: RuntimeDiagnosticCode,
  cause: unknown,
  phase: RuntimePhase,
): SimulationError {
  return new SimulationError(
    Object.freeze({
      code,
      message: cause instanceof Error ? cause.message : String(cause),
      phase,
      time: null,
      cause,
      ...modelLocation(cause),
      related: Object.freeze([]),
    }),
  );
}
