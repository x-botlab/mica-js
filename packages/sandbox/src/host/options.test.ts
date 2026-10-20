import { describe, expect, it } from 'vitest';
import { SandboxError } from '../errors';
import { normalizeOptions, resolveSource } from './options';

const moduleSource = { type: 'module' as const, code: 'export function setup() {}' };

describe('normalizeOptions', () => {
  it('applies defaults', () => {
    const options = normalizeOptions({ source: moduleSource });

    expect(options.name).toMatch(/^sandbox-\d+$/);
    expect(options.hidden).toBe(true);
    expect(options.bootTimeoutMs).toBe(10_000);
    expect(options.callTimeoutMs).toBe(0);
    expect(options.onCallTimeout).toBe('reject');
    expect(options.maxFps).toBe(60);
    expect(options.captureConsole).toBe(true);
    expect(options.capabilities).toEqual({});
    expect(options.container).toBeUndefined();
  });

  it('rejects a missing or malformed source', () => {
    expect(() => normalizeOptions({} as never)).toThrow(SandboxError);
    expect(() => normalizeOptions({ source: { type: 'worker', code: 'x' } } as never)).toThrow(
      /source\.type/,
    );
    expect(() => normalizeOptions({ source: { type: 'module', code: '   ' } })).toThrow(
      /non-empty/,
    );
    expect(() => normalizeOptions({ source: { type: 'script', url: '' } })).toThrow(/non-empty/);
  });

  it('rejects conflicting frame targets and bad durations', () => {
    const canvas = {} as HTMLCanvasElement;
    expect(() =>
      normalizeOptions({ source: moduleSource, canvas, onFrame: () => undefined }),
    ).toThrow(/not both/);

    expect(() => normalizeOptions({ source: moduleSource, callTimeoutMs: -1 })).toThrow(
      /callTimeoutMs/,
    );
    expect(() => normalizeOptions({ source: moduleSource, maxFps: Number.NaN })).toThrow(/maxFps/);
  });

  it('rejects non-function capabilities', () => {
    expect(() =>
      normalizeOptions({ source: moduleSource, capabilities: { draw: 42 } as never }),
    ).toThrow(/must be a function/);
  });
});

describe('resolveSource', () => {
  it('defaults the classic script global name', async () => {
    const resolved = await resolveSource({ type: 'script', code: 'self.MicaGuest = {};' });
    expect(resolved).toEqual({
      type: 'script',
      code: 'self.MicaGuest = {};',
      globalName: 'MicaGuest',
    });
  });

  it('keeps a custom global name', async () => {
    const resolved = await resolveSource({ type: 'script', code: 'x', globalName: 'Emulator' });
    expect(resolved.globalName).toBe('Emulator');
  });
});
