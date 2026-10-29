/**
 * Host-side, read-only access to the bytes a document references.
 *
 * `read` takes an absolute URI and resolves to the complete bytes of that resource; relative
 * references are resolved by the caller (see `resolveHostUri`) and `data:` URIs are decoded by the
 * caller instead of being passed here. Text decoding, structured parsing and base64 handling stay
 * with the caller. Failures reject with a `HostFsError`.
 */
export interface HostFs {
  read(uri: string): Promise<Uint8Array>;
}
