/**
 * Worker wiring of one fused workbench (RFC 0025).
 *
 * Both guests start from the generated `?sandbox-worker` classes: the host waits for the sandbox to
 * boot, transfers one end of three `MessageChannel`s and creates the typed RPC endpoints. From then
 * on nothing but `createRpc` traffic crosses the boundary.
 */
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint, RpcProxy } from '@mica-js/core/rpc';
import type { DeviceLock, DeviceRegistry, PackageFiles } from '@mica-js/document/fused';
import type { ProgramSources, ResourceResolver, RuntimeDiagnostic } from '@mica-js/sdk/fused';
import {
  fusedDisplayService,
  fusedHostPackageService,
  fusedHostResourceService,
  fusedSimulationService,
} from '../protocol';
import type { IFusedDisplayService, IFusedSimulationService } from '../protocol';
import { packageLockKey } from '../packages';
import { transferProgramArtifact, transferPackageBytes, transferResourceBytes } from '../wire';
import type { IFusedWorkerFactories } from './types';
import type { IFusedAudioOptions } from '../audio';
import { connectFusedAudio } from './audio';

export interface IFusedConnectionOptions {
  readonly audio?: IFusedAudioOptions;
  readonly workers: IFusedWorkerFactories;
  /** Host package access both guests share. */
  readonly registry: DeviceRegistry;
  /** Element that hosts the two hidden sandbox iframes. */
  readonly container?: HTMLElement;
  readonly resolveResource?: ResourceResolver;
  readonly programs?: ProgramSources;
  readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
}

/** Two guests of one workbench plus the endpoints that reach them. */
export interface IFusedConnection {
  readonly audio: ReturnType<typeof connectFusedAudio>;
  readonly simulation: RpcProxy<IFusedSimulationService>;
  readonly display: RpcProxy<IFusedDisplayService>;
  dispose(): Promise<void>;
}

/** Boots both guests of one workbench and wires their RPC surfaces. */
export async function connectFusedWorkbench(
  options: IFusedConnectionOptions,
): Promise<IFusedConnection> {
  const workerOptions = options.container === undefined ? {} : { container: options.container };
  const simulationWorker = options.workers.createSimulationWorker(workerOptions);
  const displayWorker = options.workers.createDisplayWorker(workerOptions);
  const subscriptions: Array<() => void> = [];
  let simulationRpc: RpcEndpoint | undefined;
  let displayRpc: RpcEndpoint | undefined;
  try {
    await Promise.all([simulationWorker.ready, displayWorker.ready]);
    const simulationChannel = new MessageChannel();
    const displayChannel = new MessageChannel();
    const modelChannel = new MessageChannel();
    // Ports arrive in the guest as `event.ports`: the RPC port first, the model lane second.
    simulationWorker.postMessage(null, [simulationChannel.port2, modelChannel.port1]);
    displayWorker.postMessage(null, [displayChannel.port2, modelChannel.port2]);
    simulationRpc = createRpc(simulationChannel.port1);
    displayRpc = createRpc(displayChannel.port1);
    registerHostServices(simulationRpc, options);
    registerHostServices(displayRpc, options);
    const simulation = simulationRpc.getProxy(fusedSimulationService);
    const display = displayRpc.getProxy(fusedDisplayService, {
      transfer: (member, args) => (member === 'attachAudio' ? [args[0] as MessagePort] : []),
    });
    const audio = connectFusedAudio(displayRpc, display, options.audio, (diagnostic) =>
      options.onDiagnostic?.(diagnostic),
    );
    subscriptions.push(
      simulation.onDidReportDiagnostic((entry) => options.onDiagnostic?.(entry)),
      display.onDidReportDiagnostic((entry) => options.onDiagnostic?.(entry)),
    );
    const ownedSimulationRpc = simulationRpc;
    const ownedDisplayRpc = displayRpc;
    let disposal: Promise<void> | undefined;
    return {
      audio,
      simulation,
      display,
      dispose() {
        return (disposal ??= (async () => {
          audio.dispose();
          for (const stop of subscriptions.splice(0)) {
            try {
              stop();
            } catch {
              // The endpoint may already be closed.
            }
          }
          ownedSimulationRpc.dispose();
          ownedDisplayRpc.dispose();
          const results = await Promise.allSettled([
            simulationWorker.terminate('fused runtime disposed'),
            displayWorker.terminate('fused runtime disposed'),
          ]);
          const problems = results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason as unknown);
          if (problems.length > 0) {
            throw new AggregateError(problems, 'Fused sandbox workers failed to terminate.');
          }
        })());
      },
    };
  } catch (cause) {
    for (const stop of subscriptions.splice(0)) {
      try {
        stop();
      } catch {
        // The endpoint may already be closed.
      }
    }
    simulationRpc?.dispose();
    displayRpc?.dispose();
    await Promise.allSettled([
      simulationWorker.terminate('fused runtime failed to start'),
      displayWorker.terminate('fused runtime failed to start'),
    ]);
    throw cause;
  }
}

/** Package and resource services every guest of one workbench pulls from. */
function registerHostServices(endpoint: RpcEndpoint, options: IFusedConnectionOptions): void {
  const opened = new Map<string, Promise<PackageFiles>>();
  const openLock = (lock: DeviceLock): Promise<PackageFiles> => {
    const key = packageLockKey(lock);
    let pending = opened.get(key);
    if (pending === undefined) {
      pending = options.registry.open(lock);
      opened.set(key, pending);
    }
    return pending;
  };
  endpoint.register(
    fusedHostPackageService,
    {
      async open(lock: DeviceLock) {
        const files = await openLock(lock);
        return { lock: files.lock, files: files.files };
      },
      async read(lock: DeviceLock, path: string) {
        const files = await openLock(lock);
        const bytes = await files.read(path);
        if (!(bytes instanceof Uint8Array)) {
          throw new Error(`The registry returned no bytes for ${lock.id}/${path}.`);
        }
        // The transfer hands the buffer to the guest, so the editor keeps its own copy.
        return bytes.slice();
      },
    },
    { transfer: transferPackageBytes },
  );
  endpoint.register(
    fusedHostResourceService,
    {
      async readResource(request) {
        if (options.resolveResource === undefined) {
          throw new Error(
            `No resource resolver is configured for ${request.instanceId}/${request.property}.`,
          );
        }
        return (await options.resolveResource(request)).slice();
      },
      async resolveProgramProject(id, target) {
        if (!options.programs?.projects) throw new Error('No program project provider configured.');
        const artifact = await options.programs.projects.resolve(id, target);
        return artifact.kind === 'memory'
          ? { kind: 'memory', format: artifact.format, data: artifact.data.slice() }
          : {
              kind: 'filesystem',
              files: artifact.files.map((file) => ({ path: file.path, data: file.data.slice() })),
            };
      },
    },
    {
      transfer: (member, value) =>
        member === 'resolveProgramProject'
          ? transferProgramArtifact(member, value)
          : transferResourceBytes(member, value),
    },
  );
}
