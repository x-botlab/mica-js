/** Message protocol shared by the host page and the guest worker. */

export type SandboxLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

/** Guest code after URL sources have been fetched by the host. */
export interface GuestSourcePayload {
  type: 'module' | 'script';
  code: string;
  globalName: string;
}

export interface FrameBootMessage {
  type: 'mica:boot';
  id: string;
  name: string;
  runtime: string;
  source: GuestSourcePayload;
  captureConsole: boolean;
  port: MessagePort;
}

export interface FrameTerminateMessage {
  type: 'mica:terminate';
}

export interface FrameReadyMessage {
  type: 'mica:frame-ready';
}

export interface FrameErrorMessage {
  type: 'mica:frame-error';
  message: string;
}

export interface WorkerReadyMessage {
  type: 'mica:worker-ready';
}

export type HostToFrameMessage = FrameBootMessage | FrameTerminateMessage;

export type FrameToHostMessage = FrameReadyMessage | FrameErrorMessage | WorkerReadyMessage;

export interface WorkerInitMessage {
  type: 'mica:init';
  id: string;
  name: string;
  port: MessagePort;
  source: GuestSourcePayload;
  captureConsole: boolean;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = { name: error.name, message: error.message };
    if (typeof error.stack === 'string') serialized.stack = error.stack;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') serialized.code = code;
    return serialized;
  }

  if (typeof error === 'string') return { name: 'Error', message: error };

  let message: string;
  try {
    message = JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { name: 'Error', message };
}

/**
 * Makes arbitrary values safe to send over `postMessage`: structured-cloneable values are kept,
 * everything else (functions, DOM nodes, class instances with methods, ...) is described.
 */
export function toCloneableParts(parts: readonly unknown[]): unknown[] {
  return parts.map((part) => {
    try {
      return structuredClone(part);
    } catch {
      return describeValue(part);
    }
  });
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`;
    case 'symbol':
      return value.toString();
    case 'bigint':
      return `${value}n`;
    case 'object': {
      const name = (value as object).constructor?.name;
      return name ? `[${name}]` : '[Object]';
    }
    default:
      return String(value);
  }
}
