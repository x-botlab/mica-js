import { describe, expect, it } from 'vitest';
import { SandboxError, createSandbox, transferable } from './index';

describe('Node / SSR safety', () => {
  it('imports without touching the DOM', () => {
    expect(typeof createSandbox).toBe('function');
    expect(typeof SandboxError).toBe('function');
    expect(typeof transferable).toBe('function');
  });

  it('fails with a clear error when there is no document', async () => {
    await expect(
      createSandbox({ source: { type: 'module', code: 'export function setup() {}' } }),
    ).rejects.toMatchObject({ code: 'unsupported-environment' });
  });
});
