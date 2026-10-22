import { WIDGET_RUNTIME_SOURCE } from '../internal/runtime-source';
import type { WidgetSandbox, WidgetSandboxFactory } from './types';

/**
 * Default sandbox over `@mica-js/sandbox`.
 *
 * The import stays dynamic on purpose: consumers that inject their own sandbox never load it, and
 * Node-side consumers can import this package without a DOM.
 */
export const createDefaultWidgetSandbox: WidgetSandboxFactory = async (options) => {
  const { createSandbox } = await import('@mica-js/sandbox');
  const handle = await createSandbox({
    name: 'mica-widget-runtime',
    source: { type: 'module', code: WIDGET_RUNTIME_SOURCE },
    captureConsole: false,
    ...(options.container === undefined ? {} : { container: options.container }),
  });

  return {
    get state() {
      return handle.state;
    },
    call: (method, ...args) => handle.request(method, args),
    on: (type, listener) => handle.on(type, listener),
    terminate: (reason) => handle.terminate(reason),
  } satisfies WidgetSandbox;
};
