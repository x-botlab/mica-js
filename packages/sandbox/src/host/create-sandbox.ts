import { GUEST_RUNTIME_SOURCE } from '../internal/runtime-source';
import type { SandboxContract, SandboxHandle, SandboxHostOptions } from '../types';
import { applyCspOverride, buildFrameCsp, generateNonce } from './csp';
import { buildFrameDocument } from './frame-document';
import { assertBrowserEnvironment, normalizeOptions, resolveSource } from './options';
import { SandboxSession } from './sandbox';
import { detectNonce } from './trusted-types';

/**
 * Boots a guest program inside a sandboxed iframe and a Web Worker, both with an opaque origin.
 *
 * @example
 * const sandbox = await createSandbox({
 *   source: { type: 'module', code: guestSource },
 *   capabilities: { draw: (commands) => renderCommands(commands) },
 * });
 * await sandbox.call('render', { value: 0.5 });
 */
export async function createSandbox<G extends SandboxContract = SandboxContract>(
  options: SandboxHostOptions,
): Promise<SandboxHandle<G>> {
  assertBrowserEnvironment();
  const normalized = normalizeOptions(options);
  const runtime = normalized.runtime ?? GUEST_RUNTIME_SOURCE;
  const source = await resolveSource(normalized.source);

  let frameDocument: string | undefined;
  if (normalized.frameUrl === undefined) {
    // Reusing the page nonce keeps the inline bootstrap allowed under a strict host CSP.
    const nonce = normalized.nonce ?? detectNonce() ?? generateNonce();
    const csp = applyCspOverride(buildFrameCsp({ nonce }), normalized.csp);
    frameDocument = buildFrameDocument({ csp, nonce });
  }

  const session = new SandboxSession<G>({ options: normalized, runtime, source, frameDocument });
  await session.boot();
  return session;
}
