import {
  WIDGET_DELIVER_METHOD,
  WIDGET_ERROR_EVENT,
  WIDGET_FRAME_EVENT,
  WIDGET_LOAD_METHOD,
  WIDGET_MOUNT_METHOD,
  WIDGET_POINTER_METHOD,
  WIDGET_PUBLISH_EVENT,
  WIDGET_RESIZE_METHOD,
  WIDGET_SET_PROPERTIES_METHOD,
  WIDGET_UNMOUNT_METHOD,
} from '../runtime/protocol';
import type {
  WidgetErrorMessage,
  WidgetFrameMessage,
  WidgetPublishMessage,
} from '../runtime/protocol';
import type { WidgetInputEvent } from '../runtime/types';
import type { WidgetModule } from '../types';
import { WidgetLayerStore } from './layers';
import { createDefaultWidgetSandbox } from './sandbox';
import type {
  WidgetDiagnostic,
  WidgetDiagnosticCode,
  WidgetHost,
  WidgetHostOptions,
  WidgetLayers,
  WidgetMountSpec,
  WidgetPublish,
  WidgetSandbox,
  WidgetSandboxFactory,
  WidgetSize,
} from './types';

interface InstanceRecord {
  readonly widget: string;
  props: Readonly<Record<string, unknown>>;
}

/** Startup or shutdown failure; already reported, so call sites must not report it twice. */
class WidgetRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WidgetRuntimeError';
  }
}

/**
 * Creates the widget host.
 *
 * The sandbox starts lazily on the first `mount()` and every concurrent mount shares that one
 * startup, so a host with no instances never pays for an iframe and a worker. After a crash the
 * next `mount()` starts a fresh sandbox instead of rebuilding instances automatically.
 */
export function createWidgetHost(options: WidgetHostOptions): WidgetHost {
  return new WidgetHostImpl(options);
}

class WidgetHostImpl implements WidgetHost {
  readonly layers: WidgetLayers;

  readonly #provider: WidgetHostOptions['provider'];
  readonly #container: HTMLElement | undefined;
  readonly #onDiagnostic: ((diagnostic: WidgetDiagnostic) => void) | undefined;
  readonly #onPublish: ((publish: WidgetPublish) => void) | undefined;
  readonly #createSandbox: WidgetSandboxFactory;
  readonly #layerStore = new WidgetLayerStore();
  readonly #instances = new Map<string, InstanceRecord>();
  readonly #detachers: (() => void)[] = [];

  #sandbox: WidgetSandbox | undefined;
  #starting: Promise<WidgetSandbox> | undefined;
  #disposing: Promise<void> | undefined;
  #disposed = false;
  #dpr: number;

  constructor(options: WidgetHostOptions) {
    this.layers = this.#layerStore;
    this.#provider = options.provider;
    this.#container = options.container;
    this.#onDiagnostic = options.onDiagnostic;
    this.#onPublish = options.onPublish;
    this.#createSandbox = options.sandbox ?? createDefaultWidgetSandbox;
    this.#dpr = options.dpr ?? currentDevicePixelRatio();
  }

  async mount(spec: WidgetMountSpec): Promise<void> {
    const { instanceId, widget: ref } = spec;

    if (this.#disposed) {
      this.#report('widget/runtime-failed', 'The widget host is disposed.', {
        instanceId,
        widget: ref,
      });
      throw new WidgetRuntimeError('Widget host is disposed');
    }
    if (this.#instances.has(instanceId)) {
      this.#report(
        'widget/instance-exists',
        `Widget instance "${instanceId}" is already mounted.`,
        { instanceId, widget: ref },
      );
      return;
    }

    let module: WidgetModule | undefined;
    try {
      module = await this.#provider.resolve(ref);
    } catch (error) {
      this.#report(
        'widget/mount-failed',
        `Widget "${ref}" could not be resolved: ${describeError(error)}`,
        { instanceId, widget: ref },
      );
      throw error;
    }

    const resolved = module === undefined ? undefined : splitRef(ref);
    if (module === undefined || resolved === undefined) {
      this.#report(
        'widget/unknown-widget',
        module === undefined
          ? `No widget is registered as "${ref}".`
          : `Widget reference "${ref}" must use the "<package>:<widget>" form.`,
        { instanceId, widget: ref },
      );
      return;
    }

    const instance: InstanceRecord = { widget: ref, props: spec.props ?? {} };
    this.#instances.set(instanceId, instance);
    this.#layerStore.add({
      instanceId,
      width: spec.width,
      height: spec.height,
      dpr: this.#dpr,
    });

    let sandbox: WidgetSandbox;
    try {
      sandbox = await this.#ensureSandbox();
    } catch (error) {
      this.#forget(instanceId);
      throw error;
    }

    const layer = this.#layerStore.get(instanceId);
    if (!layer || !this.#instances.has(instanceId)) return;

    try {
      await sandbox.call(WIDGET_LOAD_METHOD, {
        packages: [
          {
            id: resolved.packageId,
            modules: {
              [resolved.widgetId]: { definition: module.definition, code: module.code },
            },
          },
        ],
      });
      if (!this.#instances.has(instanceId)) return;
      await sandbox.call(WIDGET_MOUNT_METHOD, {
        instanceId,
        widget: ref,
        width: layer.width,
        height: layer.height,
        dpr: layer.dpr,
        props: instance.props,
      });
    } catch (error) {
      this.#forget(instanceId);
      if (error instanceof WidgetRuntimeError) throw error;
      if (this.#isTerminated()) {
        this.#failRuntime('The widget sandbox terminated during mount.');
        throw error;
      }
      this.#report(
        'widget/mount-failed',
        `Widget "${ref}" failed to mount: ${describeError(error)}`,
        { instanceId, widget: ref },
      );
      throw error;
    }
  }

  unmount(instanceId: string): void {
    const instance = this.#instances.get(instanceId);
    if (!instance) {
      this.#report('widget/instance-not-found', `Widget instance "${instanceId}" is not mounted.`, {
        instanceId,
      });
      return;
    }

    this.#forget(instanceId);
    this.#fire(undefined, WIDGET_UNMOUNT_METHOD, [instanceId], instanceId);
  }

  update(instanceId: string, size: WidgetSize): void {
    if (!this.#requireInstance(instanceId)) return;
    this.#layerStore.setSize(instanceId, size.width, size.height);
    const layer = this.#layerStore.get(instanceId);
    if (!layer) return;
    this.#fire(
      'widget/render-failed',
      WIDGET_RESIZE_METHOD,
      [instanceId, layer.width, layer.height, layer.dpr],
      instanceId,
    );
  }

  setProperties(instanceId: string, props: Readonly<Record<string, unknown>>): void {
    const instance = this.#requireInstance(instanceId);
    if (!instance) return;
    instance.props = props;
    this.#fire(
      'widget/render-failed',
      WIDGET_SET_PROPERTIES_METHOD,
      [instanceId, props],
      instanceId,
    );
  }

  deliver(instanceId: string, port: string, payload: unknown, simTime: number): void {
    if (!this.#requireInstance(instanceId)) return;
    this.#fire(
      'widget/deliver-failed',
      WIDGET_DELIVER_METHOD,
      [instanceId, port, payload, simTime],
      instanceId,
    );
  }

  dispatch(instanceId: string, event: WidgetInputEvent): void {
    if (!this.#requireInstance(instanceId)) return;
    this.#fire('widget/deliver-failed', WIDGET_POINTER_METHOD, [instanceId, event], instanceId);
  }

  resize(dpr: number): void {
    if (!Number.isFinite(dpr) || dpr <= 0 || dpr === this.#dpr) return;
    this.#dpr = dpr;

    for (const layer of this.#layerStore.list()) {
      this.#layerStore.setDpr(layer.instanceId, dpr);
      this.#fire(
        'widget/render-failed',
        WIDGET_RESIZE_METHOD,
        [layer.instanceId, layer.width, layer.height, dpr],
        layer.instanceId,
      );
    }
  }

  dispose(): Promise<void> {
    const pending = this.#disposing ?? this.#shutdown();
    this.#disposing = pending;
    return pending;
  }

  #requireInstance(instanceId: string): InstanceRecord | undefined {
    const instance = this.#instances.get(instanceId);
    if (!instance) {
      this.#report('widget/instance-not-found', `Widget instance "${instanceId}" is not mounted.`, {
        instanceId,
      });
    }
    return instance;
  }

  /** Drops an instance that never became usable; the layer closes its bitmap. */
  #forget(instanceId: string): void {
    this.#instances.delete(instanceId);
    this.#layerStore.remove(instanceId);
  }

  #ensureSandbox(): Promise<WidgetSandbox> {
    if (this.#disposed) {
      return Promise.reject(new WidgetRuntimeError('Widget host is disposed'));
    }

    const existing = this.#sandbox;
    if (existing) {
      if (existing.state === 'terminated') {
        return Promise.reject(this.#failRuntime('The widget sandbox terminated unexpectedly.'));
      }
      return Promise.resolve(existing);
    }

    if (!this.#starting) {
      const pending = this.#createSandbox(
        this.#container === undefined ? {} : { container: this.#container },
      )
        .catch((error: unknown) => {
          throw this.#failRuntime(
            `The widget sandbox failed to start: ${describeError(error)}`,
            error,
          );
        })
        .then(async (sandbox: WidgetSandbox) => {
          if (this.#disposed) {
            await terminate(sandbox);
            throw new WidgetRuntimeError('Widget host is disposed');
          }
          this.#sandbox = sandbox;
          this.#attach(sandbox);
          return sandbox;
        });

      this.#starting = pending;
      const settle = (): void => {
        if (this.#starting === pending) this.#starting = undefined;
      };
      pending.then(settle, settle);
    }

    return this.#starting;
  }

  #attach(sandbox: WidgetSandbox): void {
    this.#detachers.push(
      sandbox.on(WIDGET_FRAME_EVENT, (payload) => this.#onFrame(payload)),
      sandbox.on(WIDGET_PUBLISH_EVENT, (payload) => this.#onPublishMessage(payload)),
      sandbox.on(WIDGET_ERROR_EVENT, (payload) => this.#onErrorMessage(payload)),
    );
  }

  #detach(): void {
    for (const detach of this.#detachers.splice(0)) {
      try {
        detach();
      } catch {
        // The sandbox may already be gone.
      }
    }
  }

  #onFrame(payload: unknown): void {
    const frame = payload as Partial<WidgetFrameMessage> | null | undefined;
    if (!frame || typeof frame !== 'object' || typeof frame.instanceId !== 'string') return;
    if (!isBitmap(frame.bitmap)) return;
    this.#layerStore.setBitmap(frame.instanceId, frame.bitmap);
  }

  #onPublishMessage(payload: unknown): void {
    const message = payload as Partial<WidgetPublishMessage> | null | undefined;
    if (!message || typeof message !== 'object') return;
    if (typeof message.instanceId !== 'string' || typeof message.port !== 'string') return;
    this.#onPublish?.({
      instanceId: message.instanceId,
      port: message.port,
      payload: message.payload,
    });
  }

  #onErrorMessage(payload: unknown): void {
    const message = payload as Partial<WidgetErrorMessage> | null | undefined;
    if (!message || typeof message !== 'object') return;
    if (typeof message.instanceId !== 'string') return;

    // Mount failures travel back through the rejected `mount()` promise instead, so that one
    // failure produces exactly one diagnostic.
    if (message.phase !== 'render' && message.phase !== 'deliver') return;

    const code: WidgetDiagnosticCode =
      message.phase === 'render' ? 'widget/render-failed' : 'widget/deliver-failed';
    const name = message.error?.name ?? 'Error';
    const text = message.error?.message ?? 'Unknown widget failure';
    this.#report(
      code,
      `Widget "${message.instanceId}" failed during ${message.phase}: ${name}: ${text}`,
      {
        instanceId: message.instanceId,
        widget: this.#instances.get(message.instanceId)?.widget,
      },
    );
  }

  #fire(
    code: WidgetDiagnosticCode | undefined,
    method: string,
    args: readonly unknown[],
    instanceId: string,
  ): void {
    if (this.#disposed) return;
    if (!this.#sandbox && !this.#starting) return;

    void this.#ensureSandbox()
      .then((sandbox) => sandbox.call(method, ...args))
      .catch((error: unknown) => {
        if (this.#disposed || error instanceof WidgetRuntimeError) return;
        if (this.#isTerminated()) {
          this.#failRuntime('The widget sandbox terminated unexpectedly.');
          return;
        }
        if (code === undefined) return;
        this.#report(
          code,
          `Widget call "${method}" failed for "${instanceId}": ${describeError(error)}`,
          { instanceId, widget: this.#instances.get(instanceId)?.widget },
        );
      });
  }

  #isTerminated(): boolean {
    return this.#sandbox?.state === 'terminated';
  }

  /** Abandons the runtime: layers are cleared and the failure is reported once. */
  #failRuntime(message: string, cause?: unknown): WidgetRuntimeError {
    this.#sandbox = undefined;
    this.#starting = undefined;
    this.#detach();
    this.#layerStore.clear();
    this.#instances.clear();
    if (!this.#disposed) this.#report('widget/runtime-failed', message);
    return new WidgetRuntimeError(message, cause === undefined ? undefined : { cause });
  }

  async #shutdown(): Promise<void> {
    this.#disposed = true;
    this.#detach();
    this.#layerStore.clear();
    this.#instances.clear();

    const pending = this.#starting;
    const sandbox = this.#sandbox;
    this.#starting = undefined;
    this.#sandbox = undefined;

    if (sandbox) {
      await terminate(sandbox);
      return;
    }
    if (pending) {
      const late = await pending.catch(() => undefined);
      if (late) await terminate(late);
    }
  }

  #report(
    code: WidgetDiagnosticCode,
    message: string,
    ids: { instanceId?: string | undefined; widget?: string | undefined } = {},
  ): void {
    const diagnostic: WidgetDiagnostic = {
      code,
      message,
      ...(ids.instanceId === undefined ? {} : { instanceId: ids.instanceId }),
      ...(ids.widget === undefined ? {} : { widget: ids.widget }),
    };
    try {
      this.#onDiagnostic?.(diagnostic);
    } catch (error) {
      console.error('[@mica-js/widget] diagnostic handler threw', error);
    }
  }
}

function splitRef(ref: string): { packageId: string; widgetId: string } | undefined {
  const separator = ref.indexOf(':');
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  return { packageId: ref.slice(0, separator), widgetId: ref.slice(separator + 1) };
}

function currentDevicePixelRatio(): number {
  const ratio = (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio;
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

function isBitmap(value: unknown): value is ImageBitmap {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ImageBitmap).close === 'function'
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' ? error : String(error);
}

async function terminate(sandbox: WidgetSandbox): Promise<void> {
  try {
    await sandbox.terminate('widget host disposed');
  } catch {
    // Already terminated.
  }
}
