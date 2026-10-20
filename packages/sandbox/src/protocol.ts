/** Message protocol shared by the host page and the guest worker. */

export type SandboxLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

/** Size of the drawing surface, in device pixels. */
export interface SurfaceGeometry {
  width: number;
  height: number;
  dpr: number;
}

export interface SandboxFeatures {
  wasm: boolean;
  offscreenCanvas: boolean;
  webgl2: boolean;
}

/** What the guest reports back once `setup()` has finished. */
export interface SandboxInfo {
  name: string;
  origin: string;
  userAgent: string;
  guestMethods: string[];
  features: SandboxFeatures;
}

export type Envelope =
  | { k: 'ready'; info: SandboxInfo }
  | { k: 'boot-error'; error: SerializedError }
  | { k: 'request'; id: number; method: string; args: unknown[] }
  | { k: 'response'; id: number; ok: true; value: unknown }
  | { k: 'response'; id: number; ok: false; error: SerializedError }
  | { k: 'event'; type: string; payload: unknown }
  | { k: 'notify'; method: string; args: unknown[] }
  | { k: 'log'; level: SandboxLogLevel; parts: unknown[] }
  | { k: 'guest-error'; error: SerializedError };

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
  surface: SurfaceGeometry;
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

export type HostToFrameMessage = FrameBootMessage | FrameTerminateMessage;

export type FrameToHostMessage = FrameReadyMessage | FrameErrorMessage;

export interface WorkerInitMessage {
  type: 'mica:init';
  id: string;
  name: string;
  port: MessagePort;
  source: GuestSourcePayload;
  surface: SurfaceGeometry;
  captureConsole: boolean;
}

const ENVELOPE_KINDS = new Set([
  'ready',
  'boot-error',
  'request',
  'response',
  'event',
  'notify',
  'log',
  'guest-error',
]);

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { k?: unknown }).k;
  return typeof kind === 'string' && ENVELOPE_KINDS.has(kind);
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
