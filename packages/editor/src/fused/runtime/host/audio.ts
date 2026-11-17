import { WidgetAudioEngine } from '@mica-js/widget/audio-host';
import type { RpcEndpoint, RpcProxy } from '@mica-js/core/rpc';
import type { RuntimeDiagnostic } from '@mica-js/sdk/fused';
import type { IFusedAudioControls, IFusedAudioOptions } from '../audio';
import { fusedHostAudioService, type IFusedDisplayService } from '../protocol';

/** Browser-owned audio engine; the guest only receives session tokens and a worklet port. */
export function connectFusedAudio(
  rpc: RpcEndpoint,
  display: Pick<RpcProxy<IFusedDisplayService>, 'attachAudio' | 'setAudioState'>,
  options: IFusedAudioOptions | undefined,
  report: (diagnostic: RuntimeDiagnostic) => void,
): IFusedAudioControls & { clear(): void; dispose(): void } {
  const instances = new Set<string>();
  const reported = new Set<string>();
  let disposed = false;
  function bridgeFailure(operation: string, cause: unknown): void {
    if (disposed || reported.has(operation)) return;
    reported.add(operation);
    report({ code: 'audio/failed', message: `Audio bridge ${operation} failed: ${String(cause)}` });
  }
  const engine =
    options === undefined
      ? undefined
      : new WidgetAudioEngine({
          context: options.context,
          ...(options.destination === undefined ? {} : { destination: options.destination }),
          ...(options.limits === undefined ? {} : { limits: options.limits }),
          ...(options.getAudioWorklet === undefined
            ? {}
            : {
                loadWorklet: () => options.getAudioWorklet!(options.context),
              }),
          notify: {
            emitPort: (port) => {
              void display.attachAudio(port).catch((cause: unknown) => {
                port.close();
                bridgeFailure('attachAudio', cause);
              });
            },
            emitState: (state) => {
              void display.setAudioState(state).catch((cause: unknown) => {
                bridgeFailure('setAudioState', cause);
              });
            },
          },
          report: (code, instanceId, message) =>
            report({
              code: code.replace('widget/audio-', 'audio/'),
              message,
              ...(instanceId === '' ? {} : { instanceId }),
            }),
        });
  engine?.suspend();
  rpc.register(fusedHostAudioService, {
    async open(instanceId) {
      instances.add(instanceId);
      return (await engine?.open(instanceId)) ?? { state: 'unavailable' };
    },
    close(instanceId, session) {
      engine?.closeSession(instanceId, session);
    },
  });
  return {
    get state() {
      return engine?.state ?? 'unavailable';
    },
    suspend: () => engine?.suspend(),
    resume: () => engine?.resume(),
    setMuted: (muted) => engine?.setMuted(muted),
    setInstanceVolume: (id, volume) => engine?.setInstanceVolume(id, volume),
    clear() {
      for (const id of instances) engine?.close(id);
      instances.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      engine?.dispose();
    },
  };
}
