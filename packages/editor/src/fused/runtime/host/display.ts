/**
 * Host-side 2D presentation surface (RFC 0022).
 *
 * The host reserves the overlay extent, numbers every request so a late frame can never overwrite a
 * newer one, and repaints instances whose presentation called `invalidate()`. Bitmaps of discarded
 * frames are closed instead of leaked.
 */
import { Emitter } from '@mica-js/core/lifecycle';
import type { RpcProxy } from '@mica-js/core/rpc';
import type { RuntimeDiagnostic } from '@mica-js/sdk/fused';
import type {
  FusedDisplayMode,
  IFusedDisplayLayout,
  IFusedDisplayService,
  IFusedInstancePresentation,
  IFusedInvalidateEvent,
  IFusedOverlayFrame,
  IFusedViewInput,
} from '../protocol';
import type { IFusedDisplay, IFusedDisplayPrepareInput } from './types';
import { isImageBitmap, mapWireFailure, messageOf } from '../wire';

export interface IFusedDisplayHostOptions {
  readonly proxy: RpcProxy<IFusedDisplayService>;
  readonly onOverlay?: (frame: IFusedOverlayFrame) => void;
  readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
  /** Overlay extent of one instance; defaults to its bounds at one device pixel per local unit. */
  readonly measure?: (instance: IFusedInstancePresentation) => IFusedDisplayLayout;
  /** Repaints when a presentation asks for it; defaults to `true`. */
  readonly autoRender?: boolean;
}

/** Display surface plus the preparation the runtime drives. */
export interface IFusedDisplayHost {
  readonly display: IFusedDisplay;
  /** Replaces the presentation of one mode; drops every pending frame of the previous one. */
  prepare(
    input: IFusedDisplayPrepareInput,
    instances: readonly IFusedInstancePresentation[],
  ): Promise<void>;
  /** Runs the author `initialize` hooks once the models of the mode exist. */
  activate(): Promise<void>;
  dispose(): Promise<void>;
}

export function createFusedDisplay(options: IFusedDisplayHostOptions): IFusedDisplayHost {
  const { proxy } = options;
  const invalidations = new Emitter<IFusedInvalidateEvent>();
  const generations = new Map<string, number>();
  const dirty = new Set<string>();
  /** Reported framework failures of the current preparation, so a flood reports once. */
  const reported = new Set<string>();
  let prepared: readonly IFusedInstancePresentation[] = [];
  let mode: FusedDisplayMode | undefined;
  /** Incremented by every preparation, so results of a replaced mode are dropped. */
  let epoch = 0;
  let pumping = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const stopInvalidate = proxy.onDidInvalidate((change) => {
    if (disposed) return;
    invalidations.fire(change);
    if (options.autoRender !== false) schedule(change.instanceId);
  });

  const display: IFusedDisplay = {
    get mode() {
      return mode;
    },
    get instances() {
      return prepared;
    },
    onDidInvalidate: invalidations.event,
    render,
    input,
    invalidate,
    dispose,
  };

  return { display, prepare, activate, dispose };

  async function prepare(
    input: IFusedDisplayPrepareInput,
    instances: readonly IFusedInstancePresentation[],
  ): Promise<void> {
    if (disposed) {
      throw new Error('The fused display is disposed.');
    }
    epoch += 1;
    generations.clear();
    dirty.clear();
    reported.clear();
    await mapWireFailure(() => proxy.prepare({ mode: input.mode, instances }));
    mode = input.mode;
    prepared = instances;
  }

  async function activate(): Promise<void> {
    if (disposed) return;
    await mapWireFailure(() => proxy.activate());
  }

  async function render(
    instanceId: string,
    layout?: IFusedDisplayLayout,
  ): Promise<IFusedOverlayFrame | undefined> {
    const instance = prepared.find((entry) => entry.instanceId === instanceId);
    if (instance === undefined || disposed) return undefined;
    const extent = layout ?? defaultLayout(instance);
    const generation = (generations.get(instanceId) ?? 0) + 1;
    generations.set(instanceId, generation);
    const attempt = epoch;
    const frame = await mapWireFailure(() => proxy.render({ instanceId, generation, ...extent }));
    if (frame === undefined) return undefined;
    if (disposed || attempt !== epoch || generation !== generations.get(instanceId)) {
      closeBitmap(frame.bitmap);
      return undefined;
    }
    options.onOverlay?.(frame);
    return frame;
  }

  function input(instanceId: string, event: IFusedViewInput): void {
    if (disposed) return;
    void proxy.input(instanceId, event).catch((cause: unknown) => {
      // The guest reports author callback failures itself as `view2d/input-failed`; a rejection here
      // means the call never reached the presentation, so it is reported once per instance.
      reportOnce(instanceId, 'runtime/presentation-failed', messageOf(cause));
    });
  }

  /**
   * Reports a framework failure of one instance once per distinct message.
   *
   * A dead guest fails every queued pointer event and every scheduled frame; without the dedupe the
   * same cause would flood the diagnostic sink.
   */
  function reportOnce(instanceId: string, code: string, message: string): void {
    const key = `${instanceId}\u0000${code}\u0000${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    options.onDiagnostic?.({ code, message, instanceId });
  }

  function invalidate(instanceId?: string): void {
    if (disposed) return;
    if (instanceId !== undefined) {
      schedule(instanceId);
      return;
    }
    for (const instance of prepared) schedule(instance.instanceId);
  }

  function schedule(instanceId: string): void {
    if (!prepared.some((entry) => entry.instanceId === instanceId)) return;
    dirty.add(instanceId);
    if (pumping) return;
    pumping = true;
    void Promise.resolve().then(pump);
  }

  async function pump(): Promise<void> {
    while (!disposed) {
      const batch = [...dirty];
      if (batch.length === 0) {
        pumping = false;
        return;
      }
      dirty.clear();
      for (const instanceId of batch) {
        try {
          await render(instanceId);
        } catch (cause) {
          reportOnce(instanceId, 'runtime/presentation-failed', messageOf(cause));
        }
      }
    }
    pumping = false;
  }

  function defaultLayout(instance: IFusedInstancePresentation): IFusedDisplayLayout {
    const measured = options.measure?.(instance);
    if (measured !== undefined) return measured;
    const bounds = instance.geometry.bounds;
    return {
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
      scale: 1,
    };
  }

  function dispose(): Promise<void> {
    if (disposal !== undefined) return disposal;
    disposed = true;
    disposal = (async () => {
      const problems: unknown[] = [];
      try {
        stopInvalidate();
      } catch (cause) {
        problems.push(cause);
      }
      try {
        await mapWireFailure(() => proxy.dispose());
      } catch (cause) {
        problems.push(cause);
      }
      invalidations.dispose();
      dirty.clear();
      prepared = [];
      mode = undefined;
      if (problems.length > 0) {
        throw new AggregateError(problems, 'The fused presentation failed to release its guests.');
      }
    })();
    return disposal;
  }
}

function closeBitmap(bitmap: ImageBitmap | undefined): void {
  if (bitmap !== undefined && isImageBitmap(bitmap)) bitmap.close();
}
