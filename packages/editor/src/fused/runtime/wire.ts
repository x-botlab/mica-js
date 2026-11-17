/**
 * Failure and transfer conventions of the fused sandbox bridge (RFC 0025).
 *
 * RPC carries only `name` and `message` across a sandbox boundary, so a contract failure travels as
 * JSON inside the message and is rebuilt on the other side. Nothing here imports device or model
 * code: the main thread must never pull model execution into its own bundle.
 */
import type { Value } from '@mica-js/document/fused';
import type {
  IFusedFirmwareSnapshot,
  IFusedProgramFilesSnapshot,
  IFusedOverlayFrame,
  IFusedPrepareResult,
} from './protocol';

/** `name` of a failure whose message carries a {@link IFusedFailurePayload}. */
export const FUSED_WIRE_FAILURE = 'FusedSandboxFailure';

/** One failure of a guest call, flattened for the wire. */
export interface IFusedFailurePayload {
  /** `method` keeps a business rejection, `runtime` a contract error, `failure` anything else. */
  readonly kind: 'method' | 'runtime' | 'failure';
  readonly code: string;
  readonly message: string;
  readonly instanceId?: string;
  /** JSON-safe snapshot of a `MethodError` payload. */
  readonly details?: unknown;
}

export interface IFusedBridgeErrorOptions {
  readonly instanceId?: string;
  readonly details?: Value;
  /**
   * Error name. A method rejection keeps `MethodError`, so the SDK predicate of the consumer still
   * recognizes it; every other failure keeps the default name.
   */
  readonly name?: string;
}

/**
 * Host-side failure of the fused sandbox bridge.
 *
 * Mirrors `FusedRuntimeError` (`code`, optional `instanceId`) and keeps the business payload of a
 * model `MethodError` rejection. Guest code uses the same class to build the failure it throws.
 */
export class FusedBridgeError extends Error {
  readonly code: string;
  readonly instanceId: string | undefined;
  readonly details: Value | undefined;

  constructor(code: string, message: string, options: IFusedBridgeErrorOptions = {}) {
    super(message);
    this.name = options.name ?? 'FusedBridgeError';
    this.code = code;
    this.instanceId = options.instanceId;
    this.details = options.details;
  }
}

export function isFusedBridgeError(value: unknown): value is FusedBridgeError {
  return value instanceof FusedBridgeError;
}

/** Encodes one failure as an `Error` the RPC layer can carry. */
export function toWireFailure(cause: unknown): Error {
  const payload = failurePayload(cause);
  return Object.assign(new Error(JSON.stringify(payload)), { name: FUSED_WIRE_FAILURE });
}

/** Rebuilds the failure of a rejected guest call; other errors pass through. */
export function fromWireFailure(cause: unknown): Error {
  if (!(cause instanceof Error) || cause.name !== FUSED_WIRE_FAILURE) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  const payload = decodePayload(cause.message);
  if (payload === undefined) {
    return cause;
  }
  return new FusedBridgeError(payload.code, payload.message, {
    ...(payload.kind === 'method' ? { name: 'MethodError' } : {}),
    ...(payload.instanceId === undefined ? {} : { instanceId: payload.instanceId }),
    ...(payload.details === undefined ? {} : { details: payload.details as Value }),
  });
}

/** Runs one guest call and rebuilds a wire failure of its rejection. */
export async function mapWireFailure<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw fromWireFailure(cause);
  }
}

/** Whether a value is a decodable overlay bitmap of this realm. */
export function isImageBitmap(value: unknown): value is ImageBitmap {
  return typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap;
}

/** Transfer list of one `prepare` result: every byte snapshot of the presentation props. */
export function transferPresentationBytes(member: string, value: unknown): readonly Transferable[] {
  if (member !== 'prepare') return [];
  const instances = (value as IFusedPrepareResult | undefined)?.instances ?? [];
  const buffers = new Set<ArrayBuffer>();
  for (const instance of instances) {
    for (const prop of Object.values(instance.props)) collectPropBytes(prop, buffers);
  }
  return [...buffers];
}

function collectPropBytes(value: unknown, buffers: Set<ArrayBuffer>): void {
  if (value instanceof Uint8Array) {
    if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
    return;
  }
  const snapshot = value as IFusedFirmwareSnapshot | IFusedProgramFilesSnapshot | null;
  if (snapshot === null || typeof snapshot !== 'object') return;
  if (snapshot.kind === 'filesystem') {
    for (const file of snapshot.files) collectPropBytes(file.data, buffers);
    return;
  }
  if (snapshot.kind !== 'firmware') return;
  for (const segment of snapshot.segments) {
    if (segment.bytes instanceof Uint8Array && segment.bytes.buffer instanceof ArrayBuffer) {
      buffers.add(segment.bytes.buffer);
    }
  }
}
/** Transfer list of one `render` result. */
export function transferOverlayFrame(member: string, value: unknown): readonly Transferable[] {
  if (member !== 'render') return [];
  const frame = value as IFusedOverlayFrame | undefined;
  if (frame === undefined || frame === null) return [];
  return isImageBitmap(frame.bitmap) ? [frame.bitmap] : [];
}

/** Transfer list of one `Uint8Array` result. */
export function transferBytes(value: unknown): readonly Transferable[] {
  if (!(value instanceof Uint8Array)) return [];
  if (!(value.buffer instanceof ArrayBuffer)) return [];
  if (value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) return [];
  return [value.buffer];
}

/** Transfer list of one host package `read` result. */
export function transferPackageBytes(member: string, value: unknown): readonly Transferable[] {
  return member === 'read' ? transferBytes(value) : [];
}

/** Transfer list of one host `readResource` result. */
export function transferResourceBytes(member: string, value: unknown): readonly Transferable[] {
  return member === 'readResource' ? transferBytes(value) : [];
}

export function transferProgramArtifact(member: string, value: unknown): readonly Transferable[] {
  if (member !== 'resolveProgramProject') return [];
  const artifact = value as {
    readonly kind?: string;
    readonly data?: Uint8Array;
    readonly files?: readonly { readonly data: Uint8Array }[];
  };
  const files = artifact.files;
  return [
    ...new Set(
      files ? files.flatMap((file) => transferBytes(file.data)) : transferBytes(artifact.data),
    ),
  ];
}

function failurePayload(cause: unknown): IFusedFailurePayload {
  const message = messageOf(cause);
  const method = methodErrorOf(cause);
  if (method !== undefined) {
    return {
      kind: 'method',
      code: method.code,
      message: method.message,
      ...(method.details === undefined ? {} : { details: jsonSafe(method.details) }),
    };
  }
  const code = codeOf(cause);
  const instanceId = instanceIdOf(cause);
  return {
    kind: code === 'Error' ? 'failure' : 'runtime',
    code,
    message,
    ...(instanceId === undefined ? {} : { instanceId }),
  };
}

function decodePayload(message: string): IFusedFailurePayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate['code'] !== 'string' || typeof candidate['message'] !== 'string') {
    return undefined;
  }
  const kind =
    candidate['kind'] === 'method' || candidate['kind'] === 'runtime'
      ? candidate['kind']
      : 'failure';
  return {
    kind,
    code: candidate['code'],
    message: candidate['message'],
    ...(typeof candidate['instanceId'] === 'string' ? { instanceId: candidate['instanceId'] } : {}),
    ...(candidate['details'] === undefined ? {} : { details: candidate['details'] }),
  };
}

function codeOf(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return 'Error';
  const code = (cause as { readonly code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return code;
  const name = (cause as { readonly name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : 'Error';
}

function instanceIdOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const instanceId = (cause as { readonly instanceId?: unknown }).instanceId;
  return typeof instanceId === 'string' ? instanceId : undefined;
}

/**
 * Recognizes a model business rejection without importing the SDK: the runtime and its guests may
 * carry different copies of the class, so the shape plus the registered name is what counts.
 */
function methodErrorOf(
  cause: unknown,
): { readonly code: string; readonly message: string; readonly details?: unknown } | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const candidate = cause as {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: unknown;
  };
  if (candidate.name !== 'MethodError' || typeof candidate.code !== 'string') return undefined;
  if (typeof candidate.message !== 'string') return undefined;
  return {
    code: candidate.code,
    message: candidate.message,
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
  };
}

/** JSON-safe copy of a model value; byte payloads become number arrays. */
function jsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map((item: unknown) => jsonSafe(item));
  if (typeof value === 'object' && value !== null) {
    const record: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) record[key] = jsonSafe(member);
    return record;
  }
  return value;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
