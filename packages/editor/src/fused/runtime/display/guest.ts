/**
 * 2D presentation guest of the fused editor runtime (RFC 0022 / RFC 0025).
 *
 * One guest serves every instance of the workbench: it evaluates the declared `view2d.entry` modules
 * of the current mode, draws overlays into its own canvases and reports the bitmaps to the host. It
 * holds no document and no model: geometry, properties and the model lane all come from the
 * simulation guest through the host.
 */
import { Emitter } from '@mica-js/core/lifecycle';
import { createWidgetAudioRuntime } from '@mica-js/widget/audio-guest';
import { fusedAudio } from '../audio';
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type { DeviceLock } from '@mica-js/document/fused';
import type { RuntimeDiagnostic } from '@mica-js/sdk/fused';
import { fusedDisplayService, fusedHostAudioService } from '../protocol';
import type {
  IFusedDisplayPrepareRequest,
  IFusedInvalidateEvent,
  IFusedOverlayFrame,
  IFusedRenderRequest,
  IFusedViewInput,
} from '../protocol';
import { createHostPackageGateway } from '../packages';
import { importCode } from '../values';
import {
  FusedBridgeError,
  isImageBitmap,
  messageOf,
  toWireFailure,
  transferOverlayFrame,
} from '../wire';
import { startDisplayModelChannel } from './model';
import type { IFusedDisplayModelChannel } from './model';
import { createViewSession } from './view';
import type { FusedSurfaceFactory, IFusedViewSession } from './view';

/** Replaceable guest dependencies, so the presentation runs off-browser in tests. */
export interface IFusedDisplayGuestOptions {
  readonly createEndpoint?: (port: MessagePort) => RpcEndpoint;
  /** Startup ports after the RPC port; the first one is the model lane (RFC 0025). */
  readonly ports?: readonly MessagePort[];
  /** Evaluates one verified view module; defaults to a blob URL plus dynamic `import()`. */
  readonly importModule?: (code: string) => Promise<unknown>;
  /** Creates the overlay canvas; defaults to `OffscreenCanvas`. */
  readonly createSurface?: FusedSurfaceFactory;
}

export interface IFusedDisplayGuest {
  readonly rpc: RpcEndpoint;
  dispose(): Promise<void>;
}

/** Starts the 2D presentation guest on the startup port of a sandbox worker. */
export function startFusedDisplayGuest(
  port: MessagePort,
  options: IFusedDisplayGuestOptions = {},
): IFusedDisplayGuest {
  const endpoint = (options.createEndpoint ?? createRpc)(port);
  const importModule = options.importModule ?? importCode;
  const createSurface: FusedSurfaceFactory =
    options.createSurface ?? ((width, height) => new OffscreenCanvas(width, height));
  const packages = createHostPackageGateway(endpoint);
  const diagnostics = new Emitter<RuntimeDiagnostic>();
  const audio = createWidgetAudioRuntime({
    onListenerError: (instanceId, cause) =>
      diagnostics.fire({
        code: 'audio/listener-failed',
        message: messageOf(cause),
        instanceId,
      }),
  });
  const hostAudio = endpoint.getProxy(fusedHostAudioService);
  const audioSessions = new Map<string, string>();
  const invalidations = new Emitter<IFusedInvalidateEvent>();
  const modelPort = options.ports?.[0];
  const modelChannel: IFusedDisplayModelChannel | undefined =
    modelPort === undefined ? undefined : startDisplayModelChannel(modelPort);

  let sessions = new Map<string, IFusedViewSession>();
  /** Incremented by every preparation, so late initializations of a replaced mode are dropped. */
  let sequence = 0;
  let closing = false;
  let disposal: Promise<void> | undefined;

  // The overlay bitmap is transferable-only: cloning one is invalid, so the hook hands it over.
  endpoint.register(
    fusedDisplayService,
    {
      attachAudio: (port) => audio.attachPort(port),
      setAudioState: (state) => audio.setState(state),
      prepare,
      activate,
      render,
      input,
      release,
      dispose: releaseAll,
      onDidInvalidate(listener) {
        const subscription = invalidations.event((value) => listener(value));
        return () => subscription.dispose();
      },
      onDidReportDiagnostic(listener) {
        const subscription = diagnostics.event((value) => listener(value));
        return () => subscription.dispose();
      },
    },
    { transfer: transferOverlayFrame },
  );

  return { rpc: endpoint, dispose };

  function report(entry: RuntimeDiagnostic): void {
    diagnostics.fire(entry);
  }

  function readAsset(lock: DeviceLock, path: string): Promise<Uint8Array> {
    return packages.open(lock).then((files) => files.read(path));
  }

  async function prepare(request: IFusedDisplayPrepareRequest): Promise<void> {
    if (closing) {
      throw toWireFailure(
        new FusedBridgeError('runtime/unavailable-state', 'The fused display guest is disposed.'),
      );
    }
    const attempt = ++sequence;
    dropSessions();
    for (const instance of request.instances) {
      if (instance.view === undefined) continue;
      const instanceId = instance.instanceId;
      try {
        if (request.mode === 'run') {
          const info = await hostAudio.open(instanceId);
          if (closing || attempt !== sequence) {
            if (info.session !== undefined)
              void hostAudio.close(instanceId, info.session).catch(() => undefined);
            return;
          }
          audio.open(instanceId, info);
          if (info.session !== undefined) audioSessions.set(instanceId, info.session);
        } else audio.open(instanceId, undefined);
        const session = await createViewSession({
          instance,
          mode: request.mode,
          model: request.mode === 'run' ? modelChannel?.client(instance) : undefined,
          audio: fusedAudio(audio.api(instanceId)),
          readAsset: (path) => readAsset(instance.lock, path),
          importModule,
          createSurface,
          invalidate: () => {
            if (attempt === sequence && !closing) invalidations.fire({ instanceId });
          },
          report: (code, message) => report({ code, message, instanceId }),
        });
        if (closing || attempt !== sequence) {
          session.dispose();
          return;
        }
        sessions.set(instanceId, session);
      } catch (cause) {
        releaseAudio(instanceId);
        // One broken presentation must not take the other instances down (RFC 0025).
        report({
          code: 'runtime/presentation-failed',
          message: messageOf(cause),
          instanceId,
        });
      }
    }
    // The runtime loads the models only after this resolves, so factory subscriptions are live.
    await modelChannel?.settle();
  }

  /**
   * Runs the author `initialize` hook of every prepared presentation.
   *
   * The runtime calls it after the models exist and their initial events were delivered, so a query
   * started here observes the state the model already has. A failing hook faults its own
   * presentation only (RFC 0025 `runtime/presentation-failed`).
   */
  async function activate(): Promise<void> {
    if (closing) return;
    const attempt = sequence;
    // Host activation and model events use different ports; synchronize on the model lane first.
    await modelChannel?.settle();
    if (closing || attempt !== sequence) return;
    for (const [instanceId, session] of [...sessions]) {
      try {
        await session.activate();
      } catch (cause) {
        if (closing || attempt !== sequence) {
          session.dispose();
          return;
        }
        report({
          code: 'runtime/presentation-failed',
          message: `Initializing the presentation failed: ${messageOf(cause)}`,
          instanceId,
        });
        release(instanceId);
      }
    }
  }

  async function render(request: IFusedRenderRequest): Promise<IFusedOverlayFrame | undefined> {
    if (closing) return undefined;
    const session = sessions.get(request.instanceId);
    if (session === undefined) return undefined;
    const attempt = sequence;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = session.render(request);
    } catch (cause) {
      report({
        code: 'view2d/render-failed',
        message: messageOf(cause),
        instanceId: request.instanceId,
      });
      return undefined;
    }
    if (bitmap === undefined) return undefined;
    if (closing || attempt !== sequence) {
      closeBitmap(bitmap);
      return undefined;
    }
    return {
      instanceId: request.instanceId,
      generation: request.generation,
      width: request.width,
      height: request.height,
      scale: request.scale,
      bitmap,
    };
  }

  function input(instanceId: string, event: IFusedViewInput): void {
    if (closing) return;
    sessions.get(instanceId)?.input(event);
  }

  function release(instanceId: string): void {
    releaseAudio(instanceId);
    const session = sessions.get(instanceId);
    if (session === undefined) return;
    sessions.delete(instanceId);
    session.dispose();
    modelChannel?.release(instanceId);
  }

  async function releaseAll(): Promise<void> {
    if (closing) return;
    sequence += 1;
    dropSessions();
  }

  function dropSessions(): void {
    for (const instanceId of [...audioSessions.keys()]) releaseAudio(instanceId);
    const current = sessions;
    sessions = new Map<string, IFusedViewSession>();
    for (const session of current.values()) {
      releaseAudio(session.instanceId);
      session.dispose();
      modelChannel?.release(session.instanceId);
    }
  }

  function dispose(): Promise<void> {
    if (disposal !== undefined) return disposal;
    closing = true;
    disposal = (async () => {
      sequence += 1;
      dropSessions();
      modelChannel?.dispose();
      audio.dispose();
      endpoint.dispose();
      diagnostics.dispose();
      invalidations.dispose();
    })();
    return disposal;
  }

  function releaseAudio(instanceId: string): void {
    audio.release(instanceId);
    const token = audioSessions.get(instanceId);
    audioSessions.delete(instanceId);
    if (token !== undefined) void hostAudio.close(instanceId, token).catch(() => undefined);
  }
}

function closeBitmap(bitmap: ImageBitmap): void {
  if (isImageBitmap(bitmap)) bitmap.close();
}
