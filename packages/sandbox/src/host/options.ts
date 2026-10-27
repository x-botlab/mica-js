import { SandboxError } from '../errors';
import type { SandboxSource, SandboxWorkerOptions, TrustedHtmlPolicy } from '../types';

export interface NormalizedOptions {
  source: SandboxSource;
  name: string;
  container: HTMLElement | undefined;
  bootTimeoutMs: number;
  frameUrl: string | undefined;
  nonce: string | undefined;
  trustedTypesPolicy: TrustedHtmlPolicy | undefined;
  csp: SandboxWorkerOptions['csp'];
  runtime: string | undefined;
  captureConsole: boolean;
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
  source: SandboxSource,
  options: SandboxWorkerOptions = {},
): NormalizedOptions {
  if (typeof options !== 'object' || options === null) {
    throw new SandboxError('invalid-options', 'SandboxWorker options must be an object');
  }
  if (typeof source !== 'object' || source === null) {
    throw new SandboxError('invalid-options', '`source` is required');
  }
  if (source.type !== 'module' && source.type !== 'script') {
    throw new SandboxError('invalid-options', "`source.type` must be 'module' or 'script'");
  }
  if ('code' in source) {
    if (typeof source.code !== 'string' || source.code.trim() === '') {
      throw new SandboxError('invalid-options', '`source.code` must be a non-empty string');
    }
  } else if (typeof source.url !== 'string' || source.url.trim() === '') {
    throw new SandboxError('invalid-options', '`source.url` must be a non-empty string');
  }

  if (options.frameUrl !== undefined && options.frameUrl.trim() === '') {
    throw new SandboxError('invalid-options', '`frameUrl` must be a non-empty string');
  }

  return {
    source,
    name: options.name ?? `sandbox-${nextSandboxId()}`,
    container: options.container,
    bootTimeoutMs: duration(options.bootTimeoutMs, DEFAULT_BOOT_TIMEOUT_MS, 'bootTimeoutMs'),
    frameUrl: options.frameUrl,
    nonce: options.nonce,
    trustedTypesPolicy: options.trustedTypesPolicy,
    csp: options.csp,
    runtime: options.runtime,
    captureConsole: options.captureConsole ?? true,
  };
}

/** Converts URL sources into inline code: the guest has no network access of its own. */
export async function resolveSource(source: SandboxSource): Promise<ResolvedSource> {
  const globalName = 'globalName' in source && source.globalName ? source.globalName : 'MicaGuest';

  if ('code' in source) {
    return { type: source.type, code: source.code, globalName };
  }

  let response: Response;
  try {
    response = await fetch(source.url);
  } catch (error) {
    throw new SandboxError('source-fetch', `Failed to fetch guest source "${source.url}"`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new SandboxError(
      'source-fetch',
      `Failed to fetch guest source "${source.url}": ${response.status} ${response.statusText}`,
    );
  }
  return { type: source.type, code: await response.text(), globalName };
}

export interface ResolvedSource {
  type: 'module' | 'script';
  code: string;
  globalName: string;
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
