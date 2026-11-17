/**
 * `@mica-js/editor/fused/runtime`: the browser bridge of the fused editor runtime (RFC 0022 / 0025).
 *
 * Two sandbox workers serve one workbench. The simulation worker owns the document, the locked
 * packages and every model; the presentation worker runs the declared `view2d.entry` modules and
 * returns overlay bitmaps. They talk over typed RPC services and one direct model lane, and the
 * editor thread never imports model or author view code.
 *
 * ```ts
 * const runtime = await createFusedRuntime({
 *   document,
 *   registry,
 *   step: toTimePs(1, 'ms'),
 *   mode: 'run', // mounts the models; advancing starts as soon as the presentations are ready
 *   onOverlay: (frame) => paint(frame.instanceId, frame.bitmap),
 *   onDiagnostic: (entry) => report(entry),
 * });
 * runtime.display.input(instanceId, { type: 'pointerdown', position, button: 0, buttons: 1 });
 * const frame = await runtime.display.render(instanceId);
 * runtime.pause(); // step() requires the paused state
 * await runtime.dispose();
 * ```
 */
import type { IFusedWorkerFactories } from './host/types';
export type * from './audio';

export { createFusedRuntime } from './host/runtime';

/**
 * Loads the generated worker factories on demand.
 *
 * `createFusedRuntime` does this itself; call it to preload both guest bundles, or to pass the
 * same factories to several runtimes.
 */
export async function loadFusedWorkerFactories(): Promise<IFusedWorkerFactories> {
  const { fusedWorkerFactories } = await import('./workers');
  return fusedWorkerFactories;
}
export { connectFusedWorkbench } from './host/connection';
export type { IFusedConnection, IFusedConnectionOptions } from './host/connection';
export { createFusedDisplay } from './host/display';
export type { IFusedDisplayHost, IFusedDisplayHostOptions } from './host/display';
export { createHostModelRouter } from './host/model';
export type { IFusedHostModelRouter } from './host/model';
export type {
  IFusedDisplay,
  IFusedDisplayPrepareInput,
  IFusedRuntime,
  IFusedRuntimeOptions,
  IFusedWorker,
  IFusedWorkerFactories,
  IFusedWorkerOptions,
} from './host/types';

export { startFusedSimulationGuest } from './simulation/guest';
export type { IFusedSimulationGuest, IFusedSimulationGuestOptions } from './simulation/guest';
export { startFusedDisplayGuest } from './display/guest';
export type { IFusedDisplayGuest, IFusedDisplayGuestOptions } from './display/guest';
export { createViewSession } from './display/view';
export type {
  IFusedOverlaySurface,
  FusedSurfaceFactory,
  IFusedViewSession,
  IFusedViewSessionOptions,
} from './display/view';
export { createModelEventRouter, channelKey } from './model-events';
export type { IFusedModelEventChannel, IFusedModelEventRouter } from './model-events';
export { createHostPackageGateway, packageLockKey } from './packages';

export {
  FUSED_WIRE_FAILURE,
  FusedBridgeError,
  fromWireFailure,
  isFusedBridgeError,
  mapWireFailure,
  toWireFailure,
} from './wire';
export type { IFusedBridgeErrorOptions, IFusedFailurePayload } from './wire';

export {
  fusedDisplayService,
  fusedHostPackageService,
  fusedHostResourceService,
  fusedModelChannelService,
  fusedModelSinkService,
  fusedSimulationService,
} from './protocol';
export type {
  FusedDisplayMode,
  FusedPresentationProps,
  FusedPresentationValue,
  FusedSessionStatus,
  FusedViewInputType,
  IFusedDisplayLayout,
  IFusedDisplayPrepareRequest,
  IFusedDisplayService,
  IFusedHostPackageService,
  IFusedHostResourceService,
  IFusedInstancePresentation,
  IFusedInvalidateEvent,
  IFusedLoadRequest,
  IFusedModelChannelService,
  IFusedModelClient,
  IFusedModelEventWire,
  FusedModelEvents,
  FusedModelMethods,
  IFusedModelSinkService,
  IFusedOverlayFrame,
  IFusedPackageFilesWire,
  IFusedPrepareRequest,
  IFusedPrepareResult,
  IFusedRenderRequest,
  IFusedSessionState,
  IFusedSimulationService,
  IFusedView2D,
  IFusedView2DContext,
  FusedView2DFactory,
  IFusedViewAssets,
  IFusedViewInput,
} from './protocol';
