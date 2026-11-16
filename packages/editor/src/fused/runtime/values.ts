/** Small shared helpers of the fused sandbox bridge. */
import type { DevicePropertyDescriptor } from '@mica-js/document/fused';
import type {
  FusedPresentationProps,
  FusedPresentationValue,
  IFusedFirmwareSegment,
  IFusedFirmwareSnapshot,
} from './protocol';
import { FusedBridgeError } from './wire';

/**
 * Resolved property snapshot handed to one presentation.
 *
 * Every declared property must appear in `resolved` (the simulation worker resolves the manifest
 * defaults and document overrides through the SDK, exactly like the model snapshot does). Byte and
 * firmware values are copied into independent arrays, because the snapshot crosses an RPC boundary
 * and is transferred to the presentation worker afterwards.
 *
 * @throws {FusedBridgeError} `runtime/presentation-failed` naming the property and its declared
 * type whenever a value cannot be projected. A presentation never receives a partial snapshot.
 */
export function presentationProps(
  resolved: Readonly<Record<string, unknown>>,
  descriptors: Readonly<Record<string, DevicePropertyDescriptor>>,
): FusedPresentationProps {
  const props: Record<string, FusedPresentationValue> = {};
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(resolved, name)) {
      throw unpresentable(name, descriptor.type, 'has no resolved value');
    }
    const value = resolved[name];
    if (value === undefined) {
      throw unpresentable(name, descriptor.type, 'resolved to undefined');
    }
    switch (descriptor.type) {
      case 'string':
      case 'color':
      case 'enum':
        if (typeof value === 'string') {
          props[name] = value;
          continue;
        }
        break;
      case 'integer':
      case 'number':
        if (typeof value === 'number') {
          props[name] = value;
          continue;
        }
        break;
      case 'boolean':
        if (typeof value === 'boolean') {
          props[name] = value;
          continue;
        }
        break;
      case 'image':
      case 'binary':
        if (value === null) {
          props[name] = null;
          continue;
        }
        props[name] = copyBytes(name, descriptor.type, value);
        continue;
      case 'firmware':
        if (value === null) {
          props[name] = null;
          continue;
        }
        props[name] = firmwareSnapshot(name, value);
        continue;
      default:
        break;
    }
    if (value === null && descriptor.nullable === true) {
      props[name] = null;
      continue;
    }
    throw unpresentable(name, descriptor.type, `resolved to ${describeValue(value)}`);
  }
  return Object.freeze(props);
}

/** Copies one read-only byte snapshot; the SDK hands `ReadonlyBytes`, not raw arrays. */
function copyBytes(name: string, type: string, value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  const candidate = value as { readonly slice?: unknown } | null;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof candidate.slice === 'function'
  ) {
    const copy = (candidate.slice as () => unknown).call(candidate);
    if (copy instanceof Uint8Array) return copy;
  }
  throw unpresentable(name, type, 'is not a byte snapshot');
}

/** Projects one loaded firmware image (RFC 0026) into a transferable snapshot. */
function firmwareSnapshot(name: string, value: unknown): IFusedFirmwareSnapshot {
  const segments = (value as { readonly segments?: unknown } | null)?.segments;
  if (!Array.isArray(segments)) {
    throw unpresentable(name, 'firmware', 'is not a firmware image');
  }
  const projected: IFusedFirmwareSegment[] = [];
  for (const segment of segments) {
    const candidate = segment as {
      readonly addressSpace?: unknown;
      readonly address?: unknown;
      readonly data?: unknown;
    };
    if (typeof candidate.addressSpace !== 'string' || typeof candidate.address !== 'number') {
      throw unpresentable(name, 'firmware', 'has a segment without an address space or address');
    }
    projected.push({
      addressSpace: candidate.addressSpace,
      address: candidate.address,
      bytes: copyBytes(name, 'firmware', candidate.data),
    });
  }
  return Object.freeze({ kind: 'firmware', segments: Object.freeze(projected) });
}

function unpresentable(name: string, type: string, reason: string): FusedBridgeError {
  return new FusedBridgeError(
    'runtime/presentation-failed',
    `Property "${name}" (${type}) ${reason}; the presentation cannot receive a partial snapshot.`,
  );
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a value of type ${typeof value}`;
}

/** Whether a callback returned a promise instead of finishing synchronously. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

/**
 * Evaluates one verified package module inside the guest.
 *
 * The bytes were verified against the package lock before this runs; a blob URL keeps the module
 * out of the host document and is revoked as soon as the namespace settles.
 */
export function importCode(code: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  return import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url));
}

/** Copies bytes into a plain `ArrayBuffer`, as `Blob` and transfer lists require. */
export function byteBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Decodes package bytes as UTF-8 module source, tolerating a leading byte order mark. */
export function decodeSource(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
}
