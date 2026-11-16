import { describe, expect, it, vi } from 'vitest';
import { servePackageRequest } from './package-fetch';
import type { IPackageFetchContext } from './package-fetch';

const ORIGIN = 'https://mica-1.example.com';
const SCOPE = `${ORIGIN}/components/workbench/environment/`;
const PACKAGE_URL = `${SCOPE}__mica_package__/`;
const PACKAGE_PREFIX = new URL(PACKAGE_URL).pathname;
// The grant covers the package mirror itself; the author base adds the view directory on top of it.
const ROOT = PACKAGE_PREFIX;
const CLIENT = 'client-content';

interface IHarness {
  readonly respondWith: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
  fetch(url: string, clientId?: string, init?: RequestInit): void;
}

function harness(options: { readonly authorized?: boolean } = {}): IHarness {
  const respondWith = vi.fn();
  const read = vi.fn(async (path: string) => {
    if (path === 'monitor/panel.css') return new TextEncoder().encode('body{}');
    throw new Error(`unknown ${path}`);
  });
  const context: IPackageFetchContext = {
    origin: ORIGIN,
    packagePrefix: PACKAGE_PREFIX,
    authorizedRoot: (clientId) =>
      options.authorized === false || clientId !== CLIENT ? undefined : ROOT,
    assets: { read },
  };
  return {
    respondWith,
    read,
    fetch(url, clientId = CLIENT, init) {
      servePackageRequest({ request: new Request(url, init), clientId, respondWith }, context);
    },
  };
}

describe('servePackageRequest', () => {
  it('refuses a reserved package request from an unauthorized controlled client', async () => {
    const run = harness({ authorized: false });
    run.fetch(`${PACKAGE_URL}monitor/panel.css`);
    expect(run.respondWith).toHaveBeenCalledOnce();
    const response = (await run.respondWith.mock.calls[0]![0]) as Response;
    // Never the network, which would answer with the deployment shell and look like a success.
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('reserved for the authorized device view');
    expect(run.read).not.toHaveBeenCalled();
  });

  it('refuses a reserved request from a client of another view', async () => {
    const run = harness();
    run.fetch(`${PACKAGE_URL}monitor/panel.css`, 'client-other');
    expect(run.respondWith).toHaveBeenCalledOnce();
    expect(((await run.respondWith.mock.calls[0]![0]) as Response).status).toBe(403);
  });

  it('serves declared package files to the authorized inner frame', async () => {
    const run = harness();
    run.fetch(`${PACKAGE_URL}monitor/panel.css`);
    const response = (await run.respondWith.mock.calls[0]![0]) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await response.text()).toBe('body{}');
    expect(run.read).toHaveBeenCalledWith('monitor/panel.css');
  });

  it('refuses undeclared files and the reserved root itself even when authorized', async () => {
    const run = harness();
    run.fetch(`${PACKAGE_URL}monitor/missing.js`);
    expect(((await run.respondWith.mock.calls[0]![0]) as Response).status).toBe(404);
    run.respondWith.mockClear();
    run.fetch(PACKAGE_URL.slice(0, -1));
    expect(((await run.respondWith.mock.calls[0]![0]) as Response).status).toBe(403);
  });

  it('keeps the bootstrap files and unrelated assets on the network', () => {
    const run = harness();
    for (const url of [
      `${SCOPE}content.html?view=${'a'.repeat(32)}`,
      `${SCOPE}content.js`,
      `${SCOPE}environment.js`,
      `${ORIGIN}/@vite/client`,
      `${ORIGIN}/workbench.html`,
    ])
      run.fetch(url);
    expect(run.respondWith).not.toHaveBeenCalled();
    expect(run.read).not.toHaveBeenCalled();
  });

  it('lets another origin through even under the reserved path spelling', () => {
    const run = harness();
    run.fetch(`https://other.example.com/__mica_package__/monitor/panel.css`);
    expect(run.respondWith).not.toHaveBeenCalled();
  });
});
