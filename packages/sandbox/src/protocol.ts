/**
 * Message protocol between the host page and the sandbox frame. Control messages stay between the
 * host and frame; ordinary messages are forwarded to the real Worker without a guest envelope.
 */

export interface FrameBootMessage {
  type: 'mica:boot';
  /** Self-contained single-file worker script produced by the caller's bundler. */
  code: string;
}

export interface FrameTerminateMessage {
  type: 'mica:terminate';
  control: true;
}

export interface FrameReadyMessage {
  type: 'mica:frame-ready';
}

/** The frame created the worker and posted the startup message to it. */
export interface WorkerStartedMessage {
  type: 'mica:worker-started';
}

export interface FrameErrorMessage {
  type: 'mica:frame-error';
  message: string;
}

/** Forwarded `worker.onerror` payload; the guest has no error channel of its own. */
export interface WorkerErrorMessage {
  type: 'mica:worker-error';
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}

export interface WorkerMessageMessage {
  type: 'mica:worker-message';
  data: unknown;
}

export interface WorkerMessageErrorMessage {
  type: 'mica:worker-messageerror';
  data?: unknown;
}

export type HostToFrameMessage = FrameBootMessage | FrameTerminateMessage;

export type FrameToHostMessage =
  | FrameReadyMessage
  | WorkerStartedMessage
  | FrameErrorMessage
  | WorkerErrorMessage
  | WorkerMessageMessage
  | WorkerMessageErrorMessage;
