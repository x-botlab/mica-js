/** Content-Security-Policy applied *inside* the sandbox frame document. */

export interface FrameCspOptions {
  /**
   * Nonce for the inline bootstrap. Omitted for the hosted frame document, which is a static file
   * and therefore has to rely on `'unsafe-inline'` (its content is owned by this package).
   */
  nonce?: string;
}

/**
 * Policy for the frame document. `'unsafe-eval'` is intentional: Emscripten/asm.js output relies
 * on `eval`/`new Function`, and the real boundary is the opaque origin plus the blocked network.
 */
export function buildFrameCsp(options: FrameCspOptions = {}): string {
  const scriptSource = options.nonce
    ? `'nonce-${options.nonce}' blob: 'unsafe-eval'`
    : "'unsafe-inline' blob: 'unsafe-eval'";

  return [
    "default-src 'none'",
    `script-src ${scriptSource}`,
    'worker-src blob:',
    "connect-src 'none'",
    "img-src 'none'",
    "style-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function applyCspOverride(
  defaultCsp: string,
  override: string | ((defaultCsp: string) => string) | undefined,
): string {
  if (override === undefined) return defaultCsp;
  return typeof override === 'function' ? override(defaultCsp) : override;
}

/** Attribute-safe random nonce for the inline bootstrap. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '');
}
