import { describe, expect, it } from 'vitest';
import { SandboxError } from '../errors';
import { normalizeOptions } from './options';

const code = "self.addEventListener('message', () => {});";

describe('normalizeOptions', () => {
  it('applies defaults', () => {
    const options = normalizeOptions(code);

    expect(options.name).toMatch(/^sandbox-\d+$/);
    expect(options.bootTimeoutMs).toBe(10_000);
    expect(options.container).toBeUndefined();
  });

  it('rejects a missing or malformed worker script', () => {
    expect(() => normalizeOptions(undefined as never)).toThrow(SandboxError);
    expect(() => normalizeOptions('   ')).toThrow(/non-empty/);
    expect(() => normalizeOptions({ code } as never)).toThrow(/non-empty/);
  });

  it('rejects malformed options', () => {
    expect(() => normalizeOptions(code, null as never)).toThrow(SandboxError);
    expect(() => normalizeOptions(code, { frameUrl: ' ' })).toThrow(/frameUrl/);
    expect(() => normalizeOptions(code, { bootTimeoutMs: -1 })).toThrow(/bootTimeoutMs/);
  });
});
