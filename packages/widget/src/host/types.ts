import type {
  CanvasBindingCatalog,
  CanvasBindingTarget,
  CanvasCommand,
  CanvasDocument,
} from '@mica-js/core/canvas';
import type { WidgetProvider } from '../types';
import type { WidgetAssetRef, WidgetInputEvent } from '../runtime/types';
import type { WidgetTextInputProxyFactory } from './text-input-proxy';

export type { WidgetAssetRef } from '../runtime/types';
export type {
  CreateTextInputProxyOptions,
  TextInputProxyOptions,
  WidgetTextInputBeginOptions,
  WidgetTextInputPostEvent,
  WidgetTextInputProxy,
  WidgetTextInputProxyContext,
  WidgetTextInputProxyFactory,
  WidgetTextInputProxyKind,
} from './text-input-proxy';

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

export interface WidgetHost {
  /**
   * Snapshot the host currently coordinates: the last document accepted by `loadDocument` or
   * `applyCommand`. Starts as the empty document `{ version: 1, widgets: [] }`.
   *
   * Every call returns the current value, so a long-lived reference stays live.
   */
  getDocument(): CanvasDocument;

  /**
   * Commits an already parsed document and mounts the instances it lists.
   *
   * Parsing stays with the caller (`parseCanvas`): the host still re-validates the snapshot it is
   * handed, but it never guesses whether a value is text or a document.
   *
   * Resolves once the instances of this first pass finished mounting. A widget that fails to mount
   * is reported through `onDiagnostic` and left out of `getLayers()` instead of rejecting this
   * promise.
   *
   * @throws {SchematicError} when `document` is not a valid `.cnv` document or the bindings do not
   * validate; neither the document nor the instances change in that case.
   */
  loadDocument(document: CanvasDocument): Promise<void>;

  /**
   * Applies one command to the current document.
   *
   * The new snapshot and the `onDocumentChange` notification happen synchronously; coordinating
   * instances runs in the background and never rolls the document back. A rejected command leaves
   * both the document and the instances untouched.
   *
   * @throws {SchematicError} when the command is invalid or the resulting bindings do not validate.
   */
  applyCommand(command: CanvasCommand): void;

  /** Subscribes to committed snapshots; returns the unsubscribe function. */
  onDocumentChange(listener: (document: CanvasDocument) => void): () => void;

  /**
   * Drops every instance and mounts the current document again, so widgets restart from their
   * initial state. Layers are emptied and repopulated.
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
  dispatch(instanceId: string, event: WidgetInputEvent): void;
  /** Bitmaps in document order; the same store for the lifetime of the host. */
  getLayers(): WidgetLayers;
  /** Changes the device pixel ratio of every layer and repaints all instances. */
  resize(dpr: number): void;
  /** Terminates the sandbox and closes every bitmap. */
  dispose(): Promise<void>;
}

export type WidgetDiagnosticCode =
  | 'widget/runtime-failed'
  | 'widget/unknown-widget'
  | 'widget/instance-exists'
  | 'widget/instance-not-found'
  | 'widget/mount-failed'
  | 'widget/render-failed'
  | 'widget/deliver-failed'
  | 'widget/asset-failed'
  | 'widget/text-input-failed';

export interface WidgetDiagnostic {
  readonly code: WidgetDiagnosticCode;
  readonly instanceId?: string;
  readonly widget?: string;
  readonly message: string;
}

/**
 * Minimal sandbox surface the host depends on. The default implementation wraps
 * `@mica-js/sandbox` through `createSandbox`; tests inject a fake with the same shape.
 */
export interface WidgetSandbox {
  readonly state: 'ready' | 'terminated';
  call(method: string, ...args: unknown[]): Promise<unknown>;
  on(type: string, listener: (payload: unknown) => void): () => void;
  terminate(reason?: string): Promise<void>;
}

export interface WidgetSandboxHostOptions {
  /** Element that hosts the hidden sandbox iframe. */
  readonly container?: HTMLElement;
}

export type WidgetSandboxFactory = (options: WidgetSandboxHostOptions) => Promise<WidgetSandbox>;

/** One payload a simulation published for an endpoint the canvas can bind to. */
export interface SimulationPublish {
  readonly target: CanvasBindingTarget;
  readonly payload: unknown;
  readonly simTime: number;
}

/**
 * Simulation the host is connected to, so bound endpoints reach the widgets without a routing
 * layer in between.
 *
 * Both sides live on this thread: the host resolves the binding synchronously and hands the
 * payload to the widget sandbox, which is the only hop left (a microtask, not a worker). A
 * `DeviceSimExecutor` from `@mica-js/simulator` satisfies this interface structurally.
 */
export interface WidgetHostSimulation {
  /** Publishes from the simulation; the returned function unsubscribes. */
  onPublish(listener: (publish: SimulationPublish) => void): () => void;
  /** Forwards a widget payload to the endpoint its port is bound to. */
  deliver(target: CanvasBindingTarget, payload: unknown): void;
}

export interface WidgetHostOptions {
  readonly provider: WidgetProvider;
  readonly container?: HTMLElement;
  /** Device pixel ratio for new layers. Defaults to `devicePixelRatio`, or 1 outside a browser. */
  readonly dpr?: number;
  /** Receives failures that must not interrupt the caller. */
  readonly onDiagnostic?: (diagnostic: WidgetDiagnostic) => void;
  /** Receives port payloads published by widgets; topic routing is out of scope here. */
  readonly onPublish?: (publish: WidgetPublish) => void;
  /**
   * Simulation the host is wired to: device publishes reach the widgets bound to their endpoint,
   * and widget publishes reach the device bound to their port. Without it the host only reports
   * publishes through `onPublish` and delivers what the host asks for.
   */
  readonly simulation?: WidgetHostSimulation;
  /**
   * Prefetches image / binary property values when an instance mounts. Without it nothing is
   * prefetched and `api.assets.readBinary` rejects.
   */
  readonly assets?: WidgetAssetProvider;
  /**
   * Resolves widget definitions and schematic symbols for binding validation.
   *
   * Without it `loadDocument` / `applyCommand` only run the structural checks of the `.cnv`
   * format; the reference checks that need the registry and the schematic are skipped.
   */
  readonly catalog?: CanvasBindingCatalog;
  /** Replaces the sandbox implementation; the default starts `@mica-js/sandbox` lazily. */
  readonly sandbox?: WidgetSandboxFactory;
  /**
   * Replaces the native `<textarea>` overlay that backs `api.textInput` and `api.textSelection`.
   *
   * The default needs a DOM; a headless host (or a test) can inject a fake. Returning `undefined`
   * reports `widget/text-input-failed` for that session instead of throwing.
   */
  readonly textInputProxy?: WidgetTextInputProxyFactory;
  /** Anchor of the default overlay. Defaults to `document.body`. */
  readonly textInputAnchor?: HTMLElement;
  /** CSS pixels per logical widget unit for the default overlay. Defaults to `1`. */
  readonly textInputScale?: number;
}
