/**
 * One 2D presentation of the display guest (RFC 0022).
 *
 * A session evaluates one verified `view2d.entry` module, builds the factory context and owns the
 * overlay canvas. Drawing is synchronous and never drives the model: `renderOverlay` only reads the
 * data the model already produced, and `invalidate()` is the only way a presentation asks for a
 * repaint.
 */
import type { Geometry2D } from '@mica-js/document/fused';
import type {
  FusedDisplayMode,
  IFusedInstancePresentation,
  IFusedModelClient,
  IFusedRenderRequest,
  IFusedView2DContext,
  FusedView2DFactory,
  IFusedViewAssets,
  IFusedViewInput,
} from '../protocol';
import { byteBuffer, decodeSource, isThenable } from '../values';
import { FusedBridgeError, messageOf } from '../wire';

/** Canvas one overlay is painted into; injectable so the guest runs off-browser in tests. */
export interface IFusedOverlaySurface {
  readonly width: number;
  readonly height: number;
  getContext(type: '2d'): OffscreenCanvasRenderingContext2D | null;
  transferToImageBitmap(): ImageBitmap;
}

export type FusedSurfaceFactory = (width: number, height: number) => IFusedOverlaySurface;

/** Requests the display guest performs on behalf of one session. */
export interface IFusedViewSessionOptions {
  readonly instance: IFusedInstancePresentation;
  readonly mode: FusedDisplayMode;
  readonly model: IFusedModelClient | undefined;
  readonly readAsset: (path: string) => Promise<Uint8Array>;
  readonly importModule: (code: string) => Promise<unknown>;
  readonly createSurface: FusedSurfaceFactory;
  readonly invalidate: () => void;
  readonly report: (code: string, message: string) => void;
}

export interface IFusedViewSession {
  readonly instanceId: string;
  readonly geometry: Geometry2D;
  /** Runs the author `initialize` hook once; safe to call again. */
  activate(): Promise<void>;
  /** Paints one overlay frame; the caller owns the returned bitmap. */
  render(request: IFusedRenderRequest): ImageBitmap | undefined;
  input(event: IFusedViewInput): void;
  dispose(): void;
}

/**
 * Evaluates the presentation entry of one instance and initializes it.
 *
 * @throws {FusedBridgeError} when the module has no factory or `initialize` fails.
 */
export async function createViewSession(
  options: IFusedViewSessionOptions,
): Promise<IFusedViewSession> {
  const { instance } = options;
  const entry = instance.view;
  if (entry === undefined) {
    throw new FusedBridgeError(
      'view2d/unsupported',
      `${instance.device} declares no \`view2d.entry\`.`,
      { instanceId: instance.instanceId },
    );
  }
  const namespace = (await options.importModule(decodeSource(await options.readAsset(entry)))) as {
    readonly default?: unknown;
  } | null;
  const factory =
    namespace !== null && typeof namespace === 'object' ? namespace.default : undefined;
  if (typeof factory !== 'function') {
    throw new FusedBridgeError(
      'runtime/presentation-failed',
      `${instance.device}/${entry} must default-export a presentation factory.`,
      { instanceId: instance.instanceId },
    );
  }

  let disposed = false;
  let surface: IFusedOverlaySurface | undefined;
  const assets: IFusedViewAssets = {
    read: (path: string) => options.readAsset(path),
    loadImage: async (path: string) =>
      createImageBitmap(new Blob([byteBuffer(await options.readAsset(path))])),
  };
  const context: IFusedView2DContext = {
    mode: options.mode,
    props: instance.props,
    geometry: instance.geometry,
    model: options.model,
    assets,
    invalidate: () => {
      if (!disposed) options.invalidate();
    },
  };
  const view = (factory as FusedView2DFactory)(context);
  if (typeof view !== 'object' || view === null) {
    throw new FusedBridgeError(
      'runtime/presentation-failed',
      `${instance.device}/${entry} returned no presentation object.`,
      { instanceId: instance.instanceId },
    );
  }
  let activated = false;

  return {
    instanceId: instance.instanceId,
    geometry: instance.geometry,
    /**
     * Runs `initialize` once, after the models exist (RFC 0025 startup barrier). The factory itself
     * only registers listeners, so a presentation sees the initial model events before this runs.
     */
    async activate() {
      if (disposed || activated) return;
      activated = true;
      const initialized = view.initialize?.();
      if (isThenable(initialized)) await initialized;
    },
    render(request) {
      const draw = view.renderOverlay;
      if (disposed || draw === undefined) return undefined;
      const target = surfaceFor(request.width, request.height);
      const context2d = target.getContext('2d');
      if (context2d === null) {
        throw new FusedBridgeError(
          'view2d/render-failed',
          'The overlay canvas has no 2D context.',
          {
            instanceId: instance.instanceId,
          },
        );
      }
      context2d.save();
      try {
        context2d.setTransform(1, 0, 0, 1, 0, 0);
        context2d.clearRect(0, 0, request.width, request.height);
        const bounds = instance.geometry.bounds;
        context2d.setTransform(
          request.scale,
          0,
          0,
          request.scale,
          -bounds.x * request.scale,
          -bounds.y * request.scale,
        );
        const result = draw.call(view, context2d);
        if (isThenable(result)) {
          throw new FusedBridgeError(
            'view2d/render-failed',
            'renderOverlay must draw synchronously.',
            { instanceId: instance.instanceId },
          );
        }
      } finally {
        context2d.restore();
      }
      return target.transferToImageBitmap();
    },
    input(event) {
      const handle = view.input;
      if (disposed || handle === undefined) return;
      try {
        const result = handle.call(view, event);
        if (isThenable(result)) {
          void Promise.resolve(result).catch((cause: unknown) => {
            options.report('view2d/input-failed', messageOf(cause));
          });
        }
      } catch (cause) {
        options.report('view2d/input-failed', messageOf(cause));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        view.dispose?.();
      } catch (cause) {
        options.report(
          'runtime/presentation-failed',
          `Releasing the presentation failed: ${messageOf(cause)}`,
        );
      }
    },
  };

  function surfaceFor(width: number, height: number): IFusedOverlaySurface {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new FusedBridgeError(
        'view2d/render-failed',
        `The overlay extent ${String(width)}x${String(height)} must be positive.`,
        { instanceId: instance.instanceId },
      );
    }
    if (surface === undefined || surface.width !== width || surface.height !== height) {
      surface = options.createSurface(width, height);
    }
    return surface;
  }
}
