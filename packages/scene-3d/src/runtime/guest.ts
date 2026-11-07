/**
 * Access to the sandbox globals from a guest entry.
 *
 * `$sandbox` is injected by the Worker bootstrap and is never imported, so the host entries read it
 * from `globalThis` through a small structural interface. Keeping the interface local — instead of
 * a dependency on `@mica-js/sandbox` — means this package keeps working when the sandbox package is
 * bundled separately, and the tests can drive the entries with a plain object.
 */

import type { CircuitSandboxHandle, Scene3DCircuitOptions } from './protocol';

/** Guest program source accepted by `$sandbox.createChildSandbox()`. */
export interface GuestSandboxSource {
  readonly type: 'module' | 'script';
  readonly code?: string;
  readonly url?: string;
}

/** Subset of `ChildSandboxOptions` a circuit simulator needs. */
export interface GuestChildSandboxOptions {
  readonly name: string;
  readonly source: GuestSandboxSource;
  readonly capabilities?: Record<string, (...args: never[]) => unknown>;
  readonly maxFps?: number;
  readonly captureConsole?: boolean;
  readonly callTimeoutMs?: number;
}

/** Subset of `SandboxContext` the host entries use. */
export interface GuestSandboxLike {
  /** Aborted when the sandbox is terminated; the host uses it to release its children. */
  readonly signal?: AbortSignal;
  /** Console forwarded to the host; used to report disposal failures. */
  readonly log?: Console;
  /** Calls a host capability. */
  invoke<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  /** Registers the methods the host can call over RPC. */
  export(methods: Record<string, (...args: never[]) => unknown>): void;
  /** Creates a child sandbox; every call stays on the parent↔child MessageChannel. */
  createChildSandbox<T = unknown>(options: GuestChildSandboxOptions): Promise<T>;
}

/**
 * Reads `$sandbox` from the current global scope.
 *
 * @param scope Defaults to `globalThis`; pass a fake in tests.
 * @throws {Error} when the module is loaded outside a sandbox guest.
 */
export function getGuestSandbox(scope: unknown = globalThis): GuestSandboxLike {
  const sandbox = (scope as { readonly $sandbox?: unknown } | null | undefined)?.$sandbox;
  if (typeof sandbox !== 'object' || sandbox === null) {
    throw new Error(
      'Scene3DHost: $sandbox is not available. Load this entry from a sandbox guest ' +
        '(`createSandbox({ source: { type: "module", url } })`).',
    );
  }
  return sandbox as GuestSandboxLike;
}

/**
 * Calls an optional capability, returning `null` when the host did not register it.
 *
 * A capability that exists but fails still rejects: silently disabling circuits because of an
 * unrelated bug would be worse than failing the boot.
 */
export async function optionalInvoke<T>(
  sandbox: GuestSandboxLike,
  capability: string,
  ...args: unknown[]
): Promise<T | null> {
  try {
    return await sandbox.invoke<T>(capability, ...args);
  } catch (error) {
    if (isMissingCapability(error)) return null;
    throw error;
  }
}

/** Validates the value returned by the optional `getCircuitSource` capability. */
export function parseCircuitSource(value: unknown): GuestSandboxSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as {
    readonly type?: unknown;
    readonly code?: unknown;
    readonly url?: unknown;
  };
  if (source.type !== 'module' && source.type !== 'script') return null;
  if (typeof source.url === 'string' && source.url !== '') {
    return { type: source.type, url: source.url };
  }
  if (typeof source.code === 'string' && source.code !== '') {
    return { type: source.type, code: source.code };
  }
  return null;
}

/**
 * Builds the circuit wiring for a guest entry.
 *
 * The child source is one guest program (the circuit simulator); the host passes the per-instance
 * data — entity id, assembly reference and schematic — as capabilities, which run in this guest and
 * therefore never cross a worker boundary as serialised functions.
 */
export function createChildCircuitOptions(
  sandbox: GuestSandboxLike,
  source: GuestSandboxSource,
): Scene3DCircuitOptions {
  return {
    createSandbox: async (options) => {
      const handle = await sandbox.createChildSandbox<CircuitSandboxHandle>({
        name: options.name,
        source,
        capabilities: {
          getEntityId: () => options.entityId,
          getAssembly: () => options.assembly,
          getSchematic: () => options.schematic,
        },
      });
      return handle;
    },
  };
}

function isMissingCapability(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'capability-not-found'
  );
}
