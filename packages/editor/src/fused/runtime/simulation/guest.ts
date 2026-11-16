/**
 * Simulation guest of the fused editor runtime (RFC 0025).
 *
 * The guest owns the production headless runtime: the document snapshot, the verified package bytes,
 * the models and the electrical solve. The editor keeps no model code on its own thread; it reaches
 * this guest through typed RPC and receives model events, state changes and diagnostics as events.
 *
 * Package bytes, host resources and firmware artifacts are pulled from host services registered on
 * the same RPC endpoint, so verification, preparation and model execution all happen here.
 */
import { timePs } from '@mica-js/core';
import { Emitter } from '@mica-js/core/lifecycle';
import type { Disposable } from '@mica-js/core/lifecycle';
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import { parseFusedDocument, parseGeometry2D, parseStrictJson } from '@mica-js/document/fused';
import type {
  DeviceLock,
  DevicePropertyDescriptor,
  FusedDocument,
  FusedInstance,
  PackageFiles,
  Value,
} from '@mica-js/document/fused';
import {
  createHeadlessRuntime,
  FusedPreparationError,
  openDevicePackage,
  PreparationError,
  resolveInstanceProperties,
} from '@mica-js/sdk/fused';
import type {
  FirmwareArtifact,
  FirmwareProjectSource,
  HeadlessRuntime,
  ResourceResolver,
  RuntimeDiagnostic,
  RuntimeModelEvent,
  VerifiedPackage,
} from '@mica-js/sdk/fused';
import { fusedHostResourceService, fusedSimulationService } from '../protocol';
import type {
  IFusedInstancePresentation,
  IFusedLoadRequest,
  IFusedModelEventWire,
  IFusedPrepareRequest,
  IFusedPrepareResult,
  IFusedSessionState,
} from '../protocol';
import { decodeSource, importCode, presentationProps } from '../values';
import { FusedBridgeError, messageOf, toWireFailure, transferPresentationBytes } from '../wire';
import { createHostPackageGateway } from '../packages';
import { startSimulationModelChannel } from './model-channel';
import type { IFusedSimulationModelChannel } from './model-channel';

/** Replaceable guest dependencies, so the runtime can be exercised outside a browser worker. */
export interface IFusedSimulationGuestOptions {
  /** Creates the endpoint over the startup port; tests inject a fake. */
  readonly createEndpoint?: (port: MessagePort) => RpcEndpoint;
  /**
   * Startup ports after the RPC port. The first one is the model lane (RFC 0025), the display guest
   * holds the other end of the same channel.
   */
  readonly ports?: readonly MessagePort[];
  /** Evaluates one verified package module; defaults to a blob URL plus dynamic `import()`. */
  readonly importModule?: (code: string) => Promise<unknown>;
}

/** Guest runtime plus the RPC endpoint that serves it. */
export interface IFusedSimulationGuest {
  readonly rpc: RpcEndpoint;
  dispose(): Promise<void>;
}

const IDLE: IFusedSessionState = Object.freeze({ status: 'idle', simTime: timePs(0) });

interface Session {
  readonly runtime: HeadlessRuntime;
  readonly subscriptions: Disposable[];
}

/** Starts the simulation guest on the startup port of a sandbox worker. */
export function startFusedSimulationGuest(
  port: MessagePort,
  options: IFusedSimulationGuestOptions = {},
): IFusedSimulationGuest {
  const endpoint = (options.createEndpoint ?? createRpc)(port);
  const importModule = options.importModule ?? importCode;
  const packages = createHostPackageGateway(endpoint);
  const resources = createResourceGateway(endpoint);
  const diagnostics = new Emitter<RuntimeDiagnostic>();
  const states = new Emitter<IFusedSessionState>();
  const events = new Emitter<IFusedModelEventWire>();
  const modelPort = options.ports?.[0];
  const modelChannel: IFusedSimulationModelChannel | undefined =
    modelPort === undefined
      ? undefined
      : startSimulationModelChannel(modelPort, {
          call: (instanceId, method, params) => callModel(instanceId, method, params),
        });

  let state: IFusedSessionState = IDLE;
  let session: Session | undefined;
  /** Identity of the live session, so events of a discarded candidate never reach a listener. */
  let sessionToken: object | undefined;
  /** Incremented by every session transition, so late results of a replaced session are dropped. */
  let sequence = 0;
  let closing = false;
  let disposal: Promise<void> | undefined;

  endpoint.register(
    fusedSimulationService,
    {
      prepare,
      load,
      step,
      resume,
      pause,
      reset,
      dispose: releaseModels,
      call: (instanceId, method, params) => callModel(instanceId, method, params),
      getState: () => state,
      onDidChangeState(listener) {
        const subscription = states.event((value) => listener(value));
        return () => subscription.dispose();
      },
      onDidReportDiagnostic(listener) {
        const subscription = diagnostics.event((value) => listener(value));
        return () => subscription.dispose();
      },
      onDidModelEvent(listener) {
        const subscription = events.event((value) => listener(value));
        return () => subscription.dispose();
      },
    },
    // Presentation byte and firmware snapshots are handed over, never cloned.
    { transfer: transferPresentationBytes },
  );

  return {
    rpc: endpoint,
    dispose,
  };

  function report(entry: RuntimeDiagnostic): void {
    diagnostics.fire(entry);
  }

  function setState(next: IFusedSessionState): void {
    if (next.status === state.status && next.simTime === state.simTime) return;
    state = next;
    states.fire(next);
  }

  function assertOpen(): void {
    if (closing) {
      throw toWireFailure(
        new FusedBridgeError(
          'runtime/unavailable-state',
          'The fused simulation guest is disposed.',
        ),
      );
    }
  }

  function requireSession(operation: string): Session {
    assertOpen();
    if (session === undefined) {
      throw toWireFailure(
        new FusedBridgeError(
          'runtime/unavailable-state',
          `${operation} requires mounted models; prepare a run session first.`,
        ),
      );
    }
    return session;
  }

  async function prepare(request: IFusedPrepareRequest): Promise<IFusedPrepareResult> {
    assertOpen();
    const document = parseFusedDocument(request.document);
    const problems: RuntimeDiagnostic[] = [];
    const instances: IFusedInstancePresentation[] = [];
    for (const [index, instance] of document.instances.entries()) {
      try {
        const described = await describeInstance(index, document, instance);
        if (described !== undefined) instances.push(described);
      } catch (cause) {
        // A presentation-only failure drops the view of that instance; the models of a run session
        // and every other presentation keep going (RFC 0025 `runtime/presentation-failed`).
        if (cause instanceof FusedBridgeError && cause.code === 'runtime/presentation-failed') {
          report({ code: cause.code, message: cause.message, instanceId: instance.id });
          continue;
        }
        problems.push({
          code: 'runtime/prepare-failed',
          message: `${instance.id}: ${messageOf(cause)}`,
          instanceId: instance.id,
        });
      }
    }
    for (const problem of problems) report(problem);
    if (problems.length > 0) {
      throw toWireFailure(
        new FusedBridgeError(
          'runtime/prepare-failed',
          `${problems.length} instance(s) cannot join the 2D scene.`,
        ),
      );
    }
    return { instances };
  }

  async function describeInstance(
    index: number,
    document: FusedDocument,
    instance: FusedInstance,
  ): Promise<IFusedInstancePresentation | undefined> {
    const dependency = document.dependencies[instance.device];
    if (dependency === undefined) {
      throw new FusedBridgeError(
        'document/unlocked-device',
        `Instance "${instance.id}" uses the unlocked device "${instance.device}".`,
        { instanceId: instance.id },
      );
    }
    const lock: DeviceLock = {
      id: instance.device,
      version: dependency.version,
      integrity: dependency.integrity,
    };
    const verified = await openDevicePackage(packages, lock);
    const view = verified.manifest.view2d;
    if (view === undefined) {
      report({
        code: 'view2d/unsupported',
        message: `${instance.device} declares no 2D geometry; "${instance.id}" stays out of the 2D scene.`,
        instanceId: instance.id,
      });
      return undefined;
    }
    const pins = Object.keys(verified.manifest.pins ?? {});
    const geometryValue =
      typeof view.geometry === 'string'
        ? parseStrictJson(decodeSource(await verified.read(view.geometry)))
        : view.geometry;
    const descriptors = verified.manifest.properties ?? {};
    return {
      instanceId: instance.id,
      device: instance.device,
      lock,
      geometry: parseGeometry2D(geometryValue, pins),
      view: view.entry,
      props: presentationProps(
        await resolvePresentationProps(verified, descriptors, instance, index),
        descriptors,
      ),
      methods: Object.keys(verified.manifest.model?.methods ?? {}),
      events: Object.keys(verified.manifest.model?.events ?? {}),
    };
  }

  /**
   * Resolves the declared properties a presentation reads through the SDK, so the projection is the
   * same snapshot the model receives: manifest defaults, document overrides, package and host
   * resources, and a loaded firmware image.
   *
   * @throws {FusedBridgeError} `runtime/presentation-failed` naming every property that failed.
   */
  async function resolvePresentationProps(
    verified: VerifiedPackage,
    descriptors: Readonly<Record<string, DevicePropertyDescriptor>>,
    instance: FusedInstance,
    index: number,
  ): Promise<Readonly<Record<string, unknown>>> {
    try {
      const resolution = await resolveInstanceProperties({
        instanceId: instance.id,
        package: verified,
        descriptors,
        overrides: instance.properties ?? {},
        // The model IR adds nothing to `props`: an empty map keeps this resolution identical to the
        // one the runtime performs while it builds the board, so edit mode needs no model module.
        irProperties: new Map<string, never>(),
        pointer: ['instances', String(index), 'properties'],
        resolveResource: resources.resolveResource,
        projects: resources.projects,
      });
      return resolution.props;
    } catch (cause) {
      throw new FusedBridgeError(
        'runtime/presentation-failed',
        `Presentation properties of "${instance.id}" cannot be resolved: ${describeProblems(
          cause,
          descriptors,
        )}`,
        { instanceId: instance.id },
      );
    }
  }

  async function load(request: IFusedLoadRequest): Promise<IFusedSessionState> {
    assertOpen();
    const step = request.step;
    if (!Number.isSafeInteger(step) || step <= 0) {
      throw toWireFailure(
        new FusedBridgeError(
          'runtime/invalid-time',
          `\`step\` must be a positive integer number of picoseconds, received ${String(step)}.`,
        ),
      );
    }
    const document = parseFusedDocument(request.document);
    const attempt = ++sequence;
    const token = {};
    const superseded = (): boolean => closing || attempt !== sequence;
    /** Events of the factory phase are queued and delivered once the session is adopted. */
    const pending: RuntimeModelEvent[] = [];
    let created: HeadlessRuntime;
    try {
      created = await createHeadlessRuntime({
        document,
        registry: packages,
        loadModule,
        step,
        resolveResource: resources.resolveResource,
        projects: resources.projects,
        onModelEvent: (event) => {
          if (sessionToken === token) publishModelEvent(event);
          else if (!superseded()) pending.push(event);
        },
        onDiagnostic: (entry) => {
          if (!superseded()) report(entry);
        },
      });
    } catch (cause) {
      if (cause instanceof FusedPreparationError) {
        for (const entry of cause.diagnostics) report(entry);
      }
      throw toWireFailure(cause);
    }
    if (superseded()) {
      await created.dispose().catch(() => undefined);
      return state;
    }
    const previous = session;
    session = undefined;
    sessionToken = undefined;
    if (previous !== undefined) {
      // The candidate session exists before the running one is released, so a failed load keeps it.
      await releaseSession(previous, false);
    }
    // The model lane keeps the display subscriptions of the presentation prepared before this load.
    sessionToken = token;
    session = {
      runtime: created,
      subscriptions: [
        created.onDidChangeState((next) => {
          if (sessionToken === token) setState({ status: next.status, simTime: next.simTime });
        }),
        created.onDidReportDiagnostic((entry) => {
          if (sessionToken === token) report(entry);
        }),
      ],
    };
    for (const event of pending.splice(0)) publishModelEvent(event);
    const initial = created.getState();
    setState({ status: initial.status, simTime: initial.simTime });
    return state;
  }

  async function step(): Promise<IFusedSessionState> {
    const target = requireSession('step');
    await mapGuestCall(() => target.runtime.step());
    return state;
  }

  async function resume(): Promise<void> {
    const target = requireSession('resume');
    await mapGuestCall(() => target.runtime.resume());
  }

  function pause(): void {
    session?.runtime.pause();
  }

  async function reset(): Promise<void> {
    const target = requireSession('reset');
    await mapGuestCall(() => target.runtime.reset());
  }

  async function callModel(instanceId: string, method: string, params: Value): Promise<Value> {
    const target = session;
    if (closing || target === undefined) {
      throw toWireFailure(
        new FusedBridgeError(
          'model/disconnected',
          'No model is mounted; prepare a run session first.',
          {
            instanceId,
          },
        ),
      );
    }
    try {
      const client = target.runtime.getModel(instanceId);
      const invoke = client.methods[method];
      if (invoke === undefined) {
        throw new FusedBridgeError(
          'model/unknown-method',
          `The model of "${instanceId}" declares no method "${method}".`,
          { instanceId },
        );
      }
      return await invoke(params);
    } catch (cause) {
      throw toWireFailure(cause);
    }
  }

  async function releaseModels(): Promise<void> {
    assertOpen();
    await releaseCurrent(true);
  }

  async function releaseCurrent(strict: boolean): Promise<void> {
    const target = session;
    session = undefined;
    sessionToken = undefined;
    sequence += 1;
    modelChannel?.reset();
    setState(IDLE);
    if (target !== undefined) await releaseSession(target, strict);
  }

  async function releaseSession(target: Session, strict: boolean): Promise<void> {
    for (const subscription of target.subscriptions.splice(0)) subscription.dispose();
    try {
      await target.runtime.dispose();
    } catch (cause) {
      report({
        code: 'runtime/model-failed',
        message: `Releasing the models failed: ${messageOf(cause)}`,
      });
      if (strict) throw toWireFailure(cause);
    }
  }

  function publishModelEvent(event: RuntimeModelEvent): void {
    const wire: IFusedModelEventWire = {
      instanceId: event.instanceId,
      event: event.event,
      payload: event.payload,
    };
    modelChannel?.deliver(wire);
    events.fire(wire);
  }

  async function loadModule(files: PackageFiles, path: string) {
    return importModule(decodeSource(await files.read(path)));
  }

  function dispose(): Promise<void> {
    if (disposal !== undefined) return disposal;
    closing = true;
    disposal = (async () => {
      sequence += 1;
      modelChannel?.dispose();
      const target = session;
      session = undefined;
      sessionToken = undefined;
      const problems: unknown[] = [];
      if (target !== undefined) {
        try {
          await releaseSession(target, true);
        } catch (cause) {
          problems.push(cause);
        }
      }
      endpoint.dispose();
      diagnostics.dispose();
      states.dispose();
      events.dispose();
      if (problems.length > 0) throw problems[0];
    })();
    return disposal;
  }
}

/** One guest call whose rejection is rebuilt on the host. */
async function mapGuestCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw toWireFailure(cause);
  }
}

/** Host resources the runtime pulls while it resolves instance properties. */
function createResourceGateway(endpoint: RpcEndpoint): {
  readonly resolveResource: ResourceResolver;
  readonly projects: FirmwareProjectSource;
} {
  const host = endpoint.getProxy(fusedHostResourceService);
  // The presentation snapshot and the model snapshot resolve the same properties; the cache keeps
  // one host round trip per resource and one artifact fetch per project, and hands out copies.
  const resources = new Map<string, Uint8Array>();
  const artifacts = new Map<string, FirmwareArtifact>();
  return {
    resolveResource: async (request) => {
      const key = `${request.instanceId}\u0000${request.property}`;
      const cached = resources.get(key);
      if (cached !== undefined) return cached.slice();
      const bytes = await host.readResource(request);
      resources.set(key, bytes.slice());
      return bytes;
    },
    projects: {
      list: () => host.listProjects(),
      resolve: async (projectId) => {
        const cached = artifacts.get(projectId);
        if (cached !== undefined) return { format: cached.format, data: cached.data.slice() };
        const artifact = await host.resolveProject(projectId);
        artifacts.set(projectId, { format: artifact.format, data: artifact.data.slice() });
        return artifact;
      },
    },
  };
}

/** Flattens preparation problems, naming the property and its declared type. */
function describeProblems(
  cause: unknown,
  descriptors: Readonly<Record<string, DevicePropertyDescriptor>>,
): string {
  if (cause instanceof PreparationError) {
    return cause.problems
      .map((problem) => {
        const property = propertyOfPointer(problem.pointer, descriptors);
        const where = problem.pointer === '' ? '' : ` at ${problem.pointer}`;
        return `${problem.code}${where}${property === undefined ? '' : ` (${property})`}: ${problem.message}`;
      })
      .join('; ');
  }
  return messageOf(cause);
}

/** Names one property and its declared type from a JSON Pointer into the instance properties. */
function propertyOfPointer(
  pointer: string,
  descriptors: Readonly<Record<string, DevicePropertyDescriptor>>,
): string | undefined {
  const segments = pointer.split('/');
  const at = segments.indexOf('properties');
  const name = at < 0 ? undefined : segments[at + 1];
  if (name === undefined) return undefined;
  const type = descriptors[name]?.type;
  return type === undefined ? `property "${name}"` : `property "${name}", type ${type}`;
}
