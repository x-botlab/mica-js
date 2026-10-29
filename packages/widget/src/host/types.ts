import type { CanvasBindingCatalog, CanvasCommand, CanvasDocument } from '@mica-js/core/canvas';
import type { Event } from '@mica-js/core/lifecycle';
import type { HostFs } from '../host-fs/types';
import type { DeviceSimulationHost } from '@mica-js/simulator';
import type { WidgetProvider } from '../types';
import type { WidgetAssetRef, WidgetInputEvent } from '../guest/widget/types';
import type { WidgetAudioControls, WidgetAudioOptions } from './audio/types';
import type { WidgetAudioState } from '../guest/audio/protocol';

export type { WidgetAssetRef } from '../guest/widget/types';

/** Logical widget size; the device pixel ratio is a host-wide concern. */
export interface WidgetSize {
  readonly width: number;
  readonly height: number;
}

/** Read-only view of one mounted instance's latest frame. */
export interface WidgetLayer {
  readonly instanceId: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /** Latest frame; `undefined` until the guest produces its first bitmap. */
  readonly bitmap: ImageBitmap | undefined;
  /** Increments with every new frame, so consumers know when to repaint. */
  readonly sequence: number;
}

/** Endpoint of a widget port: a port of one symbol instance in the bound schematic (RFC 0010). */
export interface WidgetBinding {
  readonly symbol: string;
  readonly port: string;
}

/**
 * Complete drawing state of one mounted instance (RFC 0018).
 *
 * Every widget event carries this shape, so a subscriber never has to read the host again: geometry
 * and properties change through the same event, `sequence` says whether the bitmap is new.
 */
export interface Widget {
  readonly instanceId: string;
  /** Widget reference: `<packageId>:<widgetId>` or `builtin:<widgetId>`. */
  readonly widget: string;
  /** Top-left corner, logical units. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Degrees, clockwise, around the rectangle center. */
  readonly rotation: number;
  readonly dpr: number;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly bindings: Readonly<Record<string, WidgetBinding>>;
  /** Latest frame; `undefined` until the instance produced a bitmap. */
  readonly bitmap: ImageBitmap | undefined;
  /** Increments with every frame, for deciding whether a repaint is needed. */
  readonly sequence: number;
}

/** Bulk projection of a mounted instance; the same shape without the bitmap (RFC 0018). */
export type WidgetInstance = Omit<Widget, 'bitmap'>;

export type WidgetLayerChange =
  | { readonly type: 'added'; readonly instanceId: string }
  | { readonly type: 'updated'; readonly instanceId: string }
  | { readonly type: 'removed'; readonly instanceId: string }
  /** Drawing order changed; no layer was mounted or unmounted. */
  | { readonly type: 'reordered' };

export interface WidgetLayers {
  /** Document order (`document.widgets`), so the host or editor can composite in drawing order. */
  list(): readonly WidgetLayer[];
  get(instanceId: string): WidgetLayer | undefined;
  subscribe(listener: (change: WidgetLayerChange) => void): () => void;
}

/**
 * Resolves the bytes behind an image / binary property value (`{ src, mode }`).
 *
 * The host prefetches every referenced resource when an instance mounts and hands the bytes to the
 * guest, which has no network of its own. Not to be confused with `WidgetProvider`, which resolves
 * widget definitions and code.
 */
export interface WidgetAssetProvider {
  /**
   * Resolves to the resource bytes. `inline` references are base64-decoded here, on the host, so
   * the guest never sees encoded data. A rejection only skips this resource.
   */
  resolve(ref: WidgetAssetRef): Promise<Uint8Array>;
}

/** Port payload a widget published; routing belongs to a later layer. */
export interface WidgetPublish {
  readonly instanceId: string;
  readonly port: string;
  readonly payload: unknown;
  /** Simulation time the widget attached; `0` when it did not pass one. */
  readonly simTime: number;
}

export type WidgetHostMode = 'edit' | 'simulation';

export interface WidgetHost {
  /**
   * Snapshot the host currently coordinates: the last document accepted by `loadDocument` or
   * `applyCommand`. Starts as the empty document `{ version: 1, widgets: [] }`.
   *
   * Every call returns the current value, so a long-lived reference stays live.
   */
  getDocument(): CanvasDocument;

  /**
   * Commits a document and mounts the instances it lists.
   *
   * Accepts an already parsed `CanvasDocument`, or the absolute URI of a `.cnv` resource. The URI
   * form reads the bytes through `WidgetHostOptions.fs` (a `data:` URI is decoded locally),
   * decodes them as UTF-8 text, parses with `parseCanvas`, and then runs the same validation and
   * mount flow as the parsed form.
   *
   * The document's `schematic` is resolved against the document URI and loaded through
   * `deviceHost` before any instance mounts (RFC 0018 step 2), regardless of the current host mode.
   *
   * Resolves once the instances of this first pass finished mounting. A widget that fails to mount
   * is reported through `onDiagnostic` and left out of `getLayers()` instead of rejecting this
   * promise.
   *
   * Binding endpoint and type diagnostics skip only the affected instances and are reported through
   * `onDiagnostic`; valid instances still mount. Schema, schematic-loading, and other document-level
   * errors reject the call and leave the previous document and instances unchanged.
   * @throws {HostFsError} when reading the URI fails, or when no `fs` is configured for a
   * non-`data:` URI.
   * @throws {TypeError} when the URI is relative or a `data:` URI is malformed.
   * @throws whatever `DeviceSimulationHost.loadSchematic` rejects with when a device host is configured;
   * the document and the instances keep the state they had before the call.
   */
  loadDocument(document: CanvasDocument): Promise<void>;
  loadDocument(uri: string): Promise<void>;

  /**
   * Applies one command to the current document.
   *
   * The new snapshot and the `onDocumentChange` notification happen synchronously; coordinating
   * instances runs in the background and never rolls the document back. A rejected command leaves
   * both the document and the instances untouched.
   *
   * Binding endpoint and type diagnostics skip only affected instances and are reported through
   * `onDiagnostic`; other invalid commands and document-level diagnostics still throw.
   */
  applyCommand(command: CanvasCommand): void;

  /** Current widget runtime mode; only `simulation` advances the device host. */
  getMode(): WidgetHostMode;

  /** Switches widget runtime modes and resets the device and widget state. */
  setMode(mode: WidgetHostMode): Promise<void>;

  /** Subscribes to committed snapshots; returns the unsubscribe function. */
  onDocumentChange(listener: (document: CanvasDocument) => void): () => void;

  /**
   * Drops every instance and mounts the current document again, so widgets restart from their
   * initial state. Layers are emptied and repopulated.
   *
   * With a URI-loaded document this re-executes `loadDocument`: the bytes are read and parsed
   * again, and the document's schematic is handed to the device host once more, so the simulation
   * does not keep the state of a killed widget.
   *
   * Each mount runs the widget factory again (fresh closure, canvas and subscriptions, initial
   * props), but the guest keeps its module cache: a widget module is evaluated once per session.
   * Module-level state is therefore not reset — the contract puts instance state in the factory.
   *
   * Resolves once every instance of the current document has mounted again. Failures are reported
   * through `onDiagnostic` instead of rejecting, like every other coordination step.
   */
  reset(): Promise<void>;

  deliver(instanceId: string, port: string, payload: unknown, simTime: number): void;
  /**
   * Hands one input event to an instance.
   *
   * The event is queued and dispatched at the start of the next step (RFC 0018).
   */
  dispatch(instanceId: string, event: WidgetInputEvent): void;
  /** Bulk instance projection in drawing order; carries no bitmaps. */
  listInstances(): readonly WidgetInstance[];
  /** Fires once the instance is mounted, with its complete state. */
  readonly onDidAddWidget: Event<Widget>;
  /** Fires when geometry, properties, bindings, the pixel ratio or the bitmap changed. */
  readonly onDidChangeWidget: Event<Widget>;
  /** Fires when an instance is unloaded; the payload is the `instanceId`. */
  readonly onDidRemoveWidget: Event<string>;
  /** Fires with the new drawing order; the elements are `instanceId`s. */
  readonly onDidReorderWidgets: Event<readonly string[]>;
  /** Requests a full sync: every instance is reported as removed and then added, in current order. */
  invalidate(): void;
  /** Bitmaps in document order; the same store for the lifetime of the host. */
  getLayers(): WidgetLayers;
  /** Changes the device pixel ratio of every layer and repaints all instances. */
  resize(dpr: number): void;
  /** Freezes the frame clock; the document and the instances stay untouched. */
  pause(): void;
  /** Resumes the frame clock and re-times it from now. */
  resume(): void;
  /**
   * Audio controls for every instance (RFC 0016). Without `WidgetHostOptions.audio` the state stays
   * `unavailable` and the controls are no-ops.
   */
  readonly audio: WidgetAudioControls;
  /** Terminates the sandbox and closes every bitmap. */
  dispose(): Promise<void>;
}

export type WidgetDiagnosticCode =
  | 'widget/runtime-failed'
  | 'widget/unknown-widget'
  | 'widget/instance-exists'
  | 'widget/instance-not-found'
  | 'widget/mount-failed'
  | 'widget/binding-failed'
  | 'widget/render-failed'
  | 'widget/deliver-failed'
  | 'widget/asset-failed'
  | 'widget/audio-failed'
  | 'widget/audio-limit';

export interface WidgetDiagnostic {
  readonly code: WidgetDiagnosticCode;
  readonly instanceId?: string;
  readonly widget?: string;
  readonly bindingCode?: string;
  readonly pointer?: string;
  readonly message: string;
}

/**
 * Typed host → guest audio lane (RFC 0016).
 *
 * `attachPort` transfers the direct worker ↔ worklet port; `setState` pushes availability changes
 * that happen after the instance mounted.
 */
export interface WidgetSandboxAudio {
  attachPort(port: MessagePort): void;
  setState(state: WidgetAudioState): void;
}

/**
 * Minimal sandbox surface the host depends on. The default implementation wraps
 * `@mica-js/sandbox` through `SandboxWorker` plus a typed RPC adapter; tests inject a fake with the same shape.
 */
export interface WidgetSandbox {
  readonly state: 'ready' | 'terminated';
  call(method: string, ...args: unknown[]): Promise<unknown>;
  on(type: string, listener: (payload: unknown) => void): () => void;
  /** Sends a host event into the guest; events are the lane for widget-level notifications. */
  emit?(type: string, payload?: unknown, transfer?: readonly Transferable[]): void;
  /** Host → guest audio lane; without it `api.audio` stays `unavailable`. */
  readonly audio?: WidgetSandboxAudio;
  /**
   * The guest holds the direct device channel (RFC 0018), so it delivers widget publishes to the
   * device guest and fans device publishes out to its instances itself. The host then keeps the
   * binding map, the level cache and the diagnostics, and stops relaying topic traffic.
   */
  readonly directDevice?: boolean;
  terminate(reason?: string): Promise<void>;
}

export interface WidgetSandboxHostOptions {
  /** Element that hosts the hidden sandbox iframe. */
  readonly container?: HTMLElement;
  /** Host file system exposed to the generated sandbox runtime. */
  readonly fs?: HostFs;
  /**
   * One end of the direct device channel, transferred to the guest with its first message.
   *
   * A port can be transferred once, so the host hands it to the first sandbox it starts; a sandbox
   * started after a crash runs without one and the host relays topic traffic again.
   */
  readonly devicePort?: MessagePort;
}

export type WidgetSandboxFactory = (options: WidgetSandboxHostOptions) => Promise<WidgetSandbox>;

/**
 * Frame clock policy. The host decides how much one frame advances; the backlog of a stalled frame
 * is dropped instead of being simulated later.
 */
export interface WidgetHostFrameOptions {
  /** Length of one fixed step, in milliseconds. Defaults to 25 ms. */
  readonly stepMs?: number;
  /** Frame scheduler; the default uses `setTimeout` with the configured step duration. */
  readonly requestFrame?: (callback: () => void) => () => void;
}

export interface WidgetHostOptions {
  /** Widget definitions and implementations (RFC 0014). Required together with {@link provider}. */
  readonly widgetProvider?: WidgetProvider;
  /** @deprecated Use {@link widgetProvider}. */
  readonly provider?: WidgetProvider;
  /**
   * Simulation runtime kept loaded by the widget host in both edit and simulation modes.
   */
  readonly deviceHost: DeviceSimulationHost;
  /** Initial runtime mode. Defaults to `simulation`. */
  readonly mode?: WidgetHostMode;
  /**
   * Reads the bytes of a document URI for `loadDocument(uri)`. `data:` URIs are decoded locally
   * and never reach `fs`; without this option only `data:` URIs and the parsed-document form work.
   */
  readonly fs?: HostFs;
  readonly container?: HTMLElement;
  /** Device pixel ratio for new layers. Defaults to `devicePixelRatio`, or 1 outside a browser. */
  readonly dpr?: number;
  /** Receives failures that must not interrupt the caller. */
  readonly onDidReportDiagnostic?: (diagnostic: WidgetDiagnostic) => void;
  /** @deprecated Use {@link onDidReportDiagnostic}. */
  readonly onDiagnostic?: (diagnostic: WidgetDiagnostic) => void;
  /** Receives port payloads published by widgets outside every binding. */
  readonly onDidPublish?: (publish: WidgetPublish) => void;
  /** @deprecated Use {@link onDidPublish}. */
  readonly onPublish?: (publish: WidgetPublish) => void;
  /** Frame clock policy. */
  readonly frame?: WidgetHostFrameOptions;
  /**
   * Prefetches image / binary property values when an instance mounts. Without it nothing is
   * prefetched and `api.assets.readBinary` rejects.
   */
  readonly assets?: WidgetAssetProvider;
  /**
   * Overrides the binding catalog the host assembles itself (RFC 0018).
   *
   * By default the host validates every `loadDocument` / `applyCommand` against the definitions
   * resolved through `widgetProvider`, the endpoints `deviceHost.getTopics()` reports when a device
   * host is configured, and the schematic the device host loaded.
   *
   * Pass a catalog to validate against a different registry — for example a static list of
   * endpoints before a simulation exists.
   */
  readonly catalog?: CanvasBindingCatalog;
  /**
   * One end of the direct device channel between the widget guest and the device guest (RFC 0018).
   *
   * Handed to the first sandbox the host starts and never reused: a guest restarted after a crash
   * runs without it, and the host relays topic traffic as before.
   */
  readonly devicePort?: MessagePort;
  /**
   * Enables `api.audio`. Without it every widget sees `api.audio.state === 'unavailable'`.
   *
   * The host never closes the `AudioContext`: the caller keeps ownership, including the user
   * gesture that unlocks it.
   */
  readonly audio?: WidgetAudioOptions;
}
