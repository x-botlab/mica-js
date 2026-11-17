/**
 * Wire contracts of the fused editor runtime bridge (RFC 0022 / RFC 0025).
 *
 * One simulation guest owns the document snapshot, the locked packages and every model; one display
 * guest owns the declared `view2d.entry` modules and draws overlays. Both are `SandboxWorker` guests
 * and speak only these typed RPC services over ports created with `createRpc`: the main thread never
 * imports a model or an author view module.
 *
 * Binary payloads, package bytes and overlay bitmaps travel through registration transfer hooks; the
 * model lane is a direct port between the two guests, so a display input handler reaches its model
 * without a hop through the editor.
 */
import { defineRpcService } from '@mica-js/core/rpc';
import type { TimePs } from '@mica-js/core';
import type { Event } from '@mica-js/core/lifecycle';
import type { WidgetAudioMountInfo, WidgetAudioState } from '@mica-js/widget/audio-guest';
import type { IFusedAudio } from './audio';
import type {
  DeviceLock,
  FusedDocument,
  Geometry2D,
  PackageFile,
  Point2D,
  Value,
} from '@mica-js/document/fused';
import type {
  ProgramArtifact,
  ProgramFile,
  ProgramTarget,
  MemoryProgram,
  ProgramFiles,
  ModelEvent,
  ResourceRequest,
  RuntimeDiagnostic,
} from '@mica-js/sdk/fused';

/** Session status the host mirrors; `idle` means no models are mounted (edit mode). */
export type FusedSessionStatus = 'idle' | 'paused' | 'running' | 'faulted' | 'disposed';

/** Presentation mode of one workbench (RFC 0025). */
export type FusedDisplayMode = 'edit' | 'run';

/** One loaded firmware segment of a presentation snapshot (RFC 0026). */
export interface IFusedFirmwareSegment {
  readonly addressSpace: string;
  readonly address: number;
  /** Segment bytes; an independent copy owned by the presentation snapshot. */
  readonly bytes: Uint8Array;
}

/** Read-only firmware snapshot a presentation may read (RFC 0026). */
export interface IFusedFirmwareSnapshot {
  readonly kind: 'firmware';
  readonly segments: readonly IFusedFirmwareSegment[];
}

export interface IFusedProgramFilesSnapshot {
  readonly kind: 'filesystem';
  readonly files: readonly ProgramFile[];
}

/**
 * One resolved property value a presentation may read.
 *
 * Scalars stay plain; `image` and `binary` properties are their resolved bytes; `firmware`
 * properties are the loaded, segment-addressable snapshot. Resolution happens in the simulation
 * worker, so an unresolved property rejects the presentation instead of shrinking its props.
 */
export type FusedPresentationValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | IFusedFirmwareSnapshot
  | IFusedProgramFilesSnapshot;

export type FusedResolvedPresentationProps = Readonly<
  Record<string, string | number | boolean | null | Uint8Array | MemoryProgram | ProgramFiles>
>;

/** Read-only plain property snapshot handed to a 2D presentation. */
export type FusedPresentationProps = Readonly<Record<string, FusedPresentationValue>>;

/** State of the simulation session as the host sees it. */
export interface IFusedSessionState {
  readonly status: FusedSessionStatus;
  readonly simTime: TimePs;
}

/**
 * Everything the display worker needs to prepare one instance.
 *
 * Geometry and the property projection are resolved inside the simulation worker, so the host never
 * parses a manifest or evaluates an author module.
 */
export interface IFusedInstancePresentation {
  readonly instanceId: string;
  /** Full `publisher:name` device id the instance locks. */
  readonly device: string;
  readonly lock: DeviceLock;
  readonly geometry: Geometry2D;
  /** Package-root relative `.js` overlay entry; `undefined` for a geometry-only device. */
  readonly view: string | undefined;
  /**
   * Resolved property snapshot, identical to the one the model receives: manifest default and
   * document override through the SDK, with resource bytes and the loaded firmware image. An
   * instance whose props cannot be projected has no presentation at all, so this is never partial.
   */
  readonly props: FusedPresentationProps;
  /** Declared model method names; empty for a device without a model. */
  readonly methods: readonly string[];
  /** Declared model event names; empty for a device without a model. */
  readonly events: readonly string[];
}

/** Preparation request of the simulation guest: verify packages and describe the scene. */
export interface IFusedPrepareRequest {
  readonly document: FusedDocument;
  readonly mode: FusedDisplayMode;
}

export interface IFusedPrepareResult {
  readonly instances: readonly IFusedInstancePresentation[];
}

/** Request that creates the models of one run session. */
export interface IFusedLoadRequest {
  readonly document: FusedDocument;
  /** Fixed positive step of every advance, in picoseconds. */
  readonly step: TimePs;
}

/** One model event as it crosses the sandbox boundary. */
export interface IFusedModelEventWire {
  readonly instanceId: string;
  readonly event: string;
  readonly payload: ModelEvent<Value>;
}

/** Dynamic methods of one display-side model client; only declared names resolve. */
export type FusedModelMethods = Readonly<Record<string, (params: Value) => Promise<Value>>>;

/** Declared event outlets of one model client. */
export type FusedModelEvents = Readonly<Record<string, Event<ModelEvent<Value>>>>;

/**
 * Model client handed to a presentation or to the editor.
 *
 * Structurally the RFC 0021 `ModelClient` of a dynamically declared interface: methods are
 * asynchronous and every event is a core `Event` of a `ModelEvent` payload.
 */
export interface IFusedModelClient {
  readonly methods: FusedModelMethods;
  readonly events: FusedModelEvents;
}

/** Package resources one presentation may read (RFC 0022 `ViewAssets`). */
export interface IFusedViewAssets {
  /** Reads one declared package file; bytes are copied into the caller. */
  read(path: string): Promise<Uint8Array>;
  /** Decodes one image; the caller owns the bitmap and must `close()` it. */
  loadImage(path: string): Promise<ImageBitmap>;
}

export type FusedViewInputType = 'pointerdown' | 'pointerup' | 'pointermove';

/** Local pointer input delivered to one presentation (RFC 0022). */
export interface IFusedViewInput {
  readonly type: FusedViewInputType;
  /** Position in the device's local coordinates. */
  readonly position: Point2D;
  /** DOM button number of the event. */
  readonly button: number;
  /** DOM button bit mask of the buttons currently held. */
  readonly buttons: number;
}

/** Context a `view2d.entry` factory receives (RFC 0022). */
export interface IFusedView2DContext {
  readonly mode: FusedDisplayMode;
  readonly props: FusedResolvedPresentationProps;
  readonly geometry: Geometry2D;
  /** Proxy of the owning instance; `undefined` in edit mode and for devices without a model. */
  readonly model: IFusedModelClient | undefined;
  readonly assets: IFusedViewAssets;
  /** Instance audio, independent of overlay rendering and HTML panels. */
  readonly audio: IFusedAudio;
  /** Marks the overlay stale; the host decides when to repaint. */
  invalidate(): void;
}

/** Object a `view2d.entry` default factory returns (RFC 0022). */
export interface IFusedView2D {
  initialize?(): void | Promise<void>;
  renderOverlay?(context: OffscreenCanvasRenderingContext2D): void;
  input?(event: IFusedViewInput): void | Promise<void>;
  dispose?(): void;
}

/** Default export of a `view2d.entry` module. */
export type FusedView2DFactory = (context: IFusedView2DContext) => IFusedView2D;

/** Simulation guest, reached through {@link fusedSimulationService}. */
export interface IFusedSimulationService {
  prepare(request: IFusedPrepareRequest): Promise<IFusedPrepareResult>;
  load(request: IFusedLoadRequest): Promise<IFusedSessionState>;
  step(): Promise<IFusedSessionState>;
  resume(): Promise<void>;
  pause(): void;
  reset(): Promise<void>;
  /** Releases the models and keeps the captured package bytes for the next load. */
  dispose(): Promise<void>;
  call(instanceId: string, method: string, params: Value): Promise<Value>;
  getState(): IFusedSessionState;
  onDidChangeState(listener: (state: IFusedSessionState) => void): () => void;
  onDidReportDiagnostic(listener: (diagnostic: RuntimeDiagnostic) => void): () => void;
  /** Every model event of the session, in production order. */
  onDidModelEvent(listener: (event: IFusedModelEventWire) => void): () => void;
}

/** Paths of one locked package, resolved by the host (RFC 0020). */
export interface IFusedPackageFilesWire {
  readonly lock: DeviceLock;
  readonly files: Readonly<Record<string, PackageFile>>;
}

/** Host package access both guests share; the host owns the bytes and verifies nothing twice. */
export interface IFusedHostPackageService {
  open(lock: DeviceLock): Promise<IFusedPackageFilesWire>;
  /** Returns a copy the guest may keep; the reply transfers its buffer. */
  read(lock: DeviceLock, path: string): Promise<Uint8Array>;
}

/** Host resources the simulation guest reaches during preparation (RFC 0020 / RFC 0026). */
export interface IFusedHostResourceService {
  readResource(request: ResourceRequest): Promise<Uint8Array>;
  resolveProgramProject(projectId: string, target: ProgramTarget): Promise<ProgramArtifact>;
}

/** Model lane served by the simulation guest to the display guest over the direct port. */
export interface IFusedModelChannelService {
  call(instanceId: string, method: string, params: Value): Promise<Value>;
  subscribe(instanceId: string, event: string): void;
  unsubscribe(instanceId: string, event: string): void;
}

/** Model event lane served by the display guest to the simulation guest. */
export interface IFusedModelSinkService {
  deliver(event: IFusedModelEventWire): void;
}

/** Preparation of the display guest: one mode and the instances of the current session. */
export interface IFusedDisplayPrepareRequest {
  readonly mode: FusedDisplayMode;
  readonly instances: readonly IFusedInstancePresentation[];
}

/** Pixels per local unit and the overlay extent the host reserves for one instance. */
export interface IFusedDisplayLayout {
  /** Overlay width in device pixels. */
  readonly width: number;
  /** Overlay height in device pixels. */
  readonly height: number;
  /** Device pixels per local unit. */
  readonly scale: number;
}

/** One overlay render request. */
export interface IFusedRenderRequest extends IFusedDisplayLayout {
  readonly instanceId: string;
  /** Monotonic request number the frame echoes back, so stale results are dropped. */
  readonly generation: number;
}

/** Rendered overlay of one instance; the bitmap lives in the host after the transfer. */
export interface IFusedOverlayFrame extends IFusedDisplayLayout {
  readonly instanceId: string;
  readonly generation: number;
  readonly bitmap: ImageBitmap;
}

/** A presentation asked for a repaint. */
export interface IFusedInvalidateEvent {
  readonly instanceId: string;
}

/** Display guest, reached through {@link fusedDisplayService}. */
export interface IFusedDisplayService {
  /** Direct display guest to audio worklet lane, transferred by the host. */
  attachAudio(port: MessagePort): void;
  setAudioState(state: WidgetAudioState): void;
  /**
   * Creates the presentation factories of one mode; nothing is initialized yet.
   *
   * It runs before the models exist, so a factory can subscribe to model events and still observe
   * the events the model produces while it initializes.
   */
  prepare(request: IFusedDisplayPrepareRequest): Promise<void>;
  /**
   * Runs `initialize` of every prepared presentation, after the models are mounted and their initial
   * events were delivered (RFC 0025 startup barrier).
   */
  activate(): Promise<void>;
  /** Renders one overlay; `undefined` when the instance has no dynamic overlay. */
  render(request: IFusedRenderRequest): Promise<IFusedOverlayFrame | undefined>;
  /** Delivers local pointer input; the guest reports a failing handler as `view2d/input-failed`. */
  input(instanceId: string, event: IFusedViewInput): void;
  release(instanceId: string): void;
  dispose(): Promise<void>;
  onDidInvalidate(listener: (change: IFusedInvalidateEvent) => void): () => void;
  onDidReportDiagnostic(listener: (diagnostic: RuntimeDiagnostic) => void): () => void;
}

/** Wire name of the simulation guest. */
export const fusedSimulationService = defineRpcService<IFusedSimulationService>('fused-simulation');

/** Wire name of the 2D presentation guest. */
export const fusedDisplayService = defineRpcService<IFusedDisplayService>('fused-display');

/** Wire name of the host package access both guests use. */
export const fusedHostPackageService =
  defineRpcService<IFusedHostPackageService>('fused-host-package');

/** Wire name of the host resource access of the simulation guest. */
export const fusedHostResourceService =
  defineRpcService<IFusedHostResourceService>('fused-host-resource');

/** Wire name of the model lane the simulation guest serves. */
export const fusedModelChannelService =
  defineRpcService<IFusedModelChannelService>('fused-model-channel');

/** Wire name of the model sink the display guest serves. */
export const fusedModelSinkService = defineRpcService<IFusedModelSinkService>('fused-model-sink');

/** Host opens and revokes instance generations; samples use the separate worklet port. */
export interface IFusedHostAudioService {
  open(instanceId: string): Promise<WidgetAudioMountInfo>;
  close(instanceId: string, session: string): void;
}

export const fusedHostAudioService = defineRpcService<IFusedHostAudioService>('fused-host-audio');
