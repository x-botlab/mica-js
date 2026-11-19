/**
 * Author bridge of one device HTML environment (RFC 0023 `DeviceViewApi`).
 *
 * This code runs inside the inner sandbox frame of one environment. It owns the author `Event`
 * outlets, turns package reads into verified lookups through the host bridge and never touches the
 * editor DOM, the model implementation or the host file system. It is DOM-free on purpose:
 * `environment/content.ts` supplies the page around it, and the same bridge runs unchanged in tests.
 */
import { Emitter, toDisposable } from '@mica-js/core/lifecycle';
import type { Event } from '@mica-js/core/lifecycle';
import type { RpcProxy } from '@mica-js/core/rpc';
import { packagePathProblem } from '@mica-js/document/fused';
import type { Value } from '@mica-js/document/fused';
import type { ModelEvent } from '@mica-js/sdk/fused';
import type { FusedPresentationProps } from '../runtime/protocol';
import { mapWireFailure, messageOf } from '../runtime/wire';
import { imageBuffer, mimeTypeOf } from './paths';
import { HtmlViewError } from './protocol';
import type { IFusedHtmlHostService, IFusedHtmlModelEventWire, IHtmlViewTarget } from './protocol';

/** RFC 0023 `HtmlAssets`: verified package reads and view-scoped resource URLs. */
export interface IHtmlAssets {
  /** Reads one declared package file; `path` is package-root relative. */
  read(path: string): Promise<Uint8Array>;
  /** Resolves one package file to an opaque URL that dies with this view. */
  getUrl(path: string): Promise<string>;
}

/** RFC 0023 `DeviceViewApi.model`: the declared surface of the owning model. */
export interface IDeviceViewModel {
  /** Declared methods; only declared names resolve. */
  readonly methods: Readonly<Record<string, (params: Value) => Promise<Value>>>;
  /** Declared event outlets; a subscription is created on the wire when it is first observed. */
  readonly events: Readonly<Record<string, Event<ModelEvent<Value>>>>;
}

/** RFC 0023 `DeviceViewApi`. */
export interface IDeviceViewApi {
  readonly props: FusedPresentationProps;
  readonly model: IDeviceViewModel | undefined;
  readonly assets: IHtmlAssets;
  readonly onDidClose: Event<void>;
}

/** Live bridge of one environment. */
export interface IDeviceViewSession {
  readonly api: IDeviceViewApi;
  readonly closed: boolean;
  /** Delivers one model event the host pushed into this environment. */
  deliver(event: IFusedHtmlModelEventWire): void;
  /** Announces the host released this view; fires `onDidClose` once. */
  close(): void;
  dispose(): void;
}

export interface IDeviceViewSessionOptions {
  readonly host: RpcProxy<IFusedHtmlHostService>;
  readonly target: IHtmlViewTarget;
  /** Reports an author failure once; the editor faults the view afterwards (RFC 0023). */
  readonly reportFailure: (code: string, message: string) => void;
  /** Object URL seam; defaults to the environment realm `URL`. */
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

interface IEventChannel {
  readonly emitter: Emitter<ModelEvent<Value>>;
  listeners: number;
}

/** Builds the author-facing bridge over an established host channel. */
export function createDeviceViewSession(options: IDeviceViewSessionOptions): IDeviceViewSession {
  const { host, target } = options;
  const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const declared = new Set(target.methods);
  const channels = new Map<string, IEventChannel>();
  const urls = new Set<string>();
  const closeEmitter = new Emitter<void>();
  let closed = false;
  let failureReported = false;

  const fail = (code: string, message: string): void => {
    if (failureReported || closed) return;
    failureReported = true;
    options.reportFailure(code, message);
  };

  const channel = (name: string): Event<ModelEvent<Value>> => {
    return (listener) => {
      if (closed) return toDisposable(() => undefined);
      let entry = channels.get(name);
      if (entry === undefined) {
        entry = { emitter: new Emitter<ModelEvent<Value>>(), listeners: 0 };
        channels.set(name, entry);
      }
      const current = entry;
      current.listeners += 1;
      if (current.listeners === 1) void subscribe(name);
      const subscription = current.emitter.event(listener);
      return toDisposable(() => {
        subscription.dispose();
        current.listeners -= 1;
        if (current.listeners > 0) return;
        channels.delete(name);
        current.emitter.dispose();
        void host.unsubscribe(name).catch(() => undefined);
      });
    };
  };

  async function subscribe(name: string): Promise<void> {
    try {
      await host.subscribe(name);
    } catch (cause) {
      fail('view/bridge-failed', `Subscribing to "${name}" failed: ${messageOf(cause)}`);
    }
  }

  const methods = new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, name) {
      if (typeof name !== 'string' || !declared.has(name)) return undefined;
      return async (params: Value) => {
        if (closed) throw new HtmlViewError('view/bridge-failed', 'The device view is closed.');
        return mapWireFailure(() => host.callModel(name, params));
      };
    },
    has(_target, name) {
      return typeof name === 'string' && declared.has(name);
    },
  }) as IDeviceViewModel['methods'];

  const events: Record<string, Event<ModelEvent<Value>>> = {};
  for (const name of target.events) events[name] = channel(name);

  const assets: IHtmlAssets = {
    async read(path) {
      assertAssetPath(path);
      if (closed) throw new HtmlViewError('view/bridge-failed', 'The device view is closed.');
      const bytes = await mapWireFailure(() => host.readAsset(path));
      if (!(bytes instanceof Uint8Array)) {
        throw new HtmlViewError('view/load-failed', `The host returned no bytes for ${path}.`);
      }
      return bytes;
    },
    async getUrl(path) {
      const bytes = await assets.read(path);
      const url = createObjectUrl(new Blob([imageBuffer(bytes)], { type: mimeTypeOf(path) }));
      if (closed) {
        revokeObjectUrl(url);
        throw new HtmlViewError('view/bridge-failed', 'The device view is closed.');
      }
      urls.add(url);
      return url;
    },
  };

  const api: IDeviceViewApi = Object.freeze({
    props: Object.freeze({ ...target.props }),
    model: target.hasModel ? Object.freeze({ methods, events: Object.freeze(events) }) : undefined,
    assets,
    onDidClose: (listener: () => unknown) => {
      if (closed) {
        listener();
        return toDisposable(() => undefined);
      }
      return closeEmitter.event(listener);
    },
  });

  const release = (): void => {
    if (closed) return;
    closed = true;
    for (const entry of channels.values()) entry.emitter.dispose();
    channels.clear();
    for (const url of urls) {
      try {
        revokeObjectUrl(url);
      } catch {
        // The environment may already be gone.
      }
    }
    urls.clear();
  };

  return {
    api,
    get closed() {
      return closed;
    },
    deliver(event) {
      if (closed) return;
      const entry = channels.get(event.name);
      if (entry === undefined) return;
      try {
        entry.emitter.fire(event.payload);
      } catch (cause) {
        fail('view/execution-failed', `Listener of "${event.name}" failed: ${messageOf(cause)}`);
      }
    },
    close() {
      if (closed) return;
      try {
        closeEmitter.fire(undefined);
      } finally {
        closeEmitter.dispose();
        release();
      }
    },
    dispose() {
      closeEmitter.dispose();
      release();
    },
  };
}

/** Rejects a path that is not a normalized package-root relative file path. */
export function assertAssetPath(path: string): void {
  const problem = typeof path === 'string' ? packagePathProblem(path) : 'must be a string';
  if (problem !== undefined) {
    throw new HtmlViewError('view/load-failed', `Asset path ${JSON.stringify(path)} ${problem}.`);
  }
}
