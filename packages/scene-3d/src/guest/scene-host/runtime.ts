import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import { createMujocoRuntime } from '../../physics/mujoco-runtime';
import type { PhysicsRuntime } from '../../physics';
import { createOffscreenRenderer } from '../../rendering/renderer.browser';
import type { OffscreenRenderer } from '../../rendering/renderer';
import { createScene3DHost, type Scene3DHostAPI } from '../../runtime/host';
import type {
  CircuitSandboxHandle,
  CircuitSandboxOptions,
  SceneHostHostContract,
} from '../../runtime/protocol';
import { circuitGuestService } from '../circuit/protocol';
import { sceneHostGuest, sceneHostHost } from './protocol';

/** Replaceable dependencies used by tests and by alternate browser renderers. */
export interface SceneHostRuntimeOptions {
  readonly createEndpoint?: (port: MessagePort) => RpcEndpoint;
  readonly createPhysics?: () => PhysicsRuntime;
  readonly createRenderer?: () => OffscreenRenderer;
}

export interface SceneHostWorkerRuntime {
  readonly host: Scene3DHostAPI;
  readonly endpoint: RpcEndpoint;
  dispose(): Promise<void>;
}

/** Starts the scene host on the first startup MessagePort. */
export async function startSceneHostRuntime(
  port: MessagePort,
  options: SceneHostRuntimeOptions = {},
): Promise<SceneHostWorkerRuntime> {
  const endpoint = options.createEndpoint?.(port) ?? createRpc(port);
  const hostServices = endpoint.getProxy<SceneHostHostContract>(sceneHostHost);
  const document = await hostServices.getDocument();
  const createCircuitSandbox = async (
    circuitOptions: CircuitSandboxOptions,
  ): Promise<CircuitSandboxHandle> => {
    const circuitPort = await hostServices.createCircuitSandbox(circuitOptions);
    return createCircuitSandboxHandle(circuitPort, {
      name: circuitOptions.name,
      release: (name) => hostServices.releaseCircuitSandbox(name),
    });
  };

  const host = await createScene3DHost({
    document,
    physics: options.createPhysics?.() ?? createMujocoRuntime(),
    renderer: options.createRenderer?.() ?? createOffscreenRenderer(),
    circuits: { createCircuitSandbox },
  });

  const registration = endpoint.register(sceneHostGuest, host, {
    transfer: (_member, value) => transferTransformPayload(value),
  });
  const closeDisposable = endpoint.onDidClose(() => {
    void host.dispose().catch(() => undefined);
  });

  return {
    host,
    endpoint,
    async dispose() {
      closeDisposable.dispose();
      registration.dispose();
      await host.dispose();
      endpoint.dispose();
    },
  };
}

/** Options of {@link createCircuitSandboxHandle}. */
export interface CircuitSandboxHandleOptions {
  /** Diagnostic name used by the main thread to find the worker it created. */
  readonly name: string;
  /** Asks the main thread to tear the circuit worker down; closing the port alone leaks it. */
  readonly release: (name: string) => Promise<void>;
}

/** Makes a direct circuit handle from the port returned by the main thread. */
export function createCircuitSandboxHandle(
  port: MessagePort,
  options: CircuitSandboxHandleOptions,
): CircuitSandboxHandle {
  const endpoint = createRpc(port);
  const proxy = endpoint.getProxy(circuitGuestService);
  let closed = false;
  return {
    name: options.name,
    call(method, ...args) {
      if (closed) return Promise.reject(new Error('Circuit sandbox is terminated'));
      const member = (
        proxy as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>
      )[method];
      if (typeof member !== 'function')
        return Promise.reject(new Error(`Unknown circuit method: ${method}`));
      return member(...args);
    },
    on(type, listener) {
      if (type !== 'jointCommand') return () => undefined;
      return proxy.onDidJointCommand(listener as (command: unknown) => void);
    },
    notify(method, args = []) {
      if (closed) return;
      const member = (
        proxy as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>
      )[method];
      if (typeof member === 'function') void member(...args).catch(() => undefined);
    },
    async terminate() {
      if (closed) return;
      closed = true;
      endpoint.dispose();
      port.close();
      await options.release(options.name).catch(() => undefined);
    },
  };
}

function transferTransformPayload(value: unknown): readonly Transferable[] {
  if (value instanceof Float32Array) return [value.buffer as ArrayBuffer];
  if (typeof value === 'object' && value !== null) {
    const transforms = (value as { readonly transforms?: unknown }).transforms;
    if (transforms instanceof Float32Array) return [transforms.buffer as ArrayBuffer];
  }
  return [];
}
