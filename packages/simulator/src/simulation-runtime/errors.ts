/** Stable failure codes of the prepared-simulation runtime. */
export type SimulationRuntimeErrorCode =
  | 'invalid-input'
  | 'invalid-device'
  | 'unresolved-device'
  | 'unresolved-asset'
  | 'not-loaded'
  | 'disposed';

export interface ISimulationRuntimeErrorOptions {
  /** Device the failure belongs to, as the prepared simulation names it. */
  readonly deviceId?: string;
  readonly cause?: unknown;
}

/**
 * Error raised while preparing or driving a prepared simulation.
 *
 * The code is stable and machine-checkable; the message names the offending device, symbol or
 * asset so a caller can report it without parsing the cause chain.
 */
export class SimulationRuntimeError extends Error {
  override readonly name = 'SimulationRuntimeError';
  readonly code: SimulationRuntimeErrorCode;
  readonly deviceId: string | undefined;

  constructor(
    code: SimulationRuntimeErrorCode,
    message: string,
    options: ISimulationRuntimeErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.deviceId = options.deviceId;
  }
}

/** Message of one thrown value, used to give load failures a readable envelope. */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}
