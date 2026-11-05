import { defineRpcService } from '@mica-js/core/rpc';
import type { TimePs } from '@mica-js/core';
import type { CanvasBindingTarget } from '@mica-js/document/canvas';
import type { WidgetDefinition } from '../../types';
import type { WidgetAudioMountInfo } from '../audio/protocol';
import type { WidgetInputEvent } from './types';

/**
 * Guest event names. The sandbox reserves the `mica:` namespace for its own traffic: guest events
 * with that prefix never reach host listeners, and `sandbox.on('mica:...')` throws. Widget traffic
 * therefore lives in the `widget:` namespace.
 */
export const widgetFrameEvent = 'widget:frame';
export const widgetPublishEvent = 'widget:publish';
export const widgetErrorEvent = 'widget:error';
/** A resource the guest could not hand to a widget; non-fatal, the instance keeps running. */
export const widgetAssetFailedEvent = 'widget:asset-failed';

/** Guest methods the host reaches through `sandbox.call()`. */
export const widgetLoadMethod = 'load';
export const widgetMountMethod = 'mount';
export const widgetUnmountMethod = 'unmount';
export const widgetResizeMethod = 'resize';
export const widgetSetPropertiesMethod = 'set-properties';
/** Replaces the prefetched bytes of one mounted instance without remounting it. */
export const widgetSetAssetsMethod = 'set-assets';
/**
 * Replaces the device endpoints one instance writes to and reads from (RFC 0018).
 *
 * The guest routes topic traffic itself when it holds a direct device channel, so it needs the same
 * binding map the host validates against. A guest without that channel ignores the call.
 */
export const widgetSetBindingsMethod = 'set-bindings';
export const widgetDeliverMethod = 'deliver';
export const widgetPointerMethod = 'pointer';
/**
 * Configures explicit stepping and connects the direct simulation-runtime port before mounting.
 * Without explicit stepping the standalone guest retains automatic repaint scheduling.
 */
export const widgetConfigureMethod = 'configure';
/**
 * Advances the guest to a caller-supplied time.
 *
 * The editor owns the clock: it delivers the same step to widgets and devices, so the guest must
 * not schedule time-bound work on its own.
 */
export const widgetStepMethod = 'step';
/**
 * Releases every instance without terminating the guest. Widget modules stay evaluated, so the next
 * `load` reuses their factories and only fresh instances are created.
 */
export const widgetResetRuntimeMethod = 'reset-runtime';
/** Instance boundary that produced a widget error. */
export type WidgetErrorPhase = 'mount' | 'render' | 'deliver';

/** Widget errors cross the sandbox boundary as plain data. */
export interface SerializedWidgetError {
  readonly name: string;
  readonly message: string;
}

/** One rendered frame, always transferred so the host owns the bitmap. */
export interface WidgetFrameMessage {
  readonly instanceId: string;
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /**
   * Mount generation echoed from {@link WidgetMountRequest.generation}. The editor runtime
   * rejects a frame whose generation no longer owns the instance; standalone guests may omit it.
   */
  readonly generation?: number;
}

/** Payload a widget published on an output port. */
export interface WidgetPublishMessage {
  readonly instanceId: string;
  readonly port: string;
  readonly payload: unknown;
  /** Simulation time supplied by the widget; `0` when it did not pass one. */
  readonly simTime: number;
  /**
   * The guest already handed this publish to the device guest over its direct channel, so the host
   * must not forward it a second time. Absent when the guest has no channel or no binding.
   */
  readonly direct?: boolean;
}

/** Asset read that failed inside the guest; reported once per instance and `src`. */
export interface WidgetAssetFailedMessage {
  readonly instanceId: string;
  readonly src: string;
  readonly error: SerializedWidgetError;
}

/** Failure contained to one instance; the guest keeps every other instance running. */
export interface WidgetErrorMessage {
  readonly instanceId: string;
  readonly phase: WidgetErrorPhase;
  readonly error: SerializedWidgetError;
}

export interface WidgetLoadModule {
  readonly definition: WidgetDefinition;
  readonly code: string;
}

export interface WidgetLoadPackage {
  readonly id: string;
  readonly modules: Readonly<Record<string, WidgetLoadModule>>;
}

export interface WidgetLoadRequest {
  readonly packages: readonly WidgetLoadPackage[];
}

export interface WidgetMountRequest {
  readonly instanceId: string;
  readonly widget: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly props?: Readonly<Record<string, unknown>>;
  /** Bytes the host prefetched for this instance, keyed by `WidgetAssetRef.src`. */
  readonly assets?: Readonly<Record<string, Uint8Array>>;
  /**
   * Audio availability at mount time. Read synchronously by the factory through
   * `api.audio.state`; `session` is the one-shot token the worklet accepts for this generation.
   */
  readonly audio?: WidgetAudioMountInfo;
  /**
   * Mount generation assigned by the editor runtime. Frames echo it, so a frame produced by a
   * replaced instance can never be adopted by its successor.
   */
  readonly generation?: number;
}

/** Service the guest reaches over the transferred direct port. */
export type WidgetDirectTopicService = 'simulation-runtime';

/** One-time guest configuration applied before the first mount. */
export interface IWidgetGuestRuntimeConfig {
  /**
   * Removes the guest's automatic repaint scheduling: an `invalidate()` only marks the instance
   * dirty, and the next {@link IWidgetGuestStep} paints it.
   */
  readonly explicitStepping?: boolean;
  /** Contract behind the direct port; defaults to `simulation-runtime` at first use. */
  readonly directTopicService?: WidgetDirectTopicService;
}

/** Caller-supplied time of one widget step. */
export interface IWidgetGuestStep {
  /** Simulation time after the step, in picoseconds. */
  readonly simTime: TimePs;
  /** Length of the step, in picoseconds. */
  readonly dt: TimePs;
  /** Editor mode; widgets keep running in both, the caller decides what advances. */
  readonly mode: 'edit' | 'simulation';
}

/** Every guest method the host reaches through `sandbox.call()`, in one RPC service. */
export interface WidgetGuestService {
  [widgetLoadMethod](request: WidgetLoadRequest): Promise<void>;
  /** Rejects when the factory or the first paint fails, so a candidate instance is not adopted. */
  [widgetMountMethod](request: WidgetMountRequest): Promise<void>;
  [widgetUnmountMethod](instanceId: string): void;
  [widgetResizeMethod](instanceId: string, width: number, height: number, dpr: number): void;
  [widgetSetPropertiesMethod](instanceId: string, props: Readonly<Record<string, unknown>>): void;
  [widgetSetAssetsMethod](instanceId: string, assets: Readonly<Record<string, Uint8Array>>): void;
  [widgetSetBindingsMethod](
    instanceId: string,
    bindings: Readonly<Record<string, CanvasBindingTarget>>,
  ): void;
  [widgetDeliverMethod](instanceId: string, port: string, payload: unknown, simTime: number): void;
  [widgetPointerMethod](instanceId: string, event: WidgetInputEvent): void;
  [widgetConfigureMethod](config: IWidgetGuestRuntimeConfig): boolean;
  /**
   * Resolves after queued direct input and deferred repaints are applied, and after every direct
   * widget → simulation delivery started by this step has settled.
   */
  [widgetStepMethod](step: IWidgetGuestStep): Promise<void>;
  [widgetResetRuntimeMethod](): void;
}

/** Host → guest control lane: events pushed into the runtime and forced teardown. */
export interface WidgetGuestControlService {
  dispatchEvent(type: string, payload: unknown): void;
  terminate(): void;
}

/** Guest → host control lane: the event bus plus capability reads. */
export interface WidgetHostControlService {
  event(type: string, payload: unknown, transfer?: readonly Transferable[]): void;
}

/** Host file system reads the guest may perform; bytes travel as a transferred buffer. */
export interface WidgetHostCapabilitiesService {
  read(uri: string): Promise<Uint8Array>;
}

/**
 * Wire names shared by the worker script and the host adapter. Both sides must agree on the exact
 * strings, so they are defined once and registered with `register` / `getProxy`.
 */
export const widgetGuestService = defineRpcService<WidgetGuestService>('guest');
export const widgetGuestControlService =
  defineRpcService<WidgetGuestControlService>('guest-control');
export const widgetHostControlService = defineRpcService<WidgetHostControlService>('host-control');
export const widgetHostCapabilitiesService =
  defineRpcService<WidgetHostCapabilitiesService>('host-capabilities');

/** The one member of {@link widgetHostControlService} that carries a transfer list. */
export const widgetHostEventMethod = 'event';

/** One publish the editor simulation runtime sends over the direct port. */
export interface IWidgetSimulationPublish {
  readonly target: CanvasBindingTarget;
  readonly payload: unknown;
  /** Simulation time the publish belongs to, in picoseconds. */
  readonly simTime: TimePs;
}

/**
 * The slice of the editor simulation runtime the guest reaches over the direct port.
 *
 * The editor registers this service on the device worker (or an in-process simulation) under the
 * `simulation-runtime` id and transfers the other end of the port to this guest. The contract is
 * declared locally on purpose: the widget package must not depend on the simulator implementation
 * to state the wire shape. `deliver` takes the same `{ target, payload, simTime }` message that
 * `onDidPublish` reports.
 */
export interface IWidgetSimulationRuntimeChannel {
  /** Queues one message for a device endpoint; consumed by the simulation's next step. */
  deliver(message: IWidgetSimulationPublish): Promise<void>;
  /** Subscribes to simulation publishes; the guest fans them out to its bound instances. */
  onDidPublish(listener: (publish: IWidgetSimulationPublish) => void): () => void;
}

/** Wire name of {@link IWidgetSimulationRuntimeChannel}. */
export const widgetSimulationRuntimeService =
  defineRpcService<IWidgetSimulationRuntimeChannel>('simulation-runtime');
