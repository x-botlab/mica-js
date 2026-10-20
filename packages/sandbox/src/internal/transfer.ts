export const TRANSFERABLE_BRAND = Symbol.for('mica.sandbox.transferable');

export interface CapabilityTransfer<T = unknown> {
  readonly [TRANSFERABLE_BRAND]: true;
  readonly value: T;
  readonly transfer: readonly Transferable[];
}

/**
 * Wraps a capability return value so its buffers are moved instead of copied, e.g.
 * `loadWasm: async () => transferable(await fetch(...).then((r) => r.arrayBuffer()))`.
 */
export function transferable<T>(
  value: T,
  transfer?: readonly Transferable[],
): CapabilityTransfer<T> {
  const list = transfer ?? (Array.isArray(value) ? [] : [value as unknown as Transferable]);
  return { [TRANSFERABLE_BRAND]: true, value, transfer: list };
}

export function isCapabilityTransfer(value: unknown): value is CapabilityTransfer {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [TRANSFERABLE_BRAND]?: unknown })[TRANSFERABLE_BRAND] === true
  );
}

export function unpackTransfer(value: unknown): { value: unknown; transfer: Transferable[] } {
  if (isCapabilityTransfer(value)) {
    return { value: value.value, transfer: [...value.transfer] };
  }
  return { value, transfer: [] };
}
