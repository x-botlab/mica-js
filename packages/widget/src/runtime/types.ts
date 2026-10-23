/** Metadata passed to every port listener next to the payload. */
export interface WidgetDeliveryMeta {
  /** Simulation time at which the host routed the payload. */
  readonly simTime: number;
}

/** Listener registered for one input port through `WidgetInstanceApi.subscribe`. */
export type WidgetPortListener = (payload: unknown, meta: WidgetDeliveryMeta) => void;

/** Image / binary property value from the shared descriptor contract (#7). */
export interface WidgetAssetRef {
  readonly src: string;
  readonly mode: 'file' | 'inline' | 'store';
}

/**
 * Reads resources the host prefetched when the instance was mounted. Guests have no network and
 * no DOM, so every byte a widget sees arrives through this interface.
 */
export interface WidgetAssetApi {
  /**
   * Resolves to a copy of the prefetched bytes for `src`; the widget may mutate it freely.
   *
   * Rejects when the resource was not prefetched: no `WidgetAssetProvider` was configured, the host
   * failed to read it, or a property introduced it after mount. The first missing read per
   * instance and `src` also reports `widget/asset-failed`. Callers must handle the rejection;
   * ignoring it leaves an unhandled rejection in the guest worker.
   */
  readBinary(src: string): Promise<Uint8Array>;
}

/**
 * Per-instance API handed to a widget factory. Sizes are logical units: the guest runtime applies
 * the device pixel ratio, so widgets never multiply coordinates themselves.
 */
export interface WidgetInstanceApi {
  readonly instanceId: string;
  readonly width: number;
  readonly height: number;
  /** Document props merged over `definition.properties[*].default`. */
  readonly props: Readonly<Record<string, unknown>>;
  /** Prefetched image / binary resources for this instance. */
  readonly assets: WidgetAssetApi;
  /** Subscribes to one input port; the returned function unsubscribes. */
  subscribe(port: string, listener: WidgetPortListener): () => void;
  /**
   * Sends a payload out of one output port.
   *
   * `simTime` is the simulation time the widget reacted to. The current host has no simulation
   * clock, so an omitted value is published as `0`.
   */
  publish(port: string, payload: unknown, simTime?: number): void;
  /** Requests a repaint; repeated calls in the same tick coalesce into one frame. */
  invalidate(): void;
}

/** Pointer or keyboard input forwarded to one instance. */
export interface WidgetInputEvent {
  /** DOM event type, e.g. `pointerdown`, `pointermove` or `keydown`. */
  readonly type: string;
  /** Pointer position in logical widget units, for pointer events. */
  readonly x?: number;
  readonly y?: number;
  readonly button?: number;
  readonly buttons?: number;
  /** `KeyboardEvent.key`, for keyboard events. */
  readonly key?: string;
  readonly code?: string;
  readonly repeat?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

/**
 * Object a widget factory may return. Every hook is optional, so a pure-logic widget can return
 * nothing at all; an instance without `render` still produces one blank frame per repaint.
 */
export interface WidgetInstance {
  /** Draws using logical units; the context is already scaled by the device pixel ratio. */
  render?(context: OffscreenCanvasRenderingContext2D): void;
  input?(event: WidgetInputEvent): void;
  dispose?(): void;
}

/** Default export of a widget implementation module. */
export type WidgetFactory = (api: WidgetInstanceApi) => WidgetInstance | void;
