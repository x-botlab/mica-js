import { describe, expect, it } from 'vitest';
import { SandboxError, SandboxWorker } from './index';

const code = "self.addEventListener('message', () => {});";

describe('Node / SSR safety', () => {
  it('exports the Worker-like lifecycle surface', () => {
    expect(typeof SandboxWorker).toBe('function');
    expect(SandboxWorker.prototype).toHaveProperty('terminate');
    expect(SandboxWorker.prototype).toHaveProperty('postMessage');
    expect(SandboxWorker.prototype).toHaveProperty('addEventListener');
    expect(SandboxWorker.prototype).toHaveProperty('onError');
    expect(SandboxWorker.prototype).not.toHaveProperty('call');
    expect(SandboxWorker.prototype).not.toHaveProperty('request');
    expect(SandboxWorker.prototype).not.toHaveProperty('notify');
    expect(SandboxWorker.prototype).not.toHaveProperty('on');
    expect(SandboxWorker.prototype).not.toHaveProperty('emit');
    expect(typeof SandboxError).toBe('function');
  });

  it('fails with a clear error when there is no document', async () => {
    expect(() => new SandboxWorker(code)).toThrow(/no document is available/);
  });
});
