import type { WidgetProvider } from '../types';
import type { WidgetInputEvent } from '../runtime/types';

/** Logical widget size; the device pixel ratio is a host-wide concern. */
export interface WidgetSize {
  readonly width: number;
  readonly height: number;
}

export interface WidgetMountSpec extends WidgetSize {
  readonly instanceId: string;
  /** Widget reference `"<package>:<widget>"`. */
  readonly widget: string;
  readonly props?: Readonly<Record<string, unknown>>;
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
  | { readonly type: 'removed'; readonly instanceId: string };

export interface WidgetLayers {
  /** Mount order, so the host or editor can composite in drawing order. */
  list(): readonly WidgetLayer[];
  get(instanceId: string): WidgetLayer | undefined;
  subscribe(listener: (change: WidgetLayerChange) => void): () => void;
}

/** Port payload a widget published; routing belongs to a later layer. */
export interface WidgetPublish {
  readonly instanceId: string;
  readonly port: string;
  readonly payload: unknown;
}

export interface WidgetHost {
  /**
   * Resolves once the instance rendered its first frame.
   *
   * Rejects when the widget cannot be mounted; an id reserved by a mount that is still in flight
   * yields `widget/instance-exists` instead. If the instance is unmounted (or the host disposed)
   * while the mount is in flight, the promise rejects with an error named
   * `WidgetMountCancelledError` and no layer is left behind.
   */
  mount(spec: WidgetMountSpec): Promise<void>;
  unmount(instanceId: string): void;
  /** Geometry changes apply immediately; the matching bitmap arrives asynchronously. */
  update(instanceId: string, size: WidgetSize): void;
  setProperties(instanceId: string, props: Readonly<Record<string, unknown>>): void;
  deliver(instanceId: string, port: string, payload: unknown, simTime: number): void;
  dispatch(instanceId: string, event: WidgetInputEvent): void;
  readonly layers: WidgetLayers;
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
  | 'widget/deliver-failed';

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

export interface WidgetHostOptions {
  readonly provider: WidgetProvider;
  readonly container?: HTMLElement;
  /** Device pixel ratio for new layers. Defaults to `devicePixelRatio`, or 1 outside a browser. */
  readonly dpr?: number;
  /** Receives failures that must not interrupt the caller. */
  readonly onDiagnostic?: (diagnostic: WidgetDiagnostic) => void;
  /** Receives port payloads published by widgets; topic routing is out of scope here. */
  readonly onPublish?: (publish: WidgetPublish) => void;
  /** Replaces the sandbox implementation; the default starts `@mica-js/sandbox` lazily. */
  readonly sandbox?: WidgetSandboxFactory;
}
