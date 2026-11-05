import type { HostFs } from '../host-fs/types';
import type { WidgetAssetRef } from '../guest/widget/types';
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
   * The guest holds a direct simulation-runtime channel and routes bound topic traffic itself.
   * Observers must not relay publishes marked as direct a second time.
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
   * A port can be transferred once. A replacement sandbox needs a fresh port; without one the
   * caller routes topic traffic through the runtime events.
   */
  readonly devicePort?: MessagePort;
}

export type WidgetSandboxFactory = (options: WidgetSandboxHostOptions) => Promise<WidgetSandbox>;
