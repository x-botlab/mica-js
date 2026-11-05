import type { TimePs } from '@mica-js/core';
import type { Event } from '@mica-js/core/lifecycle';
import type { CanvasBindingTarget } from '@mica-js/document/canvas';
import type { WidgetInputEvent } from '../guest/widget/types';
import type { WidgetAudioControls, WidgetAudioOptions } from '../host/audio/types';
import type { WidgetModule } from '../types';

/** Mode the editor is in when it asks for a step. */
export type WidgetRuntimeMode = 'edit' | 'simulation';

/**
 * Everything the runtime needs to mount one instance.
 *
 * The editor already resolved the module through its own widget library and owns the placement:
 * the runtime receives no document, rotation, drawing order or bindings at mount time.
 */
export interface IPreparedWidgetInstance {
  readonly instanceId: string;
  /** Widget reference: `<packageId>:<widgetId>`. */
  readonly widget: string;
  /** Definition and implementation source, resolved by the caller. */
  readonly module: WidgetModule;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Prefetched bytes keyed by `WidgetAssetRef.src`; the runtime never reads a file system. */
  readonly assets?: Readonly<Record<string, Uint8Array>>;
}

/** Fields `update` may change after mount; omitted fields stay as they are. */
export interface IWidgetInstanceUpdate {
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly width?: number;
  readonly height?: number;
  readonly dpr?: number;
  readonly assets?: Readonly<Record<string, Uint8Array>>;
}

/** One payload crossing the instance boundary in either direction. */
export interface IWidgetMessage {
  readonly instanceId: string;
  readonly port: string;
  readonly payload: unknown;
  /** Simulation time in picoseconds. */
  readonly simTime: TimePs;
  /**
   * Set when the guest already handed the publish to the simulation runtime over the direct port.
   * Observers of `onDidPublish` must not route such a message a second time.
   */
  readonly direct?: true;
}

/** One committed frame of one instance. */
export interface IWidgetFrame {
  readonly instanceId: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /**
   * The bitmap belongs to the runtime: it stays valid until the next frame of the same instance,
   * its unmount or runtime disposal. A consumer that needs it longer has to copy it.
   */
  readonly bitmap: ImageBitmap;
  /** Increments with every frame, so a consumer can tell a repaint from a cached frame. */
  readonly sequence: number;
}

/** Clock context the caller hands to {@link IWidgetRuntime.step}. */
export interface IWidgetFrameContext {
  /** Simulation time after the step, in picoseconds. */
  readonly simTime: TimePs;
  /** Length of the step, in picoseconds. */
  readonly dt: TimePs;
  readonly mode: WidgetRuntimeMode;
}

/**
 * Narrow configuration of the routes the editor produced.
 *
 * The runtime does not validate bindings against a document: the editor owns the binding model and
 * hands over the endpoint map it already checked.
 */
export interface IWidgetRuntimeRouting {
  setBindings(
    instanceId: string,
    bindings: Readonly<Record<string, CanvasBindingTarget>>,
  ): Promise<void>;
}

/**
 * Instance execution without document, library, file system, clock or device ownership.
 *
 * The caller mounts prepared instances, advances time with {@link step}, and decides how publishes
 * reach the simulation. The runtime owns its sandbox: {@link dispose} terminates it.
 */
export interface IWidgetRuntime extends IWidgetRuntimeRouting {
  /** Fire-and-observe publish lane; `direct` says the simulation already received the message. */
  readonly onDidPublish: Event<IWidgetMessage>;
  readonly onDidRender: Event<IWidgetFrame>;
  /** Isolated widget, audio and sandbox failures; they never reject another instance's work. */
  readonly onDidDiagnostic: Event<IWidgetRuntimeDiagnostic>;
  mount(instance: IPreparedWidgetInstance): Promise<void>;
  update(instanceId: string, update: IWidgetInstanceUpdate): Promise<void>;
  unmount(instanceId: string): Promise<void>;
  /**
   * Queues one payload for an input port until the next {@link step}.
   *
   * Rejects immediately when the instance is not mounted, the port is unknown, its direction is not
   * `input`, or the payload does not match the declared type. Accepted messages resolve once queued.
   */
  deliver(message: IWidgetMessage): Promise<void>;
  /** Queues one pointer or keyboard event until the next {@link step}. */
  dispatch(instanceId: string, event: WidgetInputEvent): Promise<void>;
  /**
   * Flushes queued input, then advances the guest to the supplied time.
   *
   * Paints deferred by explicit stepping are committed before this resolves, and direct
   * widget → simulation deliveries started by the step settle before it resolves.
   */
  step(context: IWidgetFrameContext): Promise<void>;
  /** Audio controls for every instance; the no-op surface when no options were supplied. */
  readonly audio: WidgetAudioControls;
  /** Clears bitmaps, audio sessions, queued traffic and terminates the owned sandbox. */
  dispose(): Promise<void>;
}

export interface IWidgetRuntimeOptions {
  /** Enables `api.audio`; the caller keeps ownership of the `AudioContext`. */
  readonly audio?: WidgetAudioOptions;
}

export type IWidgetRuntimeDiagnosticCode =
  | 'widget/runtime-failed'
  | 'widget/mount-failed'
  | 'widget/update-failed'
  | 'widget/unmount-failed'
  | 'widget/render-failed'
  | 'widget/deliver-failed'
  | 'widget/publish-rejected'
  | 'widget/asset-failed'
  | 'widget/audio-failed'
  | 'widget/audio-limit'
  | 'widget/step-failed';

export type IWidgetRuntimeDiagnosticPhase =
  | 'runtime'
  | 'mount'
  | 'update'
  | 'unmount'
  | 'render'
  | 'deliver'
  | 'publish'
  | 'asset'
  | 'audio'
  | 'step';

/** A failure contained to one instance, one publish or the sandbox as a whole. */
export interface IWidgetRuntimeDiagnostic {
  readonly code: IWidgetRuntimeDiagnosticCode;
  readonly message: string;
  readonly phase: IWidgetRuntimeDiagnosticPhase;
  readonly instanceId?: string;
  readonly widget?: string;
  readonly port?: string;
}
