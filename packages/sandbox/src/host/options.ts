import { SandboxError } from '../errors';
import type { SandboxWorkerOptions, TrustedHtmlPolicy } from '../types';

export interface NormalizedOptions {
  name: string;
  container: HTMLElement | undefined;
  bootTimeoutMs: number;
  frameUrl: string | undefined;
  nonce: string | undefined;
  trustedTypesPolicy: TrustedHtmlPolicy | undefined;
  csp: SandboxWorkerOptions['csp'];
}

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
export function assertBrowserEnvironment(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw new SandboxError(
      'unsupported-environment',
      '@mica-js/sandbox can only run in a browser: no document is available',
    );
  }
}

export function normalizeOptions(
  code: string,
  options: SandboxWorkerOptions = {},
): NormalizedOptions {
  if (typeof code !== 'string' || code.trim() === '') {
    throw new SandboxError('invalid-options', '`code` must be a non-empty string');
  }
  if (typeof options !== 'object' || options === null) {
    throw new SandboxError('invalid-options', 'SandboxWorker options must be an object');
  }
  if (options.frameUrl !== undefined && options.frameUrl.trim() === '') {
    throw new SandboxError('invalid-options', '`frameUrl` must be a non-empty string');
  }
  return {
    name: options.name ?? `sandbox-${nextSandboxId()}`,
    container: options.container,
    bootTimeoutMs: duration(options.bootTimeoutMs, DEFAULT_BOOT_TIMEOUT_MS, 'bootTimeoutMs'),
    frameUrl: options.frameUrl,
    nonce: options.nonce,
    trustedTypesPolicy: options.trustedTypesPolicy,
    csp: options.csp,
  };
}

let sandboxCounter = 0;

function nextSandboxId(): number {
  sandboxCounter += 1;
  return sandboxCounter;
}

function duration(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SandboxError('invalid-options', `\`${field}\` must be a non-negative finite number`);
  }
  return value;
}
