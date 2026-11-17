/**
 * Editor-side manager of the device HTML view environments (RFC 0023).
 *
 * One environment per `(instanceId, viewId)`: an iframe on its own origin served from
 * `viewBaseUrlTemplate`, one transferred `MessagePort` for the typed bridge, and one DOM owner that
 * is created once and never moved. The editor UI attaches the owner to a sidebar or floating slot
 * and the manager only positions it, so docking, floating and resizing keep the same page,
 * listeners, local state and model proxy; collapse keeps the environment mounted, and release
 * disposes it. The environment page itself hosts a sandboxed inner frame for the author document,
 * which is why the manager only ever sees one stable owner and one stable outer page.
 *
 * Three lanes belong to one view lease. The environment page keeps the control lane (loading,
 * theme, failures, the two port grants), while the author lane and the package lane are dedicated
 * ports this manager creates on request and the environment only hands on: model methods, model
 * events, props, assets and the package reads of the asset worker reach this manager directly, so
 * no intermediate frame relays them.
 */
import { DisposableStore, Emitter } from '@mica-js/core/lifecycle';
import type { Event } from '@mica-js/core/lifecycle';
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type {
  DeviceLock,
  DeviceRegistry,
  HtmlViewDefinition,
  Value,
} from '@mica-js/document/fused';
import { packagePathProblem } from '@mica-js/document/fused';
import { openDevicePackage } from '@mica-js/sdk/fused';
import type { VerifiedPackage } from '@mica-js/sdk/fused';
import type { FusedPresentationProps, IFusedModelClient } from '../runtime/protocol';
import { messageOf, toWireFailure, transferBytes } from '../runtime/wire';
import { htmlEnvironmentUrl, newHtmlEnvironmentId, parseHtmlViewBase } from './base-url';
import type { IHtmlViewBase } from './base-url';
import { clipInsets, clipPathOf } from './layout';
import type { IClipRect } from './layout';
import { ENVIRONMENT_DOCUMENT_FILE, assetRootUrl } from './paths';
import {
  HTML_VIEW_ACK,
  HTML_VIEW_CONNECT,
  HtmlViewError,
  fusedHtmlAssetService,
  fusedHtmlContentViewService,
  fusedHtmlHostControlService,
  fusedHtmlHostService,
} from './protocol';
import type {
  HtmlViewDiagnosticCode,
  IFusedHtmlHostControlService,
  IFusedHtmlHostService,
  IFusedHtmlModelEventWire,
  IHtmlViewAckMessage,
  IHtmlViewConnectMessage,
  IHtmlViewContent,
  IHtmlViewFailure,
  IHtmlViewTarget,
  IHtmlViewTheme,
} from './protocol';
import {
  DEFAULT_HTML_VIEW_THEME,
  htmlViewBackgroundColor,
  htmlViewThemeEquals,
  normalizeHtmlViewTheme,
} from './theme';

/** One live instance an HTML view may attach to. */
export interface IHtmlViewInstance {
  readonly device: string;
  readonly lock: DeviceLock;
  readonly props: FusedPresentationProps;
  readonly methods: readonly string[];
  readonly events: readonly string[];
  /**
   * Whether the instance device declares a model (RFC 0021).
   *
   * Authoritative: a model with an empty public surface still counts as present, and a device
   * without a model keeps `api.model` undefined whatever its declared methods and events say.
   */
  readonly hasModel: boolean;
  /** Declared HTML views of the instance device, normally `manifest.view`. */
  readonly views: Readonly<Record<string, HtmlViewDefinition>>;
}

/** Container an environment occupies; switching never reloads its page. */
export type HtmlViewLocation = 'sidebar' | 'floating';

/** Lifecycle of one environment. */
export type HtmlViewState = 'loading' | 'ready' | 'failed' | 'closed';

export interface IHtmlViewOpenRequest {
  readonly instanceId: string;
  readonly viewId: string;
  readonly location: HtmlViewLocation;
}

/** One stable environment of one view. */
export interface IHtmlViewHandle {
  /** Stable key of `(instanceId, viewId)`. */
  readonly key: string;
  readonly instanceId: string;
  readonly viewId: string;
  readonly title: string;
  readonly device: string;
  /** Package-root relative `.html` entry the environment loaded. */
  readonly entry: string;
  readonly location: HtmlViewLocation;
  readonly state: HtmlViewState;
  readonly failure: IHtmlViewFailure | undefined;
  /** Owner of the iframe; it stays in the environment layer for the life of the environment. */
  readonly element: HTMLElement;
  /**
   * Positions the owner over `slot`; `null` keeps the page alive but hides it.
   *
   * The owner keeps the slot box and is clipped to the visible part of every scrolling ancestor,
   * the editor container and the viewport, so a partially scrolled sidebar never lets the frame
   * paint over the rest of the editor. A slot that scrolled out completely stops painting.
   */
  attach(slot: HTMLElement | null): void;
  /** Hides the page without unloading it; used when the container collapses. */
  setVisible(visible: boolean): void;
  setLocation(location: HtmlViewLocation): void;
  focus(): void;
  close(): void;
}

export type HtmlViewChangeType = 'opened' | 'ready' | 'failed' | 'closed' | 'moved';

export interface IHtmlViewChange {
  readonly type: HtmlViewChangeType;
  readonly handle: IHtmlViewHandle;
}

/** Manager of every device HTML environment of one workbench. */
export interface IHtmlViewHost {
  readonly onDidChange: Event<IHtmlViewChange>;
  /** Announces every resolved theme the environments must mirror. */
  readonly onDidThemeChange: Event<IHtmlViewTheme>;
  /** Theme the environments mirror at this moment; dark unless the workbench sets one. */
  readonly theme: IHtmlViewTheme;
  /**
   * Sets the theme every environment mirrors, in place.
   *
   * The workbench forwards its *computed* colors, so a `var(...)` of the host page is already
   * resolved. An equal theme is ignored and a change never reloads a frame, so author input, model
   * session and document history survive it.
   */
  setTheme(theme: IHtmlViewTheme): void;
  readonly views: readonly IHtmlViewHandle[];
  get(instanceId: string, viewId: string): IHtmlViewHandle | undefined;
  /**
   * Opens or focuses the single environment of one view; it never creates a second one.
   *
   * Rejects with `view/unavailable-mode` when {@link close}, {@link closeAll} or
   * {@link dispose} release the view while its verified package read is still in flight, so a
   * cancelled open can never create a stale environment later.
   */
  open(request: IHtmlViewOpenRequest): Promise<IHtmlViewHandle>;
  /** Releases the environment or cancels its pending open; `true` when either existed. */
  close(instanceId: string, viewId: string): boolean;
  /**
   * Releases every environment and cancels every pending open, keeping the manager usable.
   *
   * The manager caches the model proxy of each environment for its lifetime, so a runtime reset
   * must call this before the replacement runtime is prepared and then reopen the views: they bind
   * the new model on their next {@link open}.
   */
  closeAll(): void;
  focus(instanceId: string, viewId: string): boolean;
  /** Re-measures every attached environment; call after a layout-only change. */
  refresh(): void;
  /** Releases every environment and cancels every pending open. */
  dispose(): Promise<void>;
}

export interface IHtmlViewHostOptions {
  /** Absolute HTTP(S) deployment directory with one `${id}` hostname label (RFC 0023). */
  readonly viewBaseUrlTemplate: string;
  /**
   * Element the fixed environment layer is appended to.
   *
   * It is the editor host element, so its box also bounds every environment: an attached slot is
   * clipped to it as well as to its own scrolling ancestors and the viewport.
   */
  readonly container: HTMLElement;
  /** Resolves one live instance; `undefined` when it is not mounted (edit mode, no selection). */
  readonly describe: (instanceId: string) => IHtmlViewInstance | undefined;
  /** Registry that owns the locked packages every view resource is read from. */
  readonly registry: DeviceRegistry;
  /**
   * Proxy of the mounted model of one instance.
   *
   * Called only for instances whose declaration has a model; it must resolve one, and a throw (for
   * example `model/disconnected` outside a run session) fails the open with `view/unavailable-mode`
   * instead of handing the author an API without a model.
   */
  readonly model?: (instanceId: string) => IFusedModelClient | undefined;
  readonly onDiagnostic?: (failure: IHtmlViewFailure) => void;
  /** Theme the environments mirror before the workbench forwards its own; defaults to dark. */
  readonly theme?: IHtmlViewTheme;
  /** Budget of one bridge handshake; defaults to 15 s, `0` disables it. */
  readonly handshakeTimeoutMs?: number;
  /**
   * Origin of the editor page; a template resolving to it is rejected.
   *
   * Defaults to `globalThis.location.origin`; hosts without a browser location must pass it. The
   * environment refuses a non-HTTP(S) answer origin, so there is no wildcard fallback.
   */
  readonly origin?: string;
  /** DOM seams; default to the globals of the editor realm. */
  readonly document?: Document;
  readonly window?: Window;
  readonly createEnvironmentId?: () => string;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_LENGTH = 500;

/** Failure codes an environment may report about itself. */
const REPORTABLE_CODES: ReadonlySet<string> = new Set<HtmlViewDiagnosticCode>([
  'view/load-failed',
  'view/bridge-failed',
  'view/execution-failed',
]);

/** One `open` whose environment does not exist yet; it can be released before the record exists. */
interface IPendingOpen {
  readonly key: string;
  readonly instanceId: string;
  readonly viewId: string;
  /** The caller's promise; it rejects when the open is released before its record exists. */
  task: Promise<IHtmlViewHandle>;
  readonly cancelled: boolean;
  /** Set exactly when {@link task} was rejected by a release. */
  readonly rejection: HtmlViewError | undefined;
  /** Rejects {@link task} and marks the open stale; later creation is refused. */
  cancel(reason: HtmlViewError): void;
}

interface IHtmlViewRecord {
  readonly key: string;
  readonly instanceId: string;
  readonly viewId: string;
  readonly title: string;
  readonly device: string;
  readonly entry: string;
  readonly lock: DeviceLock;
  readonly assetRoot: string;
  readonly environmentUrl: string;
  readonly props: FusedPresentationProps;
  readonly methods: ReadonlySet<string>;
  readonly events: ReadonlySet<string>;
  readonly hasModel: boolean;
  readonly model: IFusedModelClient | undefined;
  location: HtmlViewLocation;
  token: string;
  owner: HTMLElement;
  frame: HTMLIFrameElement;
  handle: IHtmlViewHandle | undefined;
  slot: HTMLElement | null;
  visible: boolean;
  state: HtmlViewState;
  failure: IHtmlViewFailure | undefined;
  loadSeen: boolean;
  endpoint: RpcEndpoint | undefined;
  /** Dedicated package lane of the asset worker; created at most once per view. */
  assetEndpoint: RpcEndpoint | undefined;
  /** Dedicated author lane of the inner frame; created at most once per view. */
  contentEndpoint: RpcEndpoint | undefined;
  subscriptions: Map<string, { dispose(): void }>;
  eventListeners: Set<(event: IFusedHtmlModelEventWire) => void>;
  closeListeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Key of one view instance: the same device view in two places is still one environment. */
export function htmlViewKey(instanceId: string, viewId: string): string {
  return `${instanceId}\u0000${viewId}`;
}

/** Creates the HTML view manager of one workbench. */
export function createHtmlViewHost(options: IHtmlViewHostOptions): IHtmlViewHost {
  const doc = options.document ?? globalThis.document;
  const win = options.window ?? globalThis.window;
  const origin = options.origin ?? globalThis.location?.origin;
  if (origin === undefined || origin === '' || origin === 'null') {
    throw new HtmlViewError(
      'view/invalid-base-url-template',
      'The HTML view host needs the editor origin to bind every handshake; pass `origin` outside a browser document.',
    );
  }
  const base: IHtmlViewBase = parseHtmlViewBase(options.viewBaseUrlTemplate, origin);
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const changes = new Emitter<IHtmlViewChange>();
  const themeChanges = new Emitter<IHtmlViewTheme>();
  let theme =
    options.theme === undefined ? DEFAULT_HTML_VIEW_THEME : normalizeHtmlViewTheme(options.theme);
  const records = new Map<string, IHtmlViewRecord>();
  const pendingOpens = new Map<string, IPendingOpen>();
  const packages = new Map<string, Promise<VerifiedPackage>>();
  const layerListeners = new DisposableStore();
  let layer: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  let slotObserver: ResizeObserver | undefined;
  let pendingFrame: number | undefined;
  let disposed = false;

  return {
    onDidChange: changes.event,
    onDidThemeChange: themeChanges.event,
    get theme() {
      return theme;
    },
    setTheme,
    get views() {
      return [...records.values()].map((record) => handleOf(record));
    },
    get,
    open,
    close,
    closeAll,
    focus,
    refresh,
    dispose,
  };

  function assertOpen(): void {
    if (disposed)
      throw new HtmlViewError('view/unavailable-mode', 'The HTML view host is disposed.');
  }

  function setTheme(next: IHtmlViewTheme): void {
    const resolved = normalizeHtmlViewTheme(next);
    // A disposed host has no environment left to mirror; the workbench may still re-render once.
    if (disposed) return;
    if (htmlViewThemeEquals(theme, resolved)) return;
    theme = resolved;
    // The environment element follows a theme change before the environment answers the bridge; the
    // owner keeps painting the container surface while the view loads, so the loading status stays
    // readable, and it takes the theme only once the view is ready.
    for (const record of records.values()) {
      record.frame.style.background = htmlViewBackgroundColor(theme);
      if (record.state !== 'loading')
        record.owner.style.background = htmlViewBackgroundColor(theme);
    }
    themeChanges.fire(resolved);
  }

  function get(instanceId: string, viewId: string): IHtmlViewHandle | undefined {
    const record = records.get(htmlViewKey(instanceId, viewId));
    return record === undefined ? undefined : handleOf(record);
  }

  function open(request: IHtmlViewOpenRequest): Promise<IHtmlViewHandle> {
    // Deliberately not `async`: the returned promise is the pending task itself, so one release
    // rejects the exact promise the caller holds instead of an adopted copy of it.
    try {
      assertOpen();
      const key = htmlViewKey(request.instanceId, request.viewId);
      const existing = records.get(key);
      if (existing !== undefined) {
        // A failed environment is the one and only environment of this view until it is released.
        // Opening a fresh origin behind the failure would hide it behind a load loop, so the
        // retained handle is returned and only an explicit close starts a new environment.
        if (existing.state !== 'failed') {
          existing.location = request.location;
          focusRecord(existing);
        }
        return Promise.resolve(handleOf(existing));
      }
      const pending = pendingOpens.get(key);
      if (pending !== undefined) return pending.task;
      const entry = createPendingOpen(request);
      pendingOpens.set(key, entry);
      return entry.task;
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Starts one open and remembers how to release it before its record exists.
   *
   * The verified package read and the model resolution are asynchronous, so a selection change or an
   * end of the run session may land while the environment is still being prepared. Cancellation
   * rejects the caller's promise and makes the in-flight preparation refuse to create a record.
   */
  function createPendingOpen(request: IHtmlViewOpenRequest): IPendingOpen {
    const key = htmlViewKey(request.instanceId, request.viewId);
    let settle: ((error: Error) => void) | undefined;
    let rejection: HtmlViewError | undefined;
    const gate = new Promise<never>((_resolve, reject) => {
      settle = reject;
    });
    // The caller receives the rejection through the race below; this keeps a late `await` of a
    // released open from surfacing as an unhandled rejection of the gate itself.
    void gate.catch(() => undefined);
    const pending: IPendingOpen = {
      key,
      instanceId: request.instanceId,
      viewId: request.viewId,
      task: gate,
      get cancelled() {
        return rejection !== undefined;
      },
      get rejection() {
        return rejection;
      },
      cancel(reason) {
        if (rejection !== undefined) return;
        rejection = reason;
        pendingOpens.delete(key);
        settle?.(reason);
      },
    };
    const creation = createEnvironment(request, pending);
    // A preparation may fail on its own (missing package, released model, failing declaration);
    // forward that failure unless a release already settled the caller's promise.
    void creation.catch((error: unknown) => {
      if (rejection !== undefined) return;
      settle?.(error instanceof Error ? error : new Error(String(error)));
    });
    pending.task = Promise.race([creation, gate]).finally(() => {
      if (pendingOpens.get(key) === pending) pendingOpens.delete(key);
    });
    // A release rejects the caller's promise on purpose; this keeps a caller that dropped the
    // handle from producing an unhandled rejection while the failure is still observable.
    void pending.task.catch(() => undefined);
    return pending;
  }

  /** Stops one preparation whose release already happened, with an explicit failure. */
  function throwIfReleased(entry: IPendingOpen): void {
    if (entry.cancelled) {
      throw entry.rejection ?? releasedError(entry, 'The HTML view was released.');
    }
    assertOpen();
  }

  function releasedError(
    entry: { instanceId: string; viewId: string },
    reason: string,
  ): HtmlViewError {
    return new HtmlViewError(
      'view/unavailable-mode',
      `${reason} No environment was created for ${entry.instanceId}/${entry.viewId}.`,
      { instanceId: entry.instanceId, viewId: entry.viewId },
    );
  }
  async function createEnvironment(
    request: IHtmlViewOpenRequest,
    entry: IPendingOpen,
  ): Promise<IHtmlViewHandle> {
    const { instanceId, viewId } = request;
    throwIfReleased(entry);
    const instance = describe(instanceId);
    if (instance === undefined) {
      throw new HtmlViewError(
        'view/unavailable-mode',
        `Instance "${instanceId}" has no mounted device view environment.`,
        { instanceId, viewId },
      );
    }
    const view = instance.views[viewId];
    if (view === undefined) {
      throw new HtmlViewError(
        'view/unknown-entry',
        `Device ${instance.device} declares no HTML view "${viewId}".`,
        { instanceId, viewId },
      );
    }
    if (!view.entry.toLowerCase().endsWith('.html')) {
      throw new HtmlViewError(
        'view/load-failed',
        `View entry "${view.entry}" of ${instance.device} is not an HTML document.`,
        { instanceId, viewId },
      );
    }
    let files: VerifiedPackage;
    try {
      files = await packageOf(instance.lock);
    } catch (cause) {
      throw new HtmlViewError(
        'view/load-failed',
        `Cannot verify ${instance.device}: ${messageOf(cause)}`,
        { instanceId, viewId },
      );
    }
    if (!Object.hasOwn(files.files, view.entry)) {
      throw new HtmlViewError(
        'view/load-failed',
        `Package ${instance.device} does not declare the view entry "${view.entry}".`,
        { instanceId, viewId },
      );
    }
    // The package read is the long await: a selection change or an ended run session may have
    // released this view while it was pending, and no record may be created then.
    throwIfReleased(entry);
    const model = resolveModel(instanceId, instance);
    assertOpen();

    const environmentId = (options.createEnvironmentId ?? newHtmlEnvironmentId)();
    const environmentUrl = htmlEnvironmentUrl(base, environmentId);
    const assetRoot = assetRootUrl(environmentUrl).href;
    const documentUrl = new URL(ENVIRONMENT_DOCUMENT_FILE, environmentUrl);
    const record: IHtmlViewRecord = {
      key: htmlViewKey(instanceId, viewId),
      instanceId,
      viewId,
      title: view.title,
      device: instance.device,
      entry: view.entry,
      lock: instance.lock,
      assetRoot,
      environmentUrl: documentUrl.href,
      props: instance.props,
      methods: new Set(instance.methods),
      events: new Set(instance.events),
      hasModel: instance.hasModel,
      model,
      location: request.location,
      token: createToken(),
      owner: ownerElement(instanceId, viewId, view.title, instance.device),
      frame: frameElement(view.title, instance.device, theme),
      handle: undefined,
      slot: null,
      visible: true,
      state: 'loading',
      failure: undefined,
      loadSeen: false,
      endpoint: undefined,
      assetEndpoint: undefined,
      contentEndpoint: undefined,
      subscriptions: new Map(),
      eventListeners: new Set(),
      closeListeners: new Set(),
      timer: undefined,
    };
    record.owner.append(record.frame);
    layerElement().append(record.owner);
    records.set(record.key, record);
    record.frame.addEventListener('load', () => onFrameLoad(record));
    if (entry.cancelled) {
      // Defensive: a cancelled preparation must never leave a frame behind.
      record.owner.remove();
      throwIfReleased(entry);
    }
    record.frame.src = record.environmentUrl;
    if (handshakeTimeoutMs > 0) {
      record.timer = setTimeout(() => {
        record.timer = undefined;
        fault(
          record,
          'view/bridge-failed',
          'The HTML environment did not answer the bridge handshake.',
        );
      }, handshakeTimeoutMs);
    }
    emit('opened', record);
    return handleOf(record);
  }

  function connect(record: IHtmlViewRecord): void {
    const channel = new MessageChannel();
    const endpoint = createRpc(channel.port1);
    record.endpoint = endpoint;
    // The environment page keeps the lifecycle lane: it loads the view, mirrors the theme, reports
    // failures and asks for the two dedicated ports below. Author reads and model calls never pass
    // through it, and the only bytes it reads are the author document it has to write itself.
    endpoint.register(fusedHtmlHostControlService, controlService(record), {
      transfer: (member, value) =>
        member === 'readAsset' ? transferBytes(value) : transferPort(value),
    });
    // The bridge closing is a teardown signal, never a way to drop a retained failure: the failed
    // record stays listed until the workbench releases it explicitly.
    endpoint.onDidClose(() => {
      if (record.state !== 'failed') release(record);
    });
    const frameWindow = record.frame.contentWindow;
    if (frameWindow === null) {
      fault(record, 'view/bridge-failed', 'The HTML environment frame is not available.');
      return;
    }
    // The target is structured-cloned, never transferred: the runtime keeps its own props.
    const message: IHtmlViewConnectMessage = {
      type: HTML_VIEW_CONNECT,
      token: record.token,
      parentOrigin: origin,
      target: viewTarget(record),
    };
    try {
      frameWindow.postMessage(message, new URL(record.environmentUrl).origin, [channel.port2]);
    } catch (cause) {
      fault(record, 'view/bridge-failed', `The bridge port was rejected: ${messageOf(cause)}`);
    }
  }

  function viewTarget(record: IHtmlViewRecord): IHtmlViewTarget {
    return {
      instanceId: record.instanceId,
      viewId: record.viewId,
      device: record.device,
      title: record.title,
      entry: record.entry,
      assetRoot: record.assetRoot,
      props: record.props,
      methods: [...record.methods],
      events: [...record.events],
      hasModel: record.hasModel,
    };
  }

  /** Lifecycle lane of the trusted environment page. */
  function controlService(record: IHtmlViewRecord): IFusedHtmlHostControlService {
    return {
      readAsset: (path) => readPackageFile(record, path),
      async getTheme() {
        return theme;
      },
      onDidThemeChange(listener) {
        const subscription = themeChanges.event((next) => listener(next));
        return () => subscription.dispose();
      },
      async ready() {
        markReady(record);
      },
      async reportFailure(code, message) {
        reportFailure(record, code, message);
      },
      closed() {
        release(record);
      },
      async assetPort() {
        return requestPort(record, 'package');
      },
      async contentPort() {
        return requestPort(record, 'author');
      },
    };
  }

  /** Dedicated lane of the inner author frame. */
  function authorService(record: IHtmlViewRecord): IFusedHtmlHostService {
    return {
      readAsset: (path) => readPackageFile(record, path),
      async callModel(method, params: Value) {
        try {
          const client = record.model;
          if (client === undefined) {
            throw new HtmlViewError(
              'view/unavailable-mode',
              `Device ${record.device} declares no model, so the view cannot call "${method}".`,
              { instanceId: record.instanceId, viewId: record.viewId },
            );
          }
          if (!record.methods.has(method)) {
            throw new HtmlViewError(
              'view/execution-failed',
              `Method "${method}" is not declared by ${record.device}.`,
              { instanceId: record.instanceId, viewId: record.viewId },
            );
          }
          const invoke = client.methods[method];
          if (invoke === undefined) {
            throw new HtmlViewError(
              'view/unavailable-mode',
              `Method "${method}" is not available on the live model.`,
              { instanceId: record.instanceId, viewId: record.viewId },
            );
          }
          return await invoke(params);
        } catch (cause) {
          throw toWireFailure(cause);
        }
      },
      async subscribe(event) {
        if (record.subscriptions.has(event)) return;
        if (!record.events.has(event)) {
          throw toWireFailure(
            new HtmlViewError(
              'view/execution-failed',
              `Event "${event}" is not declared by ${record.device}.`,
              { instanceId: record.instanceId, viewId: record.viewId },
            ),
          );
        }
        const client = record.model;
        if (client === undefined) {
          throw toWireFailure(
            new HtmlViewError(
              'view/unavailable-mode',
              `Device ${record.device} declares no model, so the view cannot observe "${event}".`,
              { instanceId: record.instanceId, viewId: record.viewId },
            ),
          );
        }
        const outlet = client.events[event];
        if (outlet === undefined) {
          throw toWireFailure(
            new HtmlViewError(
              'view/execution-failed',
              `Event "${event}" is declared by ${record.device} but the live model exposes no outlet for it.`,
              { instanceId: record.instanceId, viewId: record.viewId },
            ),
          );
        }
        const subscription = outlet((payload) => {
          const push: IFusedHtmlModelEventWire = { name: event, payload };
          for (const listener of [...record.eventListeners]) {
            try {
              listener(push);
            } catch {
              // One broken environment listener must not stop the other views.
            }
          }
        });
        record.subscriptions.set(event, subscription);
      },
      async unsubscribe(event) {
        const subscription = record.subscriptions.get(event);
        if (subscription === undefined) return;
        record.subscriptions.delete(event);
        subscription.dispose();
      },
      onDidModelEvent(listener) {
        record.eventListeners.add(listener);
        return () => record.eventListeners.delete(listener);
      },
      onDidClose(listener) {
        record.closeListeners.add(listener);
        return () => record.closeListeners.delete(listener);
      },
      async reportFailure(code, message) {
        reportFailure(record, code, message);
      },
    };
  }

  function reportFailure(record: IHtmlViewRecord, code: string, message: string): void {
    fault(
      record,
      REPORTABLE_CODES.has(code) ? (code as HtmlViewDiagnosticCode) : 'view/execution-failed',
      typeof message === 'string' && message.length > 0
        ? message
        : 'The HTML view failed without a reason.',
    );
  }

  /**
   * Reads one declared package file of this view.
   *
   * Every lane that reaches package bytes goes through this one verified lookup of the locked
   * package, so neither the author frame nor the worker can read a file the view does not declare.
   */
  async function readPackageFile(record: IHtmlViewRecord, path: string): Promise<Uint8Array> {
    try {
      const problem = typeof path === 'string' ? packagePathProblem(path) : 'must be a string';
      if (problem !== undefined) {
        throw new HtmlViewError(
          'view/load-failed',
          `Asset path ${JSON.stringify(path)} ${problem}.`,
          { instanceId: record.instanceId, viewId: record.viewId },
        );
      }
      const files = await packageOf(record.lock);
      if (!Object.hasOwn(files.files, path)) {
        throw new HtmlViewError(
          'view/load-failed',
          `Package ${record.device} does not declare "${path}".`,
          { instanceId: record.instanceId, viewId: record.viewId },
        );
      }
      return await files.read(path);
    } catch (cause) {
      throw toWireFailure(cause);
    }
  }

  /**
   * Creates the one dedicated port of one lane of this view.
   *
   * Both ends of a direct port belong to this lease: the peer reads only the declared files of the
   * locked package, only the declared methods and events of this instance and only the props of this
   * view. A second request is an explicit failure, because a silently replaced channel would leave
   * the first consumer reading a closed port.
   */
  function requestPort(record: IHtmlViewRecord, lane: 'package' | 'author'): MessagePort {
    try {
      return grantPort(record, lane);
    } catch (cause) {
      throw toWireFailure(cause);
    }
  }

  function grantPort(record: IHtmlViewRecord, lane: 'package' | 'author'): MessagePort {
    if (record.state !== 'loading' && record.state !== 'ready') {
      throw new HtmlViewError(
        'view/unavailable-mode',
        `The HTML view ${record.instanceId}/${record.viewId} is ${record.state} and grants no ${lane} port.`,
        { instanceId: record.instanceId, viewId: record.viewId },
      );
    }
    const granted = lane === 'package' ? record.assetEndpoint : record.contentEndpoint;
    if (granted !== undefined) {
      throw new HtmlViewError(
        'view/bridge-failed',
        `The ${lane} port of ${record.instanceId}/${record.viewId} was already granted.`,
        { instanceId: record.instanceId, viewId: record.viewId },
      );
    }
    const channel = new MessageChannel();
    const endpoint = createRpc(channel.port1);
    // Both lanes answer package bytes, and both move the buffer instead of copying it.
    const transfer = (_member: string, value: unknown) => transferBytes(value);
    if (lane === 'package') {
      record.assetEndpoint = endpoint;
      endpoint.register(
        fusedHtmlAssetService,
        {
          async read(path) {
            return readPackageFile(record, path);
          },
        },
        { transfer },
      );
    } else {
      record.contentEndpoint = endpoint;
      endpoint.register(fusedHtmlHostService, authorService(record), { transfer });
      endpoint.register(fusedHtmlContentViewService, {
        async view(): Promise<IHtmlViewContent> {
          return { token: record.token, target: viewTarget(record) };
        },
      });
    }
    // A lane that closes while the view is live is this environment losing its author document or
    // its worker: the view faults once, and no lane is granted again behind the failure.
    endpoint.onDidClose(() => {
      if (record.state !== 'loading' && record.state !== 'ready') return;
      fault(record, 'view/bridge-failed', `The dedicated ${lane} port of the view closed.`);
    });
    return channel.port2;
  }

  function describe(instanceId: string): IHtmlViewInstance | undefined {
    if (disposed) return undefined;
    // A failing declaration callback is a host wiring error; it must not look like "not mounted".
    return options.describe(instanceId);
  }

  /**
   * Resolves the model proxy of one instance from its declaration.
   *
   * A device without a model gets an undefined proxy by design; a device with a model must get one,
   * so a missing source, a missing proxy or a runtime failure is reported instead of hidden.
   */
  function resolveModel(
    instanceId: string,
    instance: IHtmlViewInstance,
  ): IFusedModelClient | undefined {
    if (!instance.hasModel) return undefined;
    const source = options.model;
    if (source === undefined) {
      throw new HtmlViewError(
        'view/unavailable-mode',
        `Device ${instance.device} declares a model, but the HTML view host has no model source.`,
        { instanceId },
      );
    }
    let model: IFusedModelClient | undefined;
    try {
      model = source(instanceId);
    } catch (cause) {
      throw new HtmlViewError(
        'view/unavailable-mode',
        `The model of ${instance.device} is not available (${failureCodeOf(cause)}): ${messageOf(cause)}`,
        { instanceId },
      );
    }
    if (model === undefined) {
      throw new HtmlViewError(
        'view/unavailable-mode',
        `Device ${instance.device} declares a model, but the workbench provides no live proxy for it.`,
        { instanceId },
      );
    }
    return model;
  }

  function packageOf(lock: DeviceLock): Promise<VerifiedPackage> {
    const key = `${lock.id}@${lock.version}#${lock.integrity}`;
    let pending = packages.get(key);
    if (pending === undefined) {
      pending = openDevicePackage(options.registry, lock).catch((cause: unknown) => {
        packages.delete(key);
        throw cause;
      });
      packages.set(key, pending);
    }
    return pending;
  }

  function onFrameLoad(record: IHtmlViewRecord): void {
    if (record.state === 'closed' || record.state === 'failed') return;
    if (!record.loadSeen) {
      // The environment document is in place; only now can the bridge port be granted.
      record.loadSeen = true;
      connect(record);
      return;
    }
    // The environment left the document it was granted: the view is gone (RFC 0023). The author
    // document lives in the inner frame, so only a navigation of the trusted page reaches here.
    release(record);
  }

  function markReady(record: IHtmlViewRecord): void {
    if (record.state !== 'loading') return;
    clearTimer(record);
    record.state = 'ready';
    // Only now can the frame paint: the environment wrote the author document with its base, its
    // policy and the resolved theme, so the first visible frame is the themed document instead of
    // the white canvas of an unthemed one. The owner takes over the surface with the current theme
    // before the frame appears, so nothing of the container shows through the reveal.
    record.owner.style.background = htmlViewBackgroundColor(theme);
    record.frame.style.visibility = 'visible';
    emit('ready', record);
    sync(record);
  }

  function fault(record: IHtmlViewRecord, code: HtmlViewDiagnosticCode, message: string): void {
    if (record.state === 'failed' || record.state === 'closed') return;
    record.state = 'failed';
    record.failure = {
      code,
      message: bounded(message),
      instanceId: record.instanceId,
      viewId: record.viewId,
      title: record.title,
      device: record.device,
    };
    releaseResources(record);
    emit('failed', record);
    try {
      options.onDiagnostic?.(record.failure);
    } catch {
      // Diagnostics must not break the manager.
    }
  }

  /**
   * Retires the lease of one view, explicitly.
   *
   * A failed environment keeps its record and its failure until the workbench releases it, so one
   * failing view is never replaced by a fresh origin on its own.
   */
  function release(record: IHtmlViewRecord): void {
    if (record.state === 'closed') return;
    record.state = 'closed';
    records.delete(record.key);
    releaseResources(record);
    record.owner.remove();
    emit('closed', record);
  }

  function releaseResources(record: IHtmlViewRecord): void {
    clearTimer(record);
    if (record.slot !== null) {
      slotObserver?.unobserve(record.slot);
      record.slot = null;
    }
    for (const subscription of record.subscriptions.values()) {
      try {
        subscription.dispose();
      } catch {
        // A released model outlet may already be gone.
      }
    }
    record.subscriptions.clear();
    for (const listener of [...record.closeListeners]) {
      try {
        listener();
      } catch {
        // The environment may already be detached.
      }
    }
    record.closeListeners.clear();
    record.eventListeners.clear();
    const endpoints = [record.endpoint, record.assetEndpoint, record.contentEndpoint];
    record.endpoint = undefined;
    record.assetEndpoint = undefined;
    record.contentEndpoint = undefined;
    for (const endpoint of endpoints) {
      try {
        endpoint?.dispose();
      } catch {
        // The port may already be closed.
      }
    }
    record.owner.style.display = 'none';
    record.frame.remove();
  }

  function clearTimer(record: IHtmlViewRecord): void {
    if (record.timer === undefined) return;
    clearTimeout(record.timer);
    record.timer = undefined;
  }

  function close(instanceId: string, viewId: string): boolean {
    const key = htmlViewKey(instanceId, viewId);
    const pending = pendingOpens.get(key);
    // A release must also stop a preparation that has no record yet, e.g. the sidebar view of the
    // instance the user just deselected.
    pending?.cancel(
      releasedError(
        { instanceId, viewId },
        'The HTML view was released while its environment was still being prepared.',
      ),
    );
    const record = records.get(key);
    if (record !== undefined) release(record);
    return pending !== undefined || record !== undefined;
  }

  function closeAll(): void {
    for (const entry of [...pendingOpens.values()]) {
      entry.cancel(
        releasedError(entry, 'Every HTML view was released while this environment was pending.'),
      );
    }
    pendingOpens.clear();
    for (const record of [...records.values()]) release(record);
    records.clear();
  }

  function attachSlot(record: IHtmlViewRecord, slot: HTMLElement | null): void {
    const previous = record.slot;
    if (previous === slot) {
      sync(record);
      return;
    }
    record.slot = slot;
    if (previous !== null) slotObserver?.unobserve(previous);
    // A resizing sidebar or floating panel changes the slot box without a window resize.
    if (slot !== null) slotObserver?.observe(slot);
    sync(record);
  }

  function focus(instanceId: string, viewId: string): boolean {
    const record = records.get(htmlViewKey(instanceId, viewId));
    if (record === undefined) return false;
    focusRecord(record);
    return true;
  }

  function focusRecord(record: IHtmlViewRecord): void {
    record.visible = true;
    sync(record);
    try {
      record.frame.focus({ preventScroll: true });
    } catch {
      // A cross-origin frame may refuse focus; the UI still marks the view active.
    }
  }

  function refresh(): void {
    for (const record of records.values()) sync(record);
  }

  /** Coalesces scroll and resize churn into one measurement per animation frame. */
  function scheduleRefresh(): void {
    if (pendingFrame !== undefined) return;
    const schedule = win.requestAnimationFrame?.bind(win);
    if (schedule === undefined) {
      refresh();
      return;
    }
    pendingFrame = schedule(() => {
      pendingFrame = undefined;
      if (!disposed) refresh();
    });
  }

  function sync(record: IHtmlViewRecord): void {
    const slot = record.slot;
    // A failed view paints no frame any more; the container shows the failure in the slot itself.
    if (
      slot === null ||
      !record.visible ||
      record.state === 'closed' ||
      record.state === 'failed'
    ) {
      record.owner.style.display = 'none';
      return;
    }
    const rect = slot.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      record.owner.style.display = 'none';
      return;
    }
    // The owner always covers the whole slot; only the parts outside a scrolling ancestor, the
    // editor container or the viewport are clipped, so scrolling never reflows the author page.
    const clip = clipInsets(boxOf(rect), clipBoundsOf(slot));
    record.owner.style.display = clip.visible ? 'block' : 'none';
    record.owner.style.left = `${rect.left}px`;
    record.owner.style.top = `${rect.top}px`;
    record.owner.style.width = `${rect.width}px`;
    record.owner.style.height = `${rect.height}px`;
    record.owner.style.clipPath = clipPathOf(clip);
  }

  /** Clip boxes of one slot: its scrolling ancestors, the editor container and the viewport. */
  function clipBoundsOf(slot: HTMLElement): readonly IClipRect[] {
    const bounds: IClipRect[] = [];
    const viewportWidth = win.innerWidth ?? 0;
    const viewportHeight = win.innerHeight ?? 0;
    if (viewportWidth > 0 && viewportHeight > 0) {
      bounds.push({ left: 0, top: 0, right: viewportWidth, bottom: viewportHeight });
    }
    const container = options.container.getBoundingClientRect();
    if (container.width > 0 && container.height > 0) bounds.push(boxOf(container));
    for (let node = slot.parentElement; node !== null; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (!clipsOverflow(style.overflowX, style.overflowY)) continue;
      const rect = node.getBoundingClientRect();
      // The client box excludes borders and scrollbars: that is exactly the visible area.
      bounds.push({
        left: rect.left + node.clientLeft,
        top: rect.top + node.clientTop,
        right: rect.left + node.clientLeft + node.clientWidth,
        bottom: rect.top + node.clientTop + node.clientHeight,
      });
    }
    return bounds;
  }

  function layerElement(): HTMLElement {
    if (layer !== undefined) return layer;
    const element = doc.createElement('div');
    element.className = 'mica-html-view-layer';
    element.setAttribute('data-mica-html-views', '');
    element.style.cssText =
      'position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:2147483000;';
    options.container.append(element);
    layer = element;
    layerListeners.add({
      dispose: () => {
        win.removeEventListener('resize', scheduleRefresh);
        win.removeEventListener('scroll', scheduleRefresh, true);
        win.removeEventListener('message', onWindowMessage);
        if (pendingFrame !== undefined) win.cancelAnimationFrame?.(pendingFrame);
        pendingFrame = undefined;
        observer?.disconnect();
        observer = undefined;
        slotObserver?.disconnect();
        slotObserver = undefined;
      },
    });
    win.addEventListener('resize', scheduleRefresh);
    win.addEventListener('scroll', scheduleRefresh, true);
    win.addEventListener('message', onWindowMessage);
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => scheduleRefresh());
      observer.observe(options.container);
      slotObserver = new ResizeObserver(() => scheduleRefresh());
    }
    return element;
  }

  function onWindowMessage(event: MessageEvent): void {
    const data = event.data as Partial<IHtmlViewAckMessage> | null;
    if (data === null || typeof data !== 'object' || data.type !== HTML_VIEW_ACK) return;
    if (typeof data.token !== 'string') return;
    const record = [...records.values()].find((entry) => entry.token === data.token);
    if (record === undefined || record.state !== 'loading') return;
    // A stale page keeps its old token and a foreign window keeps its own source: both are ignored.
    if (event.source !== record.frame.contentWindow) return;
    if (event.origin !== new URL(record.environmentUrl).origin) return;
    clearTimer(record);
  }

  function ownerElement(
    instanceId: string,
    viewId: string,
    title: string,
    device: string,
  ): HTMLElement {
    const element = doc.createElement('div');
    element.className = 'mica-html-view-owner';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', `${device} ${title}`);
    element.dataset['instanceId'] = instanceId;
    element.dataset['viewId'] = viewId;
    element.style.position = 'absolute';
    element.style.display = 'none';
    element.style.overflow = 'hidden';
    element.style.pointerEvents = 'auto';
    // While the view loads, the container paints the surface and keeps its status text visible; the
    // owner stays transparent until `markReady` hands it the resolved theme.
    element.style.background = 'transparent';
    return element;
  }

  function frameElement(title: string, device: string, current: IHtmlViewTheme): HTMLIFrameElement {
    const frame = doc.createElement('iframe');
    frame.className = 'mica-html-view-frame';
    frame.title = `${title} — ${device}`;
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', '');
    frame.style.display = 'block';
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.border = '0';
    // The loading surface of this slot is the owner below, not the frame: a browser paints a white
    // canvas for a document that has not been themed yet, and that canvas would cover every
    // background of the element and of the embedding page. The frame therefore stays invisible but
    // fully alive (it loads, runs its bootstrap and keeps its driver identity) until the themed
    // author document is ready.
    frame.style.visibility = 'hidden';
    frame.style.background = htmlViewBackgroundColor(current);
    return frame;
  }

  function handleOf(record: IHtmlViewRecord): IHtmlViewHandle {
    const existing = record.handle;
    if (existing !== undefined) return existing;
    const handle: IHtmlViewHandle = {
      key: record.key,
      instanceId: record.instanceId,
      viewId: record.viewId,
      title: record.title,
      device: record.device,
      entry: record.entry,
      get location() {
        return record.location;
      },
      get state() {
        return record.state;
      },
      get failure() {
        return record.failure;
      },
      element: record.owner,
      attach(slot) {
        attachSlot(record, slot);
      },
      setVisible(visible) {
        record.visible = visible;
        sync(record);
      },
      setLocation(location) {
        if (record.location === location) return;
        record.location = location;
        emit('moved', record);
      },
      focus() {
        focusRecord(record);
      },
      close() {
        release(record);
      },
    };
    record.handle = handle;
    return handle;
  }

  function emit(type: HtmlViewChangeType, record: IHtmlViewRecord): void {
    if (disposed) return;
    changes.fire({ type, handle: handleOf(record) });
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    for (const entry of [...pendingOpens.values()]) {
      entry.cancel(
        releasedError(entry, 'The HTML view host was disposed while this environment was pending.'),
      );
    }
    pendingOpens.clear();
    for (const record of [...records.values()]) {
      record.state = 'closed';
      releaseResources(record);
      record.owner.remove();
    }
    records.clear();
    for (const pending of packages.values()) void pending.catch(() => undefined);
    packages.clear();
    layerListeners.dispose();
    observer?.disconnect();
    observer = undefined;
    slotObserver?.disconnect();
    slotObserver = undefined;
    layer?.remove();
    layer = undefined;
    changes.dispose();
    themeChanges.dispose();
  }
}

function boxOf(rect: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): IClipRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  };
}

function clipsOverflow(x: string, y: string): boolean {
  const clips = (value: string): boolean =>
    value === 'auto' || value === 'scroll' || value === 'hidden' || value === 'clip';
  return clips(x) || clips(y);
}

function createToken(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Code of one failure, so a runtime `model/disconnected` stays visible to the workbench. */
function failureCodeOf(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return 'unknown';
  const code = (cause as { readonly code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return code;
  const name = (cause as { readonly name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : 'unknown';
}

/** Transfer list of one granted direct port. */
function transferPort(value: unknown): readonly Transferable[] {
  return typeof MessagePort !== 'undefined' && value instanceof MessagePort ? [value] : [];
}

function bounded(message: string): string {
  const text = typeof message === 'string' ? message : String(message);
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}
