import { SandboxError } from '../errors';
import { transferable } from '../internal/transfer';
import type { CapabilityTransfer } from '../internal/transfer';
import { CHILD_SANDBOX_METHODS } from '../protocol';
import type {
  ChildSandboxRequest,
  ChildSandboxResponse,
  ChildTerminateRequest,
  ChildTerminatedPayload,
} from '../protocol';
import type {
  ChildSandboxRef,
  SandboxHandle,
  SandboxHostOptions,
  SandboxLogEntry,
  SandboxSource,
  TrustedHtmlPolicy,
} from '../types';

/** Options every child inherits from its parent (frame mode, container, logging, ...). */
export interface ChildSandboxDefaults {
  container?: HTMLElement;
  hidden?: boolean;
  bootTimeoutMs?: number;
  frameUrl?: string;
  nonce?: string;
  trustedTypesPolicy?: TrustedHtmlPolicy;
  csp?: NonNullable<SandboxHostOptions['csp']>;
  runtime?: string;
  onLog?: (entry: SandboxLogEntry) => void;
}

export interface ChildSandboxRegistryInit {
  /** Diagnostic name of the parent sandbox, used in error messages. */
  owner: string;
  /**
   * Creates the real sandbox on the main thread. `parentPort` is the child end of the direct
   * channel; the created session must transfer it to its guest before boot finishes.
   */
  create(options: SandboxHostOptions, parentPort: MessagePort): Promise<SandboxHandle>;
  defaults?: ChildSandboxDefaults;
  /** Host-owned compositing target for guest-created children. */
  resolveCanvas?: (child: ChildSandboxRef) => HTMLCanvasElement | undefined;
  /** Mirrors a host-driven termination to the parent guest so its handle updates. */
  notifyTerminated?: (payload: ChildTerminatedPayload) => void;
}

interface ChildEntry {
  readonly handle: SandboxHandle;
  readonly name: string;
}

const CHILD_METHODS = new Set<string>(Object.values(CHILD_SANDBOX_METHODS));

/** Whether `method` is reserved for child sandbox lifecycle. */
export function isChildSandboxMethod(method: string): boolean {
  return CHILD_METHODS.has(method);
}

/**
 * Owns the child sandboxes a guest created through `$sandbox.createChildSandbox()`.
 *
 * Children live in the main thread next to their parent (flat physical topology). The registry
 * only handles creation and termination; runtime traffic goes directly over the `MessageChannel`
 * whose ends were handed to the parent guest and to the child worker:
 *
 * ```
 * create:    parent guest → host → child guest (both get one port)
 * runtime:   parent guest ⟷ child guest
 * terminate: parent guest → host → child destroyed
 * ```
 */
export class ChildSandboxRegistry {
  readonly #init: ChildSandboxRegistryInit;
  readonly #children = new Map<string, ChildEntry>();
  readonly #names = new Set<string>();
  readonly #pending = new Set<string>();
  #order = 0;
  #terminated = false;
  #termination: Promise<void> | undefined;

  constructor(init: ChildSandboxRegistryInit) {
    this.#init = init;
  }

  /** Whether `method` belongs to the child lifecycle protocol and must be routed here. */
  handles(method: string): boolean {
    return CHILD_METHODS.has(method);
  }

  async invoke(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case CHILD_SANDBOX_METHODS.create:
        return this.#createChild(args[0]);
      case CHILD_SANDBOX_METHODS.terminate:
        return this.#terminateChild(args[0]);
      default:
        throw new SandboxError('capability-not-found', `Unknown sandbox method "${method}"`);
    }
  }

  /** Terminates every child. Idempotent; individual failures are ignored. */
  async terminateAll(reason = 'parent terminated'): Promise<void> {
    if (this.#termination) return this.#termination;
    this.#terminated = true;

    const entries = [...this.#children.values()];
    this.#children.clear();
    this.#names.clear();
    this.#pending.clear();

    this.#termination = Promise.all(
      entries.map(async (entry) => {
        try {
          await entry.handle.terminate(reason);
        } catch {
          // Already gone: cleanup must not fail the parent.
        }
      }),
    ).then(() => undefined);
    return this.#termination;
  }

  async #createChild(raw: unknown): Promise<CapabilityTransfer<ChildSandboxResponse>> {
    this.#assertOpen();
    const request = asChildRequest(raw);
    if (this.#names.has(request.name) || this.#pending.has(request.name)) {
      throw new SandboxError(
        'invalid-options',
        `Sandbox "${this.#init.owner}" already has a child named "${request.name}"`,
      );
    }

    const options: SandboxHostOptions = {
      ...this.#init.defaults,
      name: request.name,
      source: request.source,
      capabilities: {},
    };
    if (request.maxFps !== undefined) options.maxFps = request.maxFps;
    if (request.captureConsole !== undefined) options.captureConsole = request.captureConsole;
    if (request.callTimeoutMs !== undefined) options.callTimeoutMs = request.callTimeoutMs;
    const ref: ChildSandboxRef = { name: request.name, index: this.#order++ };
    const canvas = this.#init.resolveCanvas?.(ref);
    if (canvas) options.canvas = canvas;

    const channel = new MessageChannel();
    this.#pending.add(request.name);
    let handle: SandboxHandle;
    try {
      handle = await this.#init.create(options, channel.port2);
    } catch (error) {
      closePort(channel.port1);
      closePort(channel.port2);
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'boot-failed',
        `Child sandbox "${request.name}" failed to start: ${describe(error)}`,
        { cause: error },
      );
    } finally {
      this.#pending.delete(request.name);
    }

    if (this.#terminated) {
      // The parent shut down while this child was booting: it must not outlive it.
      closePort(channel.port1);
      try {
        await handle.terminate('parent terminated');
      } catch {
        // Best effort: the parent is already gone.
      }
      throw new SandboxError(
        'terminated',
        `Sandbox "${this.#init.owner}" terminated before child "${request.name}" finished booting`,
      );
    }

    this.#children.set(handle.id, { handle, name: request.name });
    this.#names.add(request.name);

    return transferable(
      {
        childId: handle.id,
        name: handle.name,
        state: handle.state,
        info: handle.info,
        port: channel.port1,
      },
      [channel.port1],
    );
  }

  async #terminateChild(raw: unknown): Promise<void> {
    const payload = asTerminate(raw);
    const entry = this.#children.get(payload.childId);
    if (!entry) return;

    this.#children.delete(payload.childId);
    this.#names.delete(entry.name);

    const reason = payload.reason ?? 'child requested';
    try {
      await entry.handle.terminate(reason);
    } finally {
      this.#init.notifyTerminated?.({
        childId: entry.handle.id,
        name: entry.name,
        reason,
      });
    }
  }

  #assertOpen(): void {
    if (this.#terminated) {
      throw new SandboxError('terminated', `Sandbox "${this.#init.owner}" is terminated`);
    }
  }
}

function asChildRequest(value: unknown): ChildSandboxRequest {
  const record = asRecord(value, '`sandbox:createChild` needs an options payload');
  const request: ChildSandboxRequest = {
    name: asString(record['name'], '`name`'),
    source: asSource(record['source']),
  };
  if (typeof record['maxFps'] === 'number') request.maxFps = record['maxFps'];
  if (typeof record['captureConsole'] === 'boolean') {
    request.captureConsole = record['captureConsole'];
  }
  if (typeof record['callTimeoutMs'] === 'number') {
    request.callTimeoutMs = record['callTimeoutMs'];
  }
  return request;
}

function asSource(value: unknown): SandboxSource {
  const source = asRecord(value, '`source`');
  const type = source['type'];
  if (type !== 'module' && type !== 'script') {
    throw invalid("`source.type` must be 'module' or 'script'");
  }
  if ('code' in source) {
    const code = asString(source['code'], '`source.code`');
    return type === 'module' ? { type: 'module', code } : { type: 'script', code };
  }
  const url = asString(source['url'], '`source.url`');
  return type === 'module' ? { type: 'module', url } : { type: 'script', url };
}

function asTerminate(value: unknown): ChildTerminateRequest {
  const record = asRecord(value, '`sandbox:childTerminate` needs a payload');
  const payload: ChildTerminateRequest = {
    childId: asString(record['childId'], '`childId`'),
  };
  if (typeof record['reason'] === 'string') payload.reason = record['reason'];
  return payload;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value;
}

function closePort(port: MessagePort | undefined): void {
  try {
    port?.close();
  } catch {
    // Already transferred or closed.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string): SandboxError {
  return new SandboxError('invalid-options', message);
}
