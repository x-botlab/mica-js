import { defineRpcService } from '@mica-js/core/rpc';
import type { CanvasBindingTarget } from '@mica-js/core/canvas';
import type { SimulationPublish } from '@mica-js/simulator';
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
}

/** Every guest method the host reaches through `sandbox.call()`, in one RPC service. */
export interface WidgetGuestService {
  [widgetLoadMethod](request: WidgetLoadRequest): Promise<void>;
  [widgetMountMethod](request: WidgetMountRequest): void;
  [widgetUnmountMethod](instanceId: string): void;
  [widgetResizeMethod](instanceId: string, width: number, height: number, dpr: number): void;
  [widgetSetPropertiesMethod](instanceId: string, props: Readonly<Record<string, unknown>>): void;
  [widgetSetBindingsMethod](
    instanceId: string,
    bindings: Readonly<Record<string, CanvasBindingTarget>>,
  ): void;
  [widgetDeliverMethod](instanceId: string, port: string, payload: unknown, simTime: number): void;
  [widgetPointerMethod](instanceId: string, event: WidgetInputEvent): void;
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

/**
 * The slice of the device simulation guest the widget guest reaches over the direct port (RFC 0018).
 *
 * The assembly layer hands one end of a `MessageChannel` to each guest, so a widget publish reaches
 * the device guest and a device publish reaches the widget guest without the host relaying them.
 * `deliver` and `onDidPublish` are the whole data plane; everything else (schematic, topics, clock)
 * stays on the host side.
 */
export interface WidgetDeviceTopicChannel {
  /** Queues one payload for a device endpoint; consumed by the device guest's next step. */
  deliver(target: CanvasBindingTarget, payload: unknown, simTime?: number): Promise<void>;
  /** Subscribes to device publishes; the guest fans them out to its bound instances. */
  onDidPublish(listener: (publish: SimulationPublish) => void): () => void;
}

/**
 * Wire name of the contract above. It is deliberately the same id the device guest registers
 * (`@mica-js/simulator`'s `deviceSimulationHostGuestService`): the direct port is a second channel to
 * that guest, not a second protocol. The widget guest only declares the members it calls.
 */
export const widgetDeviceTopicService = defineRpcService<WidgetDeviceTopicChannel>('guest');
