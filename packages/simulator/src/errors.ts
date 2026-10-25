export type SimulatorErrorCode =
  | 'simulator/disposed'
  | 'simulator/not-ready'
  | 'simulator/invalid-delta'
  | 'simulator/unknown-target'
  | 'simulator/unknown-port'
  | 'simulator/device-load-failed'
  | 'simulator/instance-create-failed'
  | 'simulator/schematic-compile-failed';

export interface SimulatorErrorOptions {
  /** Symbol the failure belongs to, when it is attributable to one. */
  readonly symbol?: string;
  readonly cause?: unknown;
}

/** Error raised by the executor's host-facing calls. */
export class SimulatorError extends Error {
  override readonly name = 'SimulatorError';
  readonly code: SimulatorErrorCode;
  readonly symbol: string | undefined;

  constructor(code: SimulatorErrorCode, message: string, options: SimulatorErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.symbol = options.symbol;
  }
}
