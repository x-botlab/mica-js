import {
  CANVAS_VERSION,
  applyCanvasCommand,
  assertCanvasBindings,
  parseCanvas,
  validateCanvasBindings,
} from '@mica-js/core/canvas';
import type {
  CanvasBindingTarget,
  CanvasCommand,
  CanvasDocument,
  CanvasWidgetInstance,
  WidgetPlacement,
} from '@mica-js/core/canvas';
import {
  widgetAssetFailedEvent,
  widgetDeliverMethod,
  widgetErrorEvent,
  widgetFrameEvent,
  widgetLoadMethod,
  widgetMountMethod,
  widgetPointerMethod,
  widgetPublishEvent,
  widgetResetRuntimeMethod,
  widgetResizeMethod,
  widgetSetBindingsMethod,
  widgetSetPropertiesMethod,
  widgetUnmountMethod,
} from '../guest/widget/protocol';
import type {
  WidgetAssetFailedMessage,
  WidgetErrorMessage,
  WidgetFrameMessage,
  WidgetPublishMessage,
} from '../guest/widget/protocol';
import type { WidgetAudioMountInfo, WidgetAudioState } from '../guest/audio/protocol';
import { WidgetAudioEngine } from './audio/engine';
import type {
  AudioContextLike,
  AudioNodeLike,
  AudioWorkletNodeLike,
  WidgetAudioEngineOptions,
} from './audio/engine';
import type { WidgetAudioControls } from './audio/types';
import { NO_AUDIO_CONTROLS } from './audio/noop';
import { decodeDataUri, decodeDataUriText } from '../host-fs/data-uri';
import { HostFsError } from '../host-fs/errors';
import type { HostFs } from '../host-fs/types';
import { isAbsoluteHostUri, resolveHostUri } from '../host-fs/uri';
import { collectAssetRefs, mergeProperties } from '../guest/widget/props';
import type { WidgetAssetRef, WidgetInputEvent } from '../guest/widget/types';
import type { WidgetModule, WidgetProvider } from '../types';
import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type { DeviceSimulationHost, SimulationPublish } from '@mica-js/simulator';
import { HostBindingCatalog } from './catalog';
import { WidgetStore, sameRecord } from './widgets';
import type {
  Widget,
  WidgetAssetProvider,
  WidgetDiagnostic,
  WidgetDiagnosticCode,
  WidgetHost,
  WidgetHostMode,
  WidgetHostOptions,
  WidgetInstance,
  WidgetLayers,
  WidgetPublish,
  WidgetSandbox,
  WidgetSandboxFactory,
} from './types';
interface InstanceRecord {
  readonly widget: string;
  /** Identifies the mount attempt that reserved this id, so late callbacks cannot adopt it. */
  readonly token: symbol;
  /** Placement last applied to this instance, so a pass can tell a real edit from a rewrite. */
  placement: WidgetPlacement;
  props: Readonly<Record<string, unknown>>;
  /** Binding map last handed to the guest, so an unchanged document sends nothing. */
  bindings: Readonly<Record<string, CanvasBindingTarget>>;
  /** `src` of every asset the mounted props referenced; the guest only holds prefetched bytes. */
  assets: ReadonlySet<string>;
  /** Audio session this attempt opened, released even when a newer record takes the id. */
  audioSession?: string;
}

/** Host state before any document was loaded. */
const EMPTY_DOCUMENT: CanvasDocument = { version: CANVAS_VERSION, widgets: [] };

/** One fixed step, in milliseconds; the host converts it to picoseconds for the simulator. */
const DEFAULT_STEP_MS = 25;
const PS_PER_MS = 1_000_000_000;

interface FrameClockOptions {
  readonly stepMs: number;
  readonly requestFrame: (callback: () => void) => () => void;
}

function defaultRequestFrame(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(timer);
  };
}

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
export function createWidgetHost(
  options: WidgetHostOptions,
  createSandbox: WidgetSandboxFactory,
): WidgetHost {
  return new WidgetHostImpl(options, createSandbox);
}

class WidgetHostImpl implements WidgetHost {
  readonly #provider: WidgetProvider;
  readonly #fs: HostFs | undefined;
  readonly #container: HTMLElement | undefined;
  readonly #onDiagnostic: ((diagnostic: WidgetDiagnostic) => void) | undefined;
  readonly #onPublish: ((publish: WidgetPublish) => void) | undefined;
  readonly #assets: WidgetAssetProvider | undefined;
  readonly #catalog: WidgetHostOptions['catalog'];
  /** Catalog assembled from the widget provider and the running simulation (RFC 0018). */
  readonly #autoCatalog = new HostBindingCatalog();
  readonly #deviceHost: DeviceSimulationHost;
  #mode: WidgetHostMode;
  readonly #frameOptions: FrameClockOptions;
  readonly #createSandbox: WidgetSandboxFactory;
  readonly #audio: WidgetAudioEngine | undefined;
  readonly #store = new WidgetStore();
  readonly #instances = new Map<string, InstanceRecord>();
  readonly #detachers: (() => void)[] = [];
  readonly #documentListeners = new Set<(document: CanvasDocument) => void>();
  /** Input events waiting for the next step start; only used while a frame clock runs. */
  readonly #pendingInputs: { readonly instanceId: string; readonly event: WidgetInputEvent }[] = [];

  /** `WidgetHost.audio`; a no-op control surface when no audio was configured. */
  readonly audio: WidgetAudioControls;
  /** Port the worklet handed over before a sandbox existed; flushed on the next attach. */
  #pendingAudioPort: MessagePort | undefined;
  /** Latest availability, replayed to a sandbox that was created after the change. */
  #lastAudioState: WidgetAudioState | undefined;

  #document: CanvasDocument = EMPTY_DOCUMENT;
  /** Instances whose binding diagnostics prevent guest mounting for the current snapshot. */
  #bindingSkipped = new Set<string>();
  /** URI the current snapshot was read from; `undefined` for the parsed-document entry. */
  #documentUri: string | undefined;
  /** Absolute URI of the schematic the runtime was told to load. */
  #schematicUri: string | undefined;
  #unsubscribeDevicePublish: Disposable | undefined;
  #cancelFrame: (() => void) | undefined;
  #paused = false;
  #advancing = false;
  /** Whether a document was loaded; only then does the clock have something to advance. */
  #loaded = false;
  /** Last simulation time reported by the device host, used as a publish timestamp fallback. */
  #simTime = 0;
  /**
   * Last payload the simulation published per endpoint.
   *
   * A level topic only publishes when it changes, so an instance that mounts afterwards is seeded
   * from here instead of waiting for a change that may never come.
   */
  readonly #lastPublished = new Map<string, SimulationPublish>();
  #reconcilePending = false;
  /** The next coordination pass has to reset the guest before it syncs instances. */
  #resetPending = false;
  /** The next coordination pass has to reset the device before it resets the guest. */
  #deviceResetPending = false;
  /** The next coordination pass has to re-read the document and reload the schematic. */
  #reloadPending = false;
  #reloadSchematicPending = false;
  #reconcilePass: Promise<void> | undefined;
  /** Identifies the drain that owns {@link #reconcilePass}; only that drain may release it. */
  #reconcileOwner = 0;
  /**
   * One end of the direct device channel, consumed by the first sandbox this host starts.
   *
   * It is transferred to the guest at startup, so it cannot be reused: a restart runs in fallback.
   */
  #devicePort: MessagePort | undefined;
  /** True while the running guest owns the direct device channel and routes topic traffic itself. */
  #directDevice = false;
  #sandbox: WidgetSandbox | undefined;
  #starting: Promise<WidgetSandbox> | undefined;
  #disposing: Promise<void> | undefined;
  #disposed = false;
  #dpr: number;

  constructor(options: WidgetHostOptions, createSandbox: WidgetSandboxFactory) {
    const provider = options.widgetProvider ?? options.provider;
    if (provider === undefined) {
      throw new TypeError('createWidgetHost requires a widgetProvider');
    }
    this.#provider = provider;
    this.#fs = options.fs;
    this.#container = options.container;
    this.#onDiagnostic = options.onDidReportDiagnostic ?? options.onDiagnostic;
    this.#onPublish = options.onDidPublish ?? options.onPublish;
    this.#assets = options.assets;
    this.#catalog = options.catalog;
    this.#deviceHost = options.deviceHost;
    this.#devicePort = options.devicePort;
    this.#mode = options.mode ?? 'simulation';
    const frame = options.frame;
    const stepMs =
      frame?.stepMs !== undefined && Number.isFinite(frame.stepMs) && frame.stepMs > 0
        ? frame.stepMs
        : DEFAULT_STEP_MS;
    this.#frameOptions = {
      // The public interval is milliseconds; the simulator remains expressed in picoseconds.
      stepMs,
      requestFrame: frame?.requestFrame ?? ((callback) => defaultRequestFrame(callback, stepMs)),
    };
    this.#createSandbox = createSandbox;
    this.#dpr = options.dpr ?? currentDevicePixelRatio();

    let audio: WidgetAudioEngine | undefined;
    if (options.audio !== undefined) {
      const getAudioWorklet = options.audio.getAudioWorklet;
      const context = options.audio.context;
      const audioOptions: WidgetAudioEngineOptions = {
        context: context as unknown as AudioContextLike,
        report: (code, instanceId, message) =>
          this.#report(code, message, this.#instanceIds(instanceId)),
        notify: {
          emitPort: (port) => this.#emitAudioPort(port),
          emitState: (state) => this.#emitAudioState(state),
        },
      };
      if (options.audio.destination !== undefined) {
        Object.assign(audioOptions, {
          destination: options.audio.destination as unknown as AudioNodeLike,
        });
      }
      if (getAudioWorklet !== undefined) {
        Object.assign(audioOptions, {
          loadWorklet: () => getAudioWorklet(context) as Promise<AudioWorkletNodeLike>,
        });
      }
      if (options.audio.limits !== undefined) {
        Object.assign(audioOptions, { limits: options.audio.limits });
      }
      audio = new WidgetAudioEngine(audioOptions);
    }
    this.#audio = audio;
    this.audio = this.#audio ?? NO_AUDIO_CONTROLS;
    this.#unsubscribeDevicePublish = this.#deviceHost.onDidPublish((publish) => {
      if (this.#mode === 'simulation') this.#onSimulationPublish(publish);
    });
  }

  getDocument(): CanvasDocument {
    return this.#document;
  }

  getMode(): WidgetHostMode {
    return this.#mode;
  }

  async setMode(mode: WidgetHostMode): Promise<void> {
    if (this.#disposed) throw new WidgetRuntimeError('Widget host is disposed');
    if (mode === this.#mode) return;

    const previous = this.#mode;
    this.#stopClock();
    this.#pendingInputs.length = 0;
    try {
      this.#clearWidgetInstances();
      this.#resetPending = true;
      this.#deviceResetPending = true;
      this.#reloadPending = false;
      this.#reloadSchematicPending = false;
      this.#mode = mode;
      await this.#scheduleReconcile();
      if (this.#mode === 'simulation' && this.#loaded && !this.#paused) this.#startClock();
    } catch (error) {
      this.#mode = previous;
      if (previous === 'simulation' && this.#loaded && !this.#paused) this.#startClock();
      throw error;
    }
  }

  getLayers(): WidgetLayers {
    return this.#store;
  }

  listInstances(): readonly WidgetInstance[] {
    return this.#store.listInstances();
  }

  onDidAddWidget: Event<Widget> = this.#store.onDidAddWidget;

  onDidChangeWidget: Event<Widget> = this.#store.onDidChangeWidget;

  onDidRemoveWidget: Event<string> = this.#store.onDidRemoveWidget;

  onDidReorderWidgets: Event<readonly string[]> = this.#store.onDidReorderWidgets;

  invalidate(): void {
    if (this.#disposed) return;
    this.#store.invalidate();
  }

  pause(): void {
    this.#paused = true;
    this.#stopClock();
  }

  resume(): void {
    if (this.#disposed) return;
    this.#paused = false;
    // The clock re-times from now: the time spent paused never becomes backlog.
    if (this.#loaded) this.#startClock();
  }

  async loadDocument(source: CanvasDocument | string): Promise<void> {
    const documentUri = typeof source === 'string' ? source : undefined;
    const input = documentUri === undefined ? source : await this.#readDocumentText(documentUri);
    const parsed = parseCanvas(input);
    // RFC 0018 steps 2–5: the schematic is loaded before instances mount, and a schematic that
    // cannot be read or parsed rejects the whole load instead of mounting half a canvas. Bindings
    // validate afterwards, because the catalog can only resolve symbols of the loaded schematic;
    // a rejected check still leaves the previous document and instances in place.
    const schematicUri = this.#resolveSchematicUri(parsed, documentUri);
    await this.#loadSchematic(schematicUri);
    // RFC 0018: the host assembles the binding catalog from what is now running, so the checks see
    // the endpoints of the schematic that was just loaded rather than the previous one.
    await this.#refreshCatalog(parsed, parsed.schematic, schematicUri);
    const bindingSkipped = this.#bindingSkipIds(parsed);
    this.#documentUri = documentUri;
    this.#schematicUri = schematicUri;
    this.#commit(parsed, bindingSkipped);
    const pass = this.#scheduleReconcile();
    this.#emitDocument(parsed);
    await pass;
    this.#loaded = true;
    if (this.#mode === 'simulation') this.#startClock();
  }

  /**
   * Reads a document URI: `data:` decodes locally, every other scheme goes through `fs`.
   *
   * Relative references never reach the reader; the caller supplies an absolute URI, which is also
   * what `HostFs.read` expects.
   */
  async #readDocumentText(uri: string): Promise<string> {
    if (!isAbsoluteHostUri(uri)) {
      throw new TypeError(`WidgetHost.loadDocument requires an absolute URI: ${uri}`);
    }
    if (uri.slice(0, 5).toLowerCase() === 'data:') {
      return decodeDataUriText(uri);
    }
    const fs = this.#fs;
    if (fs === undefined) {
      throw new HostFsError(
        'NoFileSystem',
        uri,
        'WidgetHost has no HostFs configured to read this document URI',
      );
    }
    return new TextDecoder().decode(await fs.read(uri));
  }

  /**
   * Resolves the document's `schematic` reference against the canvas URI.
   *
   * `undefined` clears the runtime. An absolute reference passes through; a relative one needs the
   * canvas URI as its base, so the parsed-document form can only carry absolute references.
   */
  #resolveSchematicUri(
    document: CanvasDocument,
    documentUri: string | undefined,
  ): string | undefined {
    const schematic = document.schematic;
    if (schematic === undefined || schematic === '') return undefined;
    if (documentUri === undefined) return schematic;
    return resolveHostUri(documentUri, schematic);
  }

  /** Loads (or clears) the schematic on the device host. */
  async #loadSchematic(uri: string | undefined): Promise<void> {
    await this.#deviceHost.loadSchematic(uri);
  }

  applyCommand(command: CanvasCommand): void {
    // Both steps throw before the snapshot is committed, so a rejected command changes nothing.
    const document = applyCanvasCommand(this.#document, command);
    const bindingSkipped = this.#bindingSkipIds(document);
    this.#commit(document, bindingSkipped);
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
    return this.#resetRuntime({
      reloadDocument: this.#documentUri !== undefined,
      reloadSchematic: this.#schematicUri !== undefined,
      resetDevice: true,
    });
  }

  #clearWidgetInstances(): void {
    for (const instanceId of this.#instances.keys()) {
      this.#audio?.close(instanceId);
    }
    this.#instances.clear();
    this.#store.clear();
  }

  async #resetRuntime(options: {
    readonly reloadDocument: boolean;
    readonly reloadSchematic: boolean;
    readonly resetDevice: boolean;
  }): Promise<void> {
    this.#stopClock();
    this.#pendingInputs.length = 0;
    this.#clearWidgetInstances();
    this.#resetPending = true;
    this.#deviceResetPending = options.resetDevice;
    this.#reloadPending = options.reloadDocument;
    this.#reloadSchematicPending = options.reloadSchematic;
    await this.#scheduleReconcile();
    if (this.#mode === 'simulation' && this.#loaded && !this.#paused) this.#startClock();
  }

  deliver(instanceId: string, port: string, payload: unknown, simTime: number): void {
    if (!this.#requireInstance(instanceId)) return;
    this.#fire(
      'widget/deliver-failed',
      widgetDeliverMethod,
      [instanceId, port, payload, simTime],
      instanceId,
    );
  }

  dispatch(instanceId: string, event: WidgetInputEvent): void {
    if (!this.#requireInstance(instanceId)) return;
    // RFC 0018: input arrives whenever it wants and is dispatched at the next step start.
    if (this.#loaded) {
      this.#pendingInputs.push({ instanceId, event });
      return;
    }
    this.#fire('widget/deliver-failed', widgetPointerMethod, [instanceId, event], instanceId);
  }

  resize(dpr: number): void {
    if (!Number.isFinite(dpr) || dpr <= 0 || dpr === this.#dpr) return;
    this.#dpr = dpr;

    for (const layer of this.#store.list()) {
      this.#store.update(layer.instanceId, { dpr });
      this.#fire(
        'widget/render-failed',
        widgetResizeMethod,
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

  /**
   * Runs the binding checks both document entry points share.
   *
   * An explicit `catalog` option wins. Otherwise the host checks against the catalog it assembled
   * from the widget provider and the running simulation (RFC 0018).
   */
  #bindingSkipIds(document: CanvasDocument): ReadonlySet<string> {
    const explicit = this.#catalog;
    const catalog = explicit ?? this.#autoCatalog;
    // A reference the provider has not answered for yet stays unchecked until the next pass.
    const resolved =
      explicit !== undefined ||
      document.widgets.every((widget) => this.#autoCatalog.knows(widget.widget));
    const diagnostics = validateCanvasBindings(
      document,
      resolved ? { catalog } : { catalog, skipWidgets: true },
    );
    const bindingCodes = new Set([
      'canvas/unknown-symbol',
      'canvas/unknown-target-port',
      'canvas/unknown-port',
      'topic/type-mismatch',
    ]);
    const rejectsDocument = diagnostics.some((diagnostic) => {
      const pointer = diagnostic.pointer ?? '';
      return (
        !bindingCodes.has(diagnostic.code) || !/^\/widgets\/\d+\/bindings(?:\/|$)/.test(pointer)
      );
    });
    if (rejectsDocument)
      assertCanvasBindings(document, resolved ? { catalog } : { catalog, skipWidgets: true });
    const skipped = new Set<string>();
    for (const diagnostic of diagnostics) {
      if (!bindingCodes.has(diagnostic.code)) continue;
      const match = /^\/widgets\/(\d+)\/bindings(?:\/|$)/.exec(diagnostic.pointer ?? '');
      if (match === null) continue;
      const widget = document.widgets[Number(match[1])];
      if (widget !== undefined) {
        skipped.add(widget.id);
        this.#reportBindingDiagnostic(
          widget,
          diagnostic.code,
          diagnostic.message,
          diagnostic.pointer,
        );
      }
    }
    return skipped;
  }

  /**
   * Re-assembles the automatic catalog after the device host loaded a schematic (RFC 0018).
   *
   * The device side is read once the load resolved, so `getTopics()` and `getSchematic()` describe
   * the runtime the instances will talk to; the widget side resolves every reference the document
   * names before validation runs.
   */
  async #refreshCatalog(
    document: CanvasDocument,
    schematic: string | undefined,
    schematicUri: string | undefined,
  ): Promise<void> {
    // An explicit catalog is the caller's, so nothing has to be assembled.
    if (this.#catalog !== undefined) return;
    const deviceHost = this.#deviceHost;
    const [topics, loaded] = await Promise.all([deviceHost.getTopics(), deviceHost.getSchematic()]);
    this.#autoCatalog.setDeviceFacts({
      schematics: [schematic, schematicUri],
      schematic: loaded,
      topics,
    });
    await this.#resolveDefinitions(document);
  }

  /**
   * Resolves the widget definitions the document references, so validation itself stays synchronous.
   *
   * A rejection or an unknown reference is only recorded as "not resolved": the mount of every
   * instance using it reports the failure on its own.
   */
  async #resolveDefinitions(document: CanvasDocument): Promise<void> {
    const refs = new Set(document.widgets.map((widget) => widget.widget));
    await Promise.all(
      [...refs].map(async (ref) => {
        if (this.#autoCatalog.knows(ref)) return;
        try {
          const module = await this.#provider.resolve(ref);
          if (module !== undefined) this.#autoCatalog.recordDefinition(ref, module.definition);
        } catch {
          // Reported when an instance of this reference mounts.
        }
      }),
    );
  }

  /**
   * Makes `document` the new snapshot and drops the instances it no longer lists.
   *
   * Removal is synchronous on purpose: a mount still in flight for a removed id has to be cancelled
   * right away, while the coordination pass that would have removed it may be blocked on it.
   */
  #commit(document: CanvasDocument, bindingSkipped: ReadonlySet<string> = new Set()): void {
    this.#document = document;
    this.#bindingSkipped = new Set(bindingSkipped);
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
        if (this.#reloadPending) {
          this.#reloadPending = false;
          await this.#reloadDocument();
        }
        if (this.#deviceResetPending) {
          this.#deviceResetPending = false;
          await this.#deviceHost.reset();
          this.#simTime = await this.#deviceHost.getSimTime();
          // The circuit is back at its initial state; the next step publishes every topic again.
          this.#lastPublished.clear();
        }
        if (this.#resetPending) {
          this.#resetPending = false;
          await this.#resetGuestRuntime();
          if (this.#reloadSchematicPending) {
            this.#reloadSchematicPending = false;
            await this.#reloadSchematic();
          }
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

  /**
   * Re-reads the document behind the current URI, for `reset()`.
   *
   * A document that no longer parses is reported instead of rejecting: the reset still has to put
   * the instances back with the snapshot the host already holds.
   */
  async #reloadDocument(): Promise<void> {
    const uri = this.#documentUri;
    if (uri === undefined) return;
    try {
      const parsed = parseCanvas(await this.#readDocumentText(uri));
      const bindingSkipped = this.#bindingSkipIds(parsed);
      this.#schematicUri = this.#resolveSchematicUri(parsed, uri);
      this.#commit(parsed, bindingSkipped);
      this.#emitDocument(parsed);
    } catch (error) {
      this.#report(
        'widget/runtime-failed',
        `The canvas document "${uri}" could not be reloaded: ${describeError(error)}`,
      );
    }
  }

  /** Re-executes the runtime half of `loadDocument`: the schematic goes back to time 0. */
  async #reloadSchematic(): Promise<void> {
    try {
      await this.#loadSchematic(this.#schematicUri);
      await this.#refreshCatalog(this.#document, this.#document.schematic, this.#schematicUri);
    } catch (error) {
      this.#report(
        'widget/runtime-failed',
        `The schematic could not be reloaded: ${describeError(error)}`,
      );
    }
  }

  /** Mounts, resizes, sets properties and reorders instances to match the document. */
  async #syncInstances(): Promise<void> {
    for (const { id: instanceId } of this.#document.widgets) {
      if (this.#disposed) return;
      // A newer snapshot may have dropped this id while the previous instance was mounting.
      const widget = this.#document.widgets.find((entry) => entry.id === instanceId);
      if (widget === undefined) continue;
      if (this.#bindingSkipped.has(instanceId)) {
        if (this.#instances.has(instanceId)) this.#unmount(instanceId);
        continue;
      }
      await this.#syncInstance(widget);
    }
    this.#store.reorder(this.#document.widgets.map((widget) => widget.id));
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
    const props = widget.properties ?? {};
    // Geometry and properties are host-side state: record them before the guest call, so a
    // subscriber sees the document value even when the guest render fails.
    this.#store.update(widget.id, {
      ...placement,
      properties: props,
      bindings: widget.bindings ?? {},
    });

    // `x`, `y` and `rotation` only move the composite position, which the document already carries;
    // only a size change has to reach the guest.
    if (
      placement.width !== existing.placement.width ||
      placement.height !== existing.placement.height
    ) {
      this.#resizeGuest(widget.id, placement.width, placement.height);
    }
    existing.placement = placement;

    const bindings = widget.bindings ?? {};
    if (!sameBindings(existing.bindings, bindings)) {
      // A rebound port changes which endpoint the guest routes to, so a routing guest has to know.
      this.#setBindings(widget.id, bindings);
    }

    if (!sameRecord(existing.props, props)) {
      // Bytes are prefetched once, at mount: the guest cannot read a resource the host never sent,
      // so a property that names a new image re-mounts instead of reaching an empty asset map.
      if (this.#referencesUnprefetchedAsset(existing, props)) {
        this.#unmount(widget.id);
        await this.#mount(widget);
        return;
      }
      this.#setProperties(widget.id, props);
    }
  }

  #referencesUnprefetchedAsset(
    existing: InstanceRecord,
    props: Readonly<Record<string, unknown>>,
  ): boolean {
    if (this.#assets === undefined) return false;
    for (const src of collectAssetRefs(props).keys()) {
      if (!existing.assets.has(src)) return true;
    }
    return false;
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
      bindings: widget.bindings ?? {},
      assets: new Set<string>(),
    };
    this.#instances.set(instanceId, record);
    this.#store.add({
      instanceId,
      widget: ref,
      ...record.placement,
      dpr: this.#dpr,
      properties: record.props,
      bindings: widget.bindings ?? {},
    });
    this.#store.reorder(this.#document.widgets.map((entry) => entry.id));

    let mounted = false;
    try {
      mounted = await this.#mountInstance(instanceId, ref, record);
    } finally {
      // A cancelled or failed attempt only drops its own reservation.
      if (!mounted) this.#forget(instanceId, record);
    }
    // The instance exists in the guest now, so the live level of every bound endpoint can be sent,
    // and a guest that routes on its own learns which endpoint each port talks to.
    if (mounted) {
      this.#setBindings(instanceId, record.bindings);
      this.#replayPublished(widget);
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
    this.#autoCatalog.recordDefinition(ref, module.definition);
    this.#requireOwnership(instanceId, record);

    const sandbox = await this.#ensureSandbox();
    this.#requireOwnership(instanceId, record);

    try {
      await sandbox.call(widgetLoadMethod, {
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
      record.assets = new Set(collectAssetRefs(props).keys());
      this.#requireOwnership(instanceId, record);

      const layer = this.#store.get(instanceId);
      if (!layer) throw new WidgetMountCancelledError(instanceId);
      // The mount token goes out before the guest can open a stream with it.
      const audio: WidgetAudioMountInfo =
        this.#audio === undefined ? { state: 'unavailable' } : await this.#audio.open(instanceId);
      if (audio.session !== undefined) record.audioSession = audio.session;
      this.#requireOwnership(instanceId, record);
      await sandbox.call(widgetMountMethod, {
        instanceId,
        widget: ref,
        width: layer.width,
        height: layer.height,
        dpr: layer.dpr,
        props,
        ...(assets === undefined ? {} : { assets }),
        audio,
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
    this.#fire(undefined, widgetUnmountMethod, [instanceId], instanceId);
  }

  /** Repaints one instance at a new size; the store already carries the new geometry. */
  #resizeGuest(instanceId: string, width: number, height: number): void {
    if (!this.#requireInstance(instanceId)) return;
    const layer = this.#store.get(instanceId);
    if (!layer) return;
    this.#fire(
      'widget/render-failed',
      widgetResizeMethod,
      [instanceId, width, height, layer.dpr],
      instanceId,
    );
  }

  #setProperties(instanceId: string, props: Readonly<Record<string, unknown>>): void {
    const instance = this.#requireInstance(instanceId);
    if (!instance) return;
    instance.props = props;
    this.#fire('widget/render-failed', widgetSetPropertiesMethod, [instanceId, props], instanceId);
  }

  /**
   * Hands one instance's binding map to the guest.
   *
   * Only a guest with the direct device channel needs it: that guest then routes publishes to the
   * device and device publishes back to the instance. A guest without one keeps the host as its only
   * router, so the call is skipped rather than sent into a runtime that ignores it.
   */
  #setBindings(instanceId: string, bindings: Readonly<Record<string, CanvasBindingTarget>>): void {
    const instance = this.#instances.get(instanceId);
    if (instance === undefined) return;
    instance.bindings = bindings;
    if (!this.#directDevice) return;
    this.#fire(
      'widget/deliver-failed',
      widgetSetBindingsMethod,
      [instanceId, bindings],
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
    const current = this.#instances.get(instanceId);
    if (current !== record) {
      // The id was already dropped or replaced. Release only this attempt's audio generation, so a
      // session opened after a reset sweep cannot outlive the instance it belonged to.
      if (record.audioSession !== undefined) {
        this.#audio?.closeSession(instanceId, record.audioSession);
      }
      return;
    }
    this.#instances.delete(instanceId);
    this.#store.remove(instanceId);
    // The worklet closes the streams of this generation even when the guest never hears about it.
    this.#audio?.close(instanceId);
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
      await sandbox.call(widgetResetRuntimeMethod);
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
      // The device port travels with the guest's first ordinary message, so it is spent once the guest exists.
      const devicePort = this.#devicePort;
      this.#devicePort = undefined;
      const pending = this.#createSandbox({
        ...(this.#container === undefined ? {} : { container: this.#container }),
        ...(this.#fs === undefined ? {} : { fs: this.#fs }),
        ...(devicePort === undefined ? {} : { devicePort }),
      })
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
          this.#directDevice = sandbox.directDevice === true;
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
   * Reads every asset reference found in the merged props.
   *
   * RFC 0018 step 4: widget property resources resolve against the canvas document URI, so a host
   * without a `WidgetAssetProvider` reads them through `fs` (a `data:` reference is decoded
   * locally). Failures are reported and skipped: a missing image must not stop the mount.
   */
  async #prefetchAssets(
    instanceId: string,
    ref: string,
    props: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, Uint8Array> | undefined> {
    const source = this.#assets;
    const fs = this.#fs;
    const baseUri = this.#documentUri;
    let read: (assetRef: WidgetAssetRef) => Promise<Uint8Array>;
    if (source !== undefined) {
      read = (assetRef) => source.resolve(assetRef);
    } else if (fs !== undefined && baseUri !== undefined) {
      read = (assetRef) => readHostAsset(fs, baseUri, assetRef);
    } else {
      return undefined;
    }

    const refs = collectAssetRefs(props);
    const entries = await Promise.all(
      [...refs.values()].map(async (assetRef): Promise<[string, Uint8Array] | undefined> => {
        try {
          const bytes = await read(assetRef);
          if (!(bytes instanceof Uint8Array)) {
            throw new TypeError('WidgetAssetProvider.resolve() must resolve to a Uint8Array');
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
      sandbox.on(widgetFrameEvent, (payload) => this.#onFrame(payload)),
      sandbox.on(widgetPublishEvent, (payload) => this.#onPublishMessage(payload)),
      sandbox.on(widgetErrorEvent, (payload) => this.#onErrorMessage(payload)),
      sandbox.on(widgetAssetFailedEvent, (payload) => this.#onAssetFailedMessage(payload)),
    );
    // A worklet that booted before the sandbox existed handed its port over already.
    this.#flushAudioPort();
    this.#flushAudioState();
  }

  #emitAudioPort(port: MessagePort): void {
    this.#pendingAudioPort = port;
    this.#flushAudioPort();
  }

  /** Drops a port nobody received; the host owns it until it is transferred. */
  #releaseAudioPort(): void {
    const port = this.#pendingAudioPort;
    this.#pendingAudioPort = undefined;
    try {
      port?.close();
    } catch {
      // Already closed.
    }
  }

  /** Transfers the direct worker ↔ worklet port; skipped until a sandbox can receive it. */
  #flushAudioPort(): void {
    const port = this.#pendingAudioPort;
    const sandbox = this.#sandbox;
    if (port === undefined || sandbox === undefined) return;
    this.#pendingAudioPort = undefined;
    if (sandbox.audio === undefined) {
      // No host → guest audio lane: nobody can receive the port, so the host releases it.
      try {
        port.close();
      } catch {
        // Already closed.
      }
      return;
    }
    try {
      sandbox.audio.attachPort(port);
    } catch {
      // A terminated sandbox has no guest left to inform.
    }
  }

  #emitAudioState(state: WidgetAudioState): void {
    if (this.#lastAudioState === state) return;
    this.#lastAudioState = state;
    this.#flushAudioState();
  }

  /** Pushes the latest availability; a mounted instance already received it in its mount request. */
  #flushAudioState(): void {
    const state = this.#lastAudioState;
    const sandbox = this.#sandbox;
    if (state === undefined || sandbox === undefined) return;
    try {
      sandbox.audio?.setState(state);
    } catch {
      // A terminated sandbox has no guest left to inform.
    }
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
    this.#store.setBitmap(frame.instanceId, frame.bitmap);
  }

  #onPublishMessage(payload: unknown): void {
    const message = payload as Partial<WidgetPublishMessage> | null | undefined;
    if (!message || typeof message !== 'object') return;
    if (typeof message.instanceId !== 'string' || typeof message.port !== 'string') return;
    const publish: WidgetPublish = {
      instanceId: message.instanceId,
      port: message.port,
      payload: message.payload,
      // The device host is the one authority for time: the last value it reported is the best
      // stamp a widget publish can carry when the widget did not pass one.
      simTime:
        typeof message.simTime === 'number' && Number.isFinite(message.simTime)
          ? message.simTime
          : this.#simTime,
    };
    // Route before notifying: a device may answer synchronously, and the host listener should see
    // the publish once its effects are already in flight. A guest with the direct device channel has
    // already delivered it, so forwarding here would deliver the same payload twice.
    if (message.direct !== true) this.#forwardToDeviceHost(publish);
    this.#onPublish?.(publish);
  }

  /** Sends a widget publish to the endpoint its port is bound to; unbound ports stay host-local. */
  #forwardToDeviceHost(publish: WidgetPublish): void {
    const widget = this.#document.widgets.find((candidate) => candidate.id === publish.instanceId);
    const target = widget?.bindings?.[publish.port];
    if (target === undefined) return;

    void this.#deviceHost
      .deliver(target, publish.payload, publish.simTime)
      .catch((error: unknown) => {
        this.#report(
          'widget/deliver-failed',
          `Publish from "${publish.instanceId}" could not reach ${target.symbol}.${target.port}: ${describeError(error)}`,
          { instanceId: publish.instanceId, widget: widget?.widget },
        );
      });
  }

  /** Fans a device publish out to every widget port bound to its endpoint. */
  #onSimulationPublish(publish: SimulationPublish): void {
    if (this.#disposed) return;
    const { target } = publish;
    this.#lastPublished.set(targetKey(target), publish);
    // The direct channel already handed this publish to the guest, which fans it out to the same
    // instances; the host only keeps the level cache that seeds mounts.
    if (this.#directDevice) return;
    for (const widget of this.#document.widgets) {
      const bindings = widget.bindings;
      if (bindings === undefined) continue;
      for (const port of Object.keys(bindings)) {
        const bound = bindings[port];
        if (bound === undefined || bound.symbol !== target.symbol || bound.port !== target.port) {
          continue;
        }
        // `deliver` reports unknown instances and guest failures on its own.
        this.deliver(widget.id, port, publish.payload, publish.simTime);
      }
    }
  }

  /**
   * Seeds one freshly mounted instance with the values its endpoints already carry.
   *
   * `deliver` only forwards what the simulation publishes, and a level topic publishes on change
   * only, so without this a widget mounted mid-run would wait for the next change to show anything.
   */
  #replayPublished(widget: CanvasWidgetInstance): void {
    for (const [port, target] of Object.entries(widget.bindings ?? {})) {
      const publish = this.#lastPublished.get(targetKey(target));
      if (publish === undefined) continue;
      this.deliver(widget.id, port, publish.payload, publish.simTime);
    }
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

  /**
   * Starts the frame clock. RFC 0018 gives the host the clock, so a loaded document advances on its
   * own; a pause or a disposed host keeps it stopped.
   */
  #startClock(): void {
    if (this.#disposed || this.#paused || this.#mode !== 'simulation') return;
    this.#scheduleFrame();
  }

  #stopClock(): void {
    const cancel = this.#cancelFrame;
    this.#cancelFrame = undefined;
    cancel?.();
  }

  #scheduleFrame(): void {
    if (this.#cancelFrame !== undefined || this.#disposed) return;
    this.#cancelFrame = this.#frameOptions.requestFrame(() => {
      this.#cancelFrame = undefined;
      void this.#advanceFrame();
    });
  }

  /** Advances one fixed simulation step, then schedules the next 25 ms clock tick. */
  async #advanceFrame(): Promise<void> {
    if (this.#advancing || this.#disposed || this.#paused) return;
    this.#advancing = true;
    try {
      if (this.#disposed || this.#paused) return;
      // Inputs that arrived since the last step are dispatched at the step's start.
      this.#flushInputs();
      if (this.#mode === 'simulation') {
        const report = await this.#deviceHost.tick(this.#frameOptions.stepMs * PS_PER_MS);
        this.#simTime = report.simTime;
      }
    } catch (error) {
      this.#report('widget/runtime-failed', `A simulation step failed: ${describeError(error)}`);
    } finally {
      this.#advancing = false;
      if (!this.#disposed && !this.#paused && this.#mode === 'simulation') this.#scheduleFrame();
    }
  }

  /** Dispatches the queued input events at the start of a step. */
  #flushInputs(): void {
    for (const input of this.#pendingInputs.splice(0)) {
      if (!this.#instances.has(input.instanceId)) continue;
      this.#fire(
        'widget/deliver-failed',
        widgetPointerMethod,
        [input.instanceId, input.event],
        input.instanceId,
      );
    }
  }

  /** Abandons the runtime: layers are cleared and the failure is reported once. */
  #failRuntime(message: string, cause?: unknown): WidgetRuntimeError {
    this.#sandbox = undefined;
    this.#starting = undefined;
    // The dead guest had the only device port; the next sandbox runs without one and the host
    // relays topic traffic again.
    this.#directDevice = false;
    this.#detach();
    this.#store.clear();
    this.#instances.clear();
    this.#pendingInputs.length = 0;
    // The dead sandbox took the guest port with it; the next one gets a fresh channel.
    this.#releaseAudioPort();
    this.#audio?.reset();
    if (!this.#disposed) this.#report('widget/runtime-failed', message);
    return new WidgetRuntimeError(message, cause === undefined ? undefined : { cause });
  }

  async #shutdown(): Promise<void> {
    this.#disposed = true;
    this.#stopClock();
    this.#detach();
    this.#unsubscribeDevicePublish?.dispose();
    this.#unsubscribeDevicePublish = undefined;
    this.#pendingInputs.length = 0;
    this.#store.clear();
    this.#instances.clear();
    this.#lastPublished.clear();
    this.#directDevice = false;
    // A port handed over but never transferred belongs to this host; release it with the rest.
    const devicePort = this.#devicePort;
    this.#devicePort = undefined;
    try {
      devicePort?.close();
    } catch {
      // Already closed with a guest.
    }
    this.#releaseAudioPort();
    this.#audio?.dispose();

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

  /** Diagnostic ids for one instance; audio failures without an instance report no ids. */
  #instanceIds(instanceId: string): { instanceId?: string; widget?: string } {
    if (instanceId === '') return {};
    const widget = this.#instances.get(instanceId)?.widget;
    return widget === undefined ? { instanceId } : { instanceId, widget };
  }

  #reportBindingDiagnostic(
    widget: CanvasWidgetInstance,
    code: string,
    message: string,
    pointer: string | undefined,
  ): void {
    this.#report('widget/binding-failed', message, {
      instanceId: widget.id,
      widget: widget.widget,
      bindingCode: code,
      pointer,
    });
  }

  #report(
    code: WidgetDiagnosticCode,
    message: string,
    ids: {
      instanceId?: string | undefined;
      widget?: string | undefined;
      bindingCode?: string | undefined;
      pointer?: string | undefined;
    } = {},
  ): void {
    const diagnostic: WidgetDiagnostic = {
      code,
      message,
      ...(ids.instanceId === undefined ? {} : { instanceId: ids.instanceId }),
      ...(ids.widget === undefined ? {} : { widget: ids.widget }),
      ...(ids.bindingCode === undefined ? {} : { bindingCode: ids.bindingCode }),
      ...(ids.pointer === undefined ? {} : { pointer: ids.pointer }),
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

function splitRef(ref: string): { packageId: string; widgetId: string } | undefined {
  const separator = ref.indexOf(':');
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  return { packageId: ref.slice(0, separator), widgetId: ref.slice(separator + 1) };
}

/** Map key of one binding endpoint; the separator cannot occur in a symbol id or a port name. */
function targetKey(target: { readonly symbol: string; readonly port: string }): string {
  return `${target.symbol}\u0000${target.port}`;
}

/** Compares two binding maps by endpoint; the document reparses objects it never changed. */
function sameBindings(
  left: Readonly<Record<string, CanvasBindingTarget>>,
  right: Readonly<Record<string, CanvasBindingTarget>>,
): boolean {
  if (left === right) return true;
  const ports = Object.keys(left);
  if (ports.length !== Object.keys(right).length) return false;
  return ports.every((port) => {
    const bound = right[port];
    return bound !== undefined && targetKey(left[port]!) === targetKey(bound);
  });
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

/**
 * Reads one widget property resource (RFC 0018 step 4).
 *
 * `inline` references carry base64 and a `data:` reference carries its own bytes, so neither
 * reaches `fs`; every other reference resolves against the canvas document URI first.
 */
function readHostAsset(fs: HostFs, baseUri: string, ref: WidgetAssetRef): Promise<Uint8Array> {
  if (ref.src.slice(0, 5).toLowerCase() === 'data:') {
    return Promise.resolve(decodeDataUri(ref.src));
  }
  if (ref.mode === 'inline') return Promise.resolve(decodeBase64Asset(ref.src));
  return fs.read(resolveHostUri(baseUri, ref.src));
}

function decodeBase64Asset(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch (cause) {
    throw new TypeError('Inline asset src is not valid base64', { cause });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
    await sandbox.call(widgetUnmountMethod, instanceId);
  } catch {
    // The guest never created the instance, or the sandbox is already gone.
  }
}
