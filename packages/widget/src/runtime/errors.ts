/** Rejections the widget runtime produces before or around the guest boundary. */
export type WidgetRuntimeErrorCode =
  | 'widget/disposed'
  | 'widget/instance-exists'
  | 'widget/unknown-instance'
  | 'widget/unknown-port'
  | 'widget/invalid-instance'
  | 'widget/invalid-update'
  | 'widget/invalid-payload'
  | 'widget/invalid-direction'
  | 'widget/invalid-time'
  | 'widget/invalid-step'
  | 'widget/sandbox-failed';

/**
 * Typed rejection of one runtime call.
 *
 * Widget boundary failures (render, input, publish) become diagnostics instead; errors with this
 * type mean the caller asked for something the runtime cannot do.
 */
export class WidgetRuntimeError extends Error {
  readonly code: WidgetRuntimeErrorCode;

  constructor(code: WidgetRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WidgetRuntimeError';
    this.code = code;
  }
}
