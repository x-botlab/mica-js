import { defineRpcService } from '@mica-js/core/rpc';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured, cloneable log data shared by every execution environment. */
export interface LogRecord {
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly data: readonly unknown[];
}

export interface LoggerService {
  write(record: LogRecord): void;
}

export const loggerService = defineRpcService<LoggerService>('logger');
