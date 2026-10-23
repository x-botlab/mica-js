import {
  CANVAS_VERSION,
  applyCanvasCommand,
  assertCanvasBindings,
  parseCanvas,
} from '@mica-js/core/canvas';
import type {
  CanvasCommand,
  CanvasDocument,
  CanvasWidgetInstance,
  WidgetPlacement,
} from '@mica-js/core/canvas';
import {
  WIDGET_ASSET_FAILED_EVENT,
  WIDGET_DELIVER_METHOD,
  WIDGET_ERROR_EVENT,
  WIDGET_FRAME_EVENT,
  WIDGET_LOAD_METHOD,
  WIDGET_MOUNT_METHOD,
  WIDGET_POINTER_METHOD,
  WIDGET_PUBLISH_EVENT,
  WIDGET_RESET_RUNTIME_METHOD,
  WIDGET_RESIZE_METHOD,
  WIDGET_SET_PROPERTIES_METHOD,
  WIDGET_UNMOUNT_METHOD,
} from '../runtime/protocol';
import type {
  WidgetAssetFailedMessage,
  WidgetErrorMessage,
  WidgetFrameMessage,
  WidgetPublishMessage,
} from '../runtime/protocol';
import { collectAssetRefs, mergeProperties } from '../runtime/props';
import type { WidgetInputEvent } from '../runtime/types';
import type { WidgetModule } from '../types';
import { WidgetLayerStore } from './layers';
import { createDefaultWidgetSandbox } from './sandbox';
import type {
  WidgetAssetSource,
  WidgetDiagnostic,
  WidgetDiagnosticCode,
  WidgetHost,
  WidgetHostOptions,
  WidgetLayers,
  WidgetPublish,
  WidgetSandbox,
  WidgetSandboxFactory,
  WidgetSize,
} from './types';

interface InstanceRecord {
  readonly widget: string;
  /** Identifies the mount attempt that reserved this id, so late callbacks cannot adopt it. */
  readonly token: symbol;
  /** Placement last applied to this instance, so a pass can tell a real edit from a rewrite. */
  placement: WidgetPlacement;
  props: Readonly<Record<string, unknown>>;
}

/** Host state before any document was loaded. */
const EMPTY_DOCUMENT: CanvasDocument = { version: CANVAS_VERSION, widgets: [] };

/** Startup or shutdown failure; already reported, so call sites must not report it twice. */
class WidgetRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WidgetRuntimeError';
  }
}

/**
 * The instance was removed (or the host disposed) while its mount was in flight. Rejecting keeps
 * `mount()` honest instead of resolving for an instance that no longer has a layer.
 */
class WidgetMountCancelledError extends Error {
  constructor(instanceId: string) {
    super(`Mount of widget instance "${instanceId}" was cancelled before it finished`);
    this.name = 'WidgetMountCancelledError';
  }
}

/**
 * Creates the widget host.
 *
 * The document is the single source of truth: instances are mounted, resized, repropped and
 * reordered to match it. The sandbox starts lazily on the first instance and every concurrent mount
 * shares that one startup, so a host with no instances never pays for an iframe and a worker. After
 * a crash the next reconciliation starts a fresh sandbox instead of rebuilding instances
 * automatically.
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
  readonly #assets: WidgetAssetSource | undefined;
  readonly #catalog: WidgetHostOptions['catalog'];
  readonly #createSandbox: WidgetSandboxFactory;
  readonly #layerStore = new WidgetLayerStore();
  readonly #instances = new Map<string, InstanceRecord>();
  readonly #detachers: (() => void)[] = [];
  readonly #documentListeners = new Set<(document: CanvasDocument) => void>();

  #document: CanvasDocument = EMPTY_DOCUMENT;
  #reconcilePending = false;
  /** The next coordination pass has to reset the guest before it syncs instances. */
  #resetPending = false;
  #reconcilePass: Promise<void> | undefined;
  /** Identifies the drain that owns {@link #reconcilePass}; only that drain may release it. */
  #reconcileOwner = 0;
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
    this.#assets = options.assets;
    this.#catalog = options.catalog;
    this.#createSandbox = options.sandbox ?? createDefaultWidgetSandbox;
    this.#dpr = options.dpr ?? currentDevicePixelRatio();
  }

  get document(): CanvasDocument {
    return this.#document;
  }

  async loadDocument(source: string | CanvasDocument): Promise<void> {
    const document = parseCanvas(source);
    this.#assertBindings(document);
    this.#commit(document);
    const pass = this.#scheduleReconcile();
    this.#emitDocument(document);
    await pass;
  }

  applyCommand(command: CanvasCommand): void {
    // Both steps throw before the snapshot is committed, so a rejected command changes nothing.
    const document = applyCanvasCommand(this.#document, command);
    this.#assertBindings(document);
    this.#commit(document);
    void this.#scheduleReconcile();
    this.#emitDocument(document);
  }

  onDocumentChange(listener: (document: CanvasDocument) => void): () => void {
    this.#documentListeners.add(listener);
    return () => {
      this.#documentListeners.delete(listener);
    };
  }

  reset(): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new WidgetRuntimeError('Widget host is disposed'));
    }
    // Clear synchronously so `layers` is empty the moment the caller asks: the editor paints
    // placeholder frames until the remount commits new bitmaps.
    this.#instances.clear();
    this.#layerStore.clear();
    this.#resetPending = true;
    // Same queue as every other mutation, so a reset never interleaves with an in-flight mount.
    return this.#scheduleReconcile();
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

  /** Runs the binding checks both document entry points share; nothing needs them without a catalog. */
  #assertBindings(document: CanvasDocument): void {
    assertCanvasBindings(document, this.#catalog === undefined ? {} : { catalog: this.#catalog });
  }

  /**
   * Makes `document` the new snapshot and drops the instances it no longer lists.
   *
   * Removal is synchronous on purpose: a mount still in flight for a removed id has to be cancelled
   * right away, while the coordination pass that would have removed it may be blocked on it.
   */
  #commit(document: CanvasDocument): void {
    this.#document = document;
    const live = new Set(document.widgets.map((widget) => widget.id));
    for (const instanceId of [...this.#instances.keys()]) {
      if (!live.has(instanceId)) this.#unmount(instanceId);
    }
  }

  /**
   * Queues a coordination pass and returns the running queue.
   *
   * A pass reads {@link document} per instance, so everything committed while it waits is coalesced
   * into the next iteration; the promise settles only once the queue has caught up.
   *
   * The drain starts on a microtask instead of from here: {@link #syncInstances} notifies the layer
   * store synchronously from inside a guest await, and a subscriber that applies a command from that
   * notification would otherwise re-enter while the slot below is still empty and start a second,
   * concurrent drain.
   */
  #scheduleReconcile(): Promise<void> {
    this.#reconcilePending = true;
    this.#reconcilePass ??= Promise.resolve().then(() => this.#drainReconcile());
    return this.#reconcilePass;
  }

  async #drainReconcile(): Promise<void> {
    const owner = ++this.#reconcileOwner;
    try {
      while (this.#reconcilePending && !this.#disposed) {
        this.#reconcilePending = false;
        if (this.#resetPending) {
          this.#resetPending = false;
          await this.#resetGuestRuntime();
        }
        await this.#syncInstances();
      }
    } finally {
      // A stale finish must never untrack a newer pass that is still mounting, so only the drain
      // that owns the slot releases it.
      if (this.#reconcileOwner === owner) {
        this.#reconcilePending = false;
        this.#reconcilePass = undefined;
      }
    }
  }

  /** Mounts, resizes, sets properties and reorders instances to match the document. */
  async #syncInstances(): Promise<void> {
    for (const { id: instanceId } of this.#document.widgets) {
      if (this.#disposed) return;
      // A newer snapshot may have dropped this id while the previous instance was mounting.
      const widget = this.#document.widgets.find((entry) => entry.id === instanceId);
      if (widget === undefined) continue;
      await this.#syncInstance(widget);
    }
    this.#layerStore.reorder(this.#document.widgets.map((widget) => widget.id));
  }

  async #syncInstance(widget: CanvasWidgetInstance): Promise<void> {
    const existing = this.#instances.get(widget.id);
    if (existing === undefined) {
      await this.#mount(widget);
      return;
    }
    if (existing.widget !== widget.widget) {
      // Nothing in the document retargets an instance in place, so replacing it is the only way to
      // keep one layer from mixing two widget definitions.
      this.#unmount(widget.id);
      await this.#mount(widget);
      return;
    }

    const placement = placementOf(widget);
    // `x`, `y` and `rotation` only move the composite position, which the document already carries;
    // only a size change has to reach the guest.
    if (
      placement.width !== existing.placement.width ||
      placement.height !== existing.placement.height
    ) {
      this.#update(widget.id, { width: placement.width, height: placement.height });
    }
    existing.placement = placement;

    const props = widget.properties ?? {};
    if (!sameProperties(existing.props, props)) this.#setProperties(widget.id, props);
  }

  /**
   * Mounts one document instance. Failures stay inside that instance: the mount attempt already
   * reported its own diagnostic, and the document is never rolled back for it.
   */
  async #mount(widget: CanvasWidgetInstance): Promise<void> {
    try {
      await this.#startInstance(widget);
    } catch {
      // Already reported, or a newer snapshot cancelled this mount; the next pass resumes from the
      // current document either way.
    }
  }

  async #startInstance(widget: CanvasWidgetInstance): Promise<void> {
    const { id: instanceId, widget: ref } = widget;

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

    // Reserve the id before the first await: a concurrent mount of the same instance now loses
    // here instead of racing into the guest and tearing down the winner's record and layer.
    const record: InstanceRecord = {
      widget: ref,
      token: Symbol(instanceId),
      placement: placementOf(widget),
      props: widget.properties ?? {},
    };
    this.#instances.set(instanceId, record);
    this.#layerStore.add({
      instanceId,
      width: widget.width,
      height: widget.height,
      dpr: this.#dpr,
    });
    this.#layerStore.reorder(this.#document.widgets.map((entry) => entry.id));

    let mounted = false;
    try {
      mounted = await this.#mountInstance(instanceId, ref, record);
    } finally {
      // A cancelled or failed attempt only drops its own reservation.
      if (!mounted) this.#forget(instanceId, record);
    }
  }

  /**
   * Runs one mount attempt; every await re-checks that this attempt still owns the id.
   *
   * @returns always `true`; a cancelled attempt throws instead of reporting success.
   */
  async #mountInstance(instanceId: string, ref: string, record: InstanceRecord): Promise<boolean> {
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
      return false;
    }
    this.#requireOwnership(instanceId, record);

    const sandbox = await this.#ensureSandbox();
    this.#requireOwnership(instanceId, record);

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
      this.#requireOwnership(instanceId, record);

      // The guest merges defaults again on its own, so a definition that changes between load and
      // mount still behaves the same on both sides of the boundary.
      const props = mergeProperties(module.definition?.properties, record.props);
      const assets = await this.#prefetchAssets(instanceId, ref, props);
      this.#requireOwnership(instanceId, record);

      const layer = this.#layerStore.get(instanceId);
      if (!layer) throw new WidgetMountCancelledError(instanceId);
      await sandbox.call(WIDGET_MOUNT_METHOD, {
        instanceId,
        widget: ref,
        width: layer.width,
        height: layer.height,
        dpr: layer.dpr,
        props,
        ...(assets === undefined ? {} : { assets }),
      });
    } catch (error) {
      if (error instanceof WidgetRuntimeError) throw error;
      if (error instanceof WidgetMountCancelledError) throw error;
      // Disposal is the caller's own doing, not a widget failure; report it as a cancellation.
      if (this.#disposed) throw new WidgetMountCancelledError(instanceId);
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

    if (!this.#owns(instanceId, record)) {
      // The mount was cancelled while the guest was creating the instance. Release that session,
      // otherwise an unmounted id keeps a canvas, subscriptions and timers alive for good. A newer
      // record for the same id is skipped: the guest keys sessions by id, so a late release would
      // tear down the replacement's session instead of ours.
      if (!this.#instances.has(instanceId)) {
        await releaseGuestInstance(sandbox, instanceId);
      }
      throw new WidgetMountCancelledError(instanceId);
    }
    return true;
  }

  #unmount(instanceId: string): void {
    const instance = this.#instances.get(instanceId);
    if (!instance) {
      this.#report('widget/instance-not-found', `Widget instance "${instanceId}" is not mounted.`, {
        instanceId,
      });
      return;
    }

    this.#forget(instanceId, instance);
    this.#fire(undefined, WIDGET_UNMOUNT_METHOD, [instanceId], instanceId);
  }

  #update(instanceId: string, size: WidgetSize): void {
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

  #setProperties(instanceId: string, props: Readonly<Record<string, unknown>>): void {
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

  #requireInstance(instanceId: string): InstanceRecord | undefined {
    const instance = this.#instances.get(instanceId);
    if (!instance) {
      this.#report('widget/instance-not-found', `Widget instance "${instanceId}" is not mounted.`, {
        instanceId,
      });
    }
    return instance;
  }

  /** True while `record` is still the live record for this id in an undisposed host. */
  #owns(instanceId: string, record: InstanceRecord): boolean {
    return !this.#disposed && this.#instances.get(instanceId) === record;
  }

  /** Aborts a mount attempt whose instance was removed or replaced while it awaited. */
  #requireOwnership(instanceId: string, record: InstanceRecord): void {
    if (!this.#owns(instanceId, record)) {
      throw new WidgetMountCancelledError(instanceId);
    }
  }

  /** Drops this attempt's reservation and layer; a newer record for the same id is left alone. */
  #forget(instanceId: string, record: InstanceRecord): void {
    if (this.#instances.get(instanceId) !== record) return;
    this.#instances.delete(instanceId);
    this.#layerStore.remove(instanceId);
  }

  /**
   * Asks the guest to release its sessions.
   *
   * The guest keeps its evaluated modules: a reset rebuilds instances, so module-level state is out
   * of scope by contract and the factories stay warm. A host without a sandbox has nothing to
   * reset: no instance ever mounted, so the following sync pass simply mounts into a fresh runtime.
   * Failures are reported, never thrown: the remount below resumes from whatever state the guest is
   * in.
   */
  async #resetGuestRuntime(): Promise<void> {
    if (!this.#sandbox && !this.#starting) return;
    try {
      const sandbox = await this.#ensureSandbox();
      if (this.#disposed) return;
      await sandbox.call(WIDGET_RESET_RUNTIME_METHOD);
    } catch (error) {
      if (this.#disposed || error instanceof WidgetRuntimeError) return;
      if (this.#isTerminated()) {
        this.#failRuntime('The widget sandbox terminated during reset.');
        return;
      }
      this.#report(
        'widget/runtime-failed',
        `The widget runtime could not be reset: ${describeError(error)}`,
      );
    }
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

  /**
   * Reads every asset reference found in the merged props. Failures are reported and skipped:
   * a missing image must not stop the instance from mounting.
   */
  async #prefetchAssets(
    instanceId: string,
    ref: string,
    props: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, Uint8Array> | undefined> {
    const source = this.#assets;
    if (!source) return undefined;

    const refs = collectAssetRefs(props);
    const entries = await Promise.all(
      [...refs.values()].map(async (assetRef): Promise<[string, Uint8Array] | undefined> => {
        try {
          const bytes = await source.read(assetRef);
          if (!(bytes instanceof Uint8Array)) {
            throw new TypeError('WidgetAssetSource.read() must resolve to a Uint8Array');
          }
          return [assetRef.src, bytes];
        } catch (error) {
          this.#report(
            'widget/asset-failed',
            `Widget asset "${assetRef.src}" for "${ref}" could not be read: ${describeError(error)}`,
            { instanceId, widget: ref },
          );
          return undefined;
        }
      }),
    );

    return Object.fromEntries(
      entries.filter((entry): entry is [string, Uint8Array] => entry !== undefined),
    );
  }

  #attach(sandbox: WidgetSandbox): void {
    this.#detachers.push(
      sandbox.on(WIDGET_FRAME_EVENT, (payload) => this.#onFrame(payload)),
      sandbox.on(WIDGET_PUBLISH_EVENT, (payload) => this.#onPublishMessage(payload)),
      sandbox.on(WIDGET_ERROR_EVENT, (payload) => this.#onErrorMessage(payload)),
      sandbox.on(WIDGET_ASSET_FAILED_EVENT, (payload) => this.#onAssetFailedMessage(payload)),
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
      // The host has no simulation clock yet; a widget that knows its simTime passes one.
      simTime:
        typeof message.simTime === 'number' && Number.isFinite(message.simTime)
          ? message.simTime
          : 0,
    });
  }

  #onAssetFailedMessage(payload: unknown): void {
    const message = payload as Partial<WidgetAssetFailedMessage> | null | undefined;
    if (!message || typeof message !== 'object') return;
    if (typeof message.instanceId !== 'string') return;

    const src = typeof message.src === 'string' ? message.src : 'unknown';
    const name = message.error?.name ?? 'Error';
    const text = message.error?.message ?? 'Unknown asset failure';
    this.#report(
      'widget/asset-failed',
      `Widget "${message.instanceId}" could not read asset "${src}": ${name}: ${text}`,
      {
        instanceId: message.instanceId,
        widget: this.#instances.get(message.instanceId)?.widget,
      },
    );
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

  #emitDocument(document: CanvasDocument): void {
    for (const listener of [...this.#documentListeners]) {
      try {
        listener(document);
      } catch (error) {
        console.error('[@mica-js/widget] document listener threw', error);
      }
    }
  }
}

function placementOf(widget: CanvasWidgetInstance): WidgetPlacement {
  return {
    x: widget.x,
    y: widget.y,
    width: widget.width,
    height: widget.height,
    rotation: widget.rotation,
  };
}

/**
 * Shallow comparison of two property maps.
 *
 * The document owns property values, so a nested object only counts as changed when the caller
 * replaced the object itself; deep equality would swallow those edits. The key sets matter as much
 * as the values, because a missing key falls back to the definition default while an explicit
 * `undefined` overrides it.
 */
function sameProperties(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  if (left === right) return true;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
  );
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

/** Asks the guest to drop an instance the host has already given up on. */
async function releaseGuestInstance(sandbox: WidgetSandbox, instanceId: string): Promise<void> {
  try {
    await sandbox.call(WIDGET_UNMOUNT_METHOD, instanceId);
  } catch {
    // The guest never created the instance, or the sandbox is already gone.
  }
}
