import { SandboxError } from '../errors';
import type {
  SandboxCapabilities,
  SandboxHostOptions,
  SandboxSource,
  TrustedHtmlPolicy,
} from '../types';

export interface NormalizedOptions {
  source: SandboxSource;
  capabilities: SandboxCapabilities;
  name: string;
  container: HTMLElement | undefined;
  hidden: boolean;
  bootTimeoutMs: number;
  callTimeoutMs: number;
  onCallTimeout: 'reject' | 'terminate';
  frameUrl: string | undefined;
  nonce: string | undefined;
  trustedTypesPolicy: TrustedHtmlPolicy | undefined;
  csp: SandboxHostOptions['csp'];
  canvas: HTMLCanvasElement | undefined;
  onFrame: SandboxHostOptions['onFrame'];
  maxFps: number;
  runtime: string | undefined;
  captureConsole: boolean;
  onLog: SandboxHostOptions['onLog'];
}

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FPS = 60;

export function assertBrowserEnvironment(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw new SandboxError(
      'unsupported-environment',
      '@mica-js/sandbox can only run in a browser: no document is available',
    );
  }
}

export function normalizeOptions(options: SandboxHostOptions): NormalizedOptions {
  if (typeof options !== 'object' || options === null) {
    throw new SandboxError('invalid-options', 'createSandbox() requires an options object');
  }

  const source = options.source;
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

  if (options.canvas !== undefined && options.onFrame !== undefined) {
    throw new SandboxError(
      'invalid-options',
      'Pass either `canvas` (composited for you) or `onFrame` (composite yourself), not both',
    );
  }

  if (options.frameUrl !== undefined && options.frameUrl.trim() === '') {
    throw new SandboxError('invalid-options', '`frameUrl` must be a non-empty string');
  }

  const capabilities = options.capabilities ?? {};
  assertCapabilities(capabilities);

  return {
    source,
    capabilities,
    name: options.name ?? `sandbox-${nextSandboxId()}`,
    container: options.container,
    hidden: options.hidden ?? true,
    bootTimeoutMs: duration(options.bootTimeoutMs, DEFAULT_BOOT_TIMEOUT_MS, 'bootTimeoutMs'),
    callTimeoutMs: duration(options.callTimeoutMs, 0, 'callTimeoutMs'),
    onCallTimeout: options.onCallTimeout ?? 'reject',
    frameUrl: options.frameUrl,
    nonce: options.nonce,
    trustedTypesPolicy: options.trustedTypesPolicy,
    csp: options.csp,
    canvas: options.canvas,
    onFrame: options.onFrame,
    maxFps: duration(options.maxFps, DEFAULT_MAX_FPS, 'maxFps'),
    runtime: options.runtime,
    captureConsole: options.captureConsole ?? true,
    onLog: options.onLog,
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

function assertCapabilities(capabilities: SandboxCapabilities): void {
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new SandboxError('invalid-options', '`capabilities` must be an object');
  }
  for (const [name, capability] of Object.entries(capabilities)) {
    if (typeof capability !== 'function') {
      throw new SandboxError('invalid-options', `Capability "${name}" must be a function`);
    }
  }
}
