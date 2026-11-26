/** Host-facing contracts of the fused editor runtime (RFC 0022 / RFC 0025). */
import type { TimePs } from '@mica-js/core';
import type { Event } from '@mica-js/core/lifecycle';
import type { IFusedAudioOptions, IFusedAudioControls } from '../audio';
import type { DeviceRegistry, FusedDocument } from '@mica-js/document/fused';
import type { ProgramSources, ResourceResolver, RuntimeDiagnostic } from '@mica-js/sdk/fused';
import type {
  FusedDisplayMode,
  IFusedDisplayLayout,
  IFusedInstancePresentation,
  IFusedInvalidateEvent,
  IFusedModelClient,
  IFusedOverlayFrame,
  IFusedSessionState,
  IFusedViewInput,
} from '../protocol';

/** Sandbox worker the runtime drives; `@mica-js/sandbox`'s `SandboxWorker` satisfies it. */
export interface IFusedWorker {
  readonly state: 'ready' | 'terminated';
  readonly ready: Promise<void>;
  postMessage(message: unknown, options?: readonly Transferable[]): void;
  terminate(reason?: string): Promise<void>;
}

/** Worker construction options the runtime forwards to the generated sandbox class. */
export interface IFusedWorkerOptions {
  /** Element that hosts the hidden sandbox iframe. */
  readonly container?: HTMLElement;
  readonly name?: string;
}

/** One simulation worker and one presentation worker per workbench. */
export interface IFusedWorkerFactories {
  createSimulationWorker(options?: IFusedWorkerOptions): IFusedWorker;
  createDisplayWorker(options?: IFusedWorkerOptions): IFusedWorker;
}

/** Request that mounts presentation for one mode. */
export interface IFusedDisplayPrepareInput {
  /**
   * `run` mounts models first and hands every presentation its model client; `edit` releases the
   * models and prepares the same instances without a model.
   */
  readonly mode: FusedDisplayMode;
}

/** 2D presentation surface the editor drives (RFC 0022). */
export interface IFusedDisplay {
  /** Mode of the current presentation; `undefined` before the first preparation. */
  readonly mode: FusedDisplayMode | undefined;
  readonly instances: readonly IFusedInstancePresentation[];
  /** A presentation asked for a repaint. */
  readonly onDidInvalidate: Event<IFusedInvalidateEvent>;
  /**
   * Requests one overlay frame.
   *
   * `layout` defaults to {@link IFusedRuntimeOptions.measure} or the instance bounds at one device
   * pixel per local unit. A frame of a superseded request is discarded and its bitmap released.
   */
  render(instanceId: string, layout?: IFusedDisplayLayout): Promise<IFusedOverlayFrame | undefined>;
  /** Delivers local pointer input; coordinates are the inverse transform of the overlay. */
  input(instanceId: string, event: IFusedViewInput): void;
  /** Marks instances stale; the default auto render repaints them. */
  invalidate(instanceId?: string): void;
  dispose(): Promise<void>;
}

export interface IFusedRuntimeOptions {
  /** Caller-owned browser context; resume it directly within a user gesture for autoplay. */
  readonly audio?: IFusedAudioOptions;
  /** Fused `.sch` version 2 document; the simulation guest snapshots it. */
  readonly document: FusedDocument;
  /** Resolves the locked packages of the document in the editor. */
  readonly registry: DeviceRegistry;
  /** Fixed positive step of every advance, in picoseconds. */
  readonly step: TimePs;
  /** Explicit simulator batch-execution switch; omitted uses the board default and is kept across reset. */
  readonly batchExecution?: boolean;
  /** Presentation mode prepared on creation; defaults to `edit`. */
  readonly mode?: FusedDisplayMode;
  /** Explicit resolver of `file` and `store` property resources (RFC 0020). */
  readonly resolveResource?: ResourceResolver;
  /** Firmware project service of the editor (RFC 0026). */
  readonly programs?: ProgramSources;
  /** Receives every freshly rendered overlay, already keyed by instance. */
  readonly onOverlay?: (frame: IFusedOverlayFrame) => void;
  /** Receives preparation and runtime diagnostics of both guests. */
  readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
  /** Element that hosts the two hidden sandbox iframes. */
  readonly container?: HTMLElement;
  /** Overrides of the generated workers; tests inject plain fakes. */
  readonly workers?: IFusedWorkerFactories;
  /** Overlay extent of one instance; defaults to its bounds at one device pixel per local unit. */
  readonly measure?: (instance: IFusedInstancePresentation) => IFusedDisplayLayout;
}

/**
 * Fused editor runtime bridge of one workbench.
 *
 * The document, the packages and every model live in the simulation worker; the presentations live
 * in the display worker. This surface only schedules, mirrors state and hands bitmaps back.
 */
export interface IFusedRuntime {
  readonly audio: IFusedAudioControls;
  getState(): IFusedSessionState;
  readonly onDidChangeState: Event<IFusedSessionState>;
  readonly onDidReportDiagnostic: Event<RuntimeDiagnostic>;
  /** Fires for every overlay the presentation worker produced and the host adopted. */
  readonly onDidRenderOverlay: Event<IFusedOverlayFrame>;
  /** Proxy of one mounted model; rejects with `model/disconnected` outside a run session. */
  getModel(instanceId: string): IFusedModelClient;
  readonly display: IFusedDisplay;
  /** Prepares or replaces the presentation of one mode and resolves with its descriptors. */
  prepareDisplay(input: IFusedDisplayPrepareInput): Promise<readonly IFusedInstancePresentation[]>;
  /** Restarts continuous fixed-step advancement after pause; requires a run session. */
  resume(): Promise<void>;
  /**
   * Stops advancement after the simulation guest acknowledged it, keeping models, listeners and
   * presentation state. Resolves without a session outside run mode.
   */
  pause(): Promise<void>;
  /** Advances exactly one fixed step; requires a paused run session. */
  step(): Promise<void>;
  /** Rebuilds models and presentation of the run session from the same captured bytes, then advances. */
  reset(): Promise<void>;
  /** Releases both guests and their workers; safe to call more than once. */
  dispose(): Promise<void>;
}
