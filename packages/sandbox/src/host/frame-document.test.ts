import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyCspOverride, buildFrameCsp } from './csp';
import { FRAME_BOOTSTRAP, buildFrameDocument } from './frame-document';

describe('frame CSP', () => {
  it('allows blob workers and inline code but blocks the network', () => {
    const csp = buildFrameCsp({ nonce: 'abc123' });

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123' blob: 'unsafe-eval'");
    expect(csp).toContain('worker-src blob:');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
  });

  it("falls back to 'unsafe-inline' for the hosted frame document", () => {
    expect(buildFrameCsp()).toContain("script-src 'unsafe-inline' blob: 'unsafe-eval'");
  });

  it('supports string and function overrides', () => {
    const base = buildFrameCsp({ nonce: 'n' });
    expect(applyCspOverride(base, 'default-src none')).toBe('default-src none');
    expect(applyCspOverride(base, (csp) => `${csp}; report-uri /r`)).toBe(`${base}; report-uri /r`);
    expect(applyCspOverride(base, undefined)).toBe(base);
  });
});

describe('frame document', () => {
  it('embeds the nonce, the CSP and the bootstrap', () => {
    const html = buildFrameDocument({ csp: buildFrameCsp({ nonce: 'nonce-1' }), nonce: 'nonce-1' });

    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toContain("script-src 'nonce-nonce-1'");
    expect(html).toContain('<script nonce="nonce-1">');
    expect(html).toContain('mica:boot');
    expect(html).toContain('mica:frame-ready');
    expect(html).toContain('mica:worker-started');
  });

  it('escapes attribute values', () => {
    const html = buildFrameDocument({ csp: "default-src 'none'", nonce: 'a"b' });
    expect(html).toContain('nonce="a&quot;b"');
  });

  it('keeps the bootstrap free of a guest-side startup envelope', () => {
    expect(FRAME_BOOTSTRAP).not.toContain('mica:init');
    expect(FRAME_BOOTSTRAP).not.toContain('runtime');
    expect(FRAME_BOOTSTRAP).toContain('new Worker(workerUrl)');
    expect(FRAME_BOOTSTRAP).toContain('worker.postMessage(data, event.ports)');
    expect(FRAME_BOOTSTRAP).toContain('worker.onmessage');
    expect(FRAME_BOOTSTRAP).toContain('worker.onmessageerror');
    expect(FRAME_BOOTSTRAP).toContain('worker.terminate()');
  });

  it('never closes the bootstrap script early', () => {
    const html = buildFrameDocument({ csp: buildFrameCsp({ nonce: 'n' }), nonce: 'n' });
    const scriptBody = html.slice(html.indexOf('<script'));
    const firstClose = scriptBody.indexOf('</script>');
    const lastClose = scriptBody.lastIndexOf('</script>');
    expect(firstClose).toBe(lastClose);
  });
});

class FakeWorker {
  readonly posted: Array<{ data: unknown; transfer: readonly unknown[] }> = [];
  terminated = false;
  onmessage: ((event: { data: unknown; ports: readonly MessagePort[] }) => void) | undefined;
  onmessageerror: ((event: { data: unknown; ports: readonly MessagePort[] }) => void) | undefined;
  onerror: ((event: unknown) => void) | undefined;

  constructor(
    readonly url: string,
    private readonly onCreated: (worker: FakeWorker) => void,
  ) {
    onCreated(this);
  }

  postMessage(data: unknown, transfer: readonly unknown[] = []): void {
    this.posted.push({ data, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function createHarness(options: { failWorker?: boolean } = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const workers: FakeWorker[] = [];
  const created: Array<{ url: string; parts: readonly unknown[] }> = [];
  const revoked: string[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const parent = {
    postMessage: (message: Record<string, unknown>) => {
      posted.push(message);
    },
  };

  function createWorker(url: string): FakeWorker {
    if (options.failWorker) throw new Error('worker construction blocked');
    return new FakeWorker(url, (worker) => workers.push(worker));
  }

  runInNewContext(FRAME_BOOTSTRAP, {
    parent,
    window: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === 'message') listeners.push(listener);
      },
    },
    Worker: createWorker,
    Blob: class {
      constructor(
        readonly parts: readonly unknown[],
        readonly init: unknown,
      ) {}
    },
    URL: {
      createObjectURL: (blob: { parts: readonly unknown[] }) => {
        const url = `blob:mock/${created.length}`;
        created.push({ url, parts: blob.parts });
        return url;
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    },
  } as never);

  return {
    posted,
    workers,
    created,
    revoked,
    boot(code: string, ports: readonly unknown[] = []) {
      for (const listener of listeners) {
        listener({ source: parent, data: { type: 'mica:boot', code }, ports });
      }
      return workers.at(-1);
    },
    message(data: unknown, ports: readonly unknown[] = []) {
      for (const listener of listeners) listener({ source: parent, data, ports });
    },
    terminate() {
      for (const listener of listeners)
        listener({ source: parent, data: { type: 'mica:terminate', control: true } });
    },
    fromOtherSource() {
      for (const listener of listeners) {
        listener({ source: {}, data: { type: 'mica:terminate', control: true } });
      }
    },
  };
}

describe('frame bootstrap', () => {
  it('only announces readiness until the host boots it', () => {
    const harness = createHarness();

    expect(harness.posted).toEqual([{ type: 'mica:frame-ready' }]);
    expect(harness.workers).toEqual([]);
  });

  it('runs the caller code as the native worker script', () => {
    const harness = createHarness();
    const worker = harness.boot('self.onmessage = () => {};');

    expect(harness.created).toEqual([
      { url: 'blob:mock/0', parts: ['self.onmessage = () => {};'] },
    ]);
    expect(worker?.url).toBe('blob:mock/0');
    expect(worker?.posted).toEqual([]);
    expect(harness.posted.at(-1)).toEqual({ type: 'mica:worker-started' });

    const messagePort = new MessageChannel().port1;
    harness.message({ ping: 1 }, [messagePort]);
    expect(worker?.posted).toEqual([{ data: { ping: 1 }, transfer: [messagePort] }]);
  });

  it('forwards worker messages and message errors', () => {
    const harness = createHarness();
    const worker = harness.boot('x');
    const port = new MessageChannel().port1;

    worker?.onmessage?.({ data: { pong: 1 }, ports: [port] });
    expect(harness.posted.at(-1)).toEqual({ type: 'mica:worker-message', data: { pong: 1 } });

    worker?.onmessageerror?.({ data: { bad: true }, ports: [] });
    expect(harness.posted.at(-1)).toEqual({
      type: 'mica:worker-messageerror',
      data: { bad: true },
    });
  });

  it('forwards uncaught worker errors with their location', () => {
    const harness = createHarness();
    const worker = harness.boot('throw new Error("boom");');

    worker?.onerror?.({ message: 'boom', filename: 'blob:mock/0', lineno: 3, colno: 7 });

    expect(harness.posted.at(-1)).toEqual({
      type: 'mica:worker-error',
      message: 'boom',
      filename: 'blob:mock/0',
      lineno: 3,
      colno: 7,
    });
  });

  it('reports a worker that cannot be created', () => {
    const harness = createHarness({ failWorker: true });

    harness.boot('x');

    expect(harness.posted.at(-1)).toEqual({
      type: 'mica:frame-error',
      message: 'worker construction blocked',
    });
  });

  it('terminates the worker and releases the object URL', () => {
    const harness = createHarness();
    const worker = harness.boot('x');

    harness.terminate();

    expect(worker?.terminated).toBe(true);
    expect(harness.revoked).toEqual(['blob:mock/0']);
  });

  it('ignores messages that do not come from the host page', () => {
    const harness = createHarness();
    const worker = harness.boot('x');

    harness.fromOtherSource();

    expect(worker?.terminated).toBe(false);
    expect(harness.revoked).toEqual([]);
  });
});
