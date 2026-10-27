import { describe, expect, it } from 'vitest';
import { SandboxError } from '../errors';
import { normalizeOptions, resolveSource } from './options';

const moduleSource = { type: 'module' as const, code: 'export function setup() {}' };

describe('normalizeOptions', () => {
  it('applies defaults', () => {
    const options = normalizeOptions(moduleSource);

    expect(options.name).toMatch(/^sandbox-\d+$/);
    expect(options.bootTimeoutMs).toBe(10_000);
    expect(options.captureConsole).toBe(true);
    expect(options.container).toBeUndefined();
  });

  it('rejects a missing or malformed source', () => {
    expect(() => normalizeOptions(undefined as never)).toThrow(SandboxError);
    expect(() => normalizeOptions({ type: 'worker', code: 'x' } as never)).toThrow(/source\.type/);
    expect(() => normalizeOptions({ type: 'module', code: '   ' })).toThrow(/non-empty/);
    expect(() => normalizeOptions({ type: 'script', url: '' })).toThrow(/non-empty/);
  });

  it('rejects bad boot durations', () => {
    expect(() => normalizeOptions(moduleSource, { bootTimeoutMs: -1 })).toThrow(/bootTimeoutMs/);
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
