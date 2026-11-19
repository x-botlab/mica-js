import { describe, expect, it } from 'vitest';
import { respondToAsset } from './asset-response';

const ORIGIN = 'https://mica-1.cdn.example.com';
const ROOT = '/p/__mica_view__/__mica_package__/';

function assets(files: Readonly<Record<string, string>>) {
  const reads: string[] = [];
  return {
    reads,
    context: {
      origin: ORIGIN,
      root: ROOT,
      assets: {
        async read(path: string): Promise<Uint8Array> {
          reads.push(path);
          const content = files[path];
          if (content === undefined) throw new Error(`missing ${path}`);
          return new TextEncoder().encode(content);
        },
      },
    },
  };
}

describe('respondToAsset', () => {
  it('serves a package file with its content type', async () => {
    const host = assets({ 'views/serial/main.js': 'export const ready = true;' });
    const response = await respondToAsset(
      new Request(`${ORIGIN}${ROOT}views/serial/main.js`),
      host.context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('export const ready = true;');
    expect(host.reads).toEqual(['views/serial/main.js']);
  });

  it('answers an unreadable file with 404 instead of a network fallback', async () => {
    const host = assets({});
    const response = await respondToAsset(
      new Request(`${ORIGIN}${ROOT}views/serial/missing.js`),
      host.context,
    );
    expect(response.status).toBe(404);
  });

  it('serves nothing outside the package root', async () => {
    const host = assets({ 'environment.js': 'console.log(1)' });
    for (const path of ['/p/__mica_view__/environment.js', `${ROOT}../escape.js`, `${ROOT}`]) {
      const response = await respondToAsset(new Request(`${ORIGIN}${path}`), host.context);
      expect(response.status).toBe(404);
    }
    expect(host.reads).toEqual([]);
  });

  it('refuses to navigate the environment page', async () => {
    const host = assets({ 'views/serial/index.html': '<p>next</p>' });
    const navigation = await respondToAsset(
      requestWithDestination(`${ORIGIN}${ROOT}views/serial/index.html`, 'document'),
      host.context,
    );
    expect(navigation.status).toBe(403);
    expect(await navigation.text()).toContain('navigation is not allowed');
    expect(host.reads).toEqual([]);
  });

  it('reaches no other origin', async () => {
    const host = assets({ 'views/serial/main.js': 'x' });
    const response = await respondToAsset(
      new Request(`https://elsewhere.example.com${ROOT}views/serial/main.js`),
      host.context,
    );
    expect(response.status).toBe(404);
    expect(host.reads).toEqual([]);
  });

  it('rejects every method except GET and HEAD', async () => {
    const host = assets({ 'views/serial/main.js': 'x' });
    const response = await respondToAsset(
      new Request(`${ORIGIN}${ROOT}views/serial/main.js`, { method: 'POST' }),
      host.context,
    );
    expect(response.status).toBe(405);
  });

  it('answers HEAD without a body', async () => {
    const host = assets({ 'views/serial/main.js': 'export const ready = true;' });
    const response = await respondToAsset(
      new Request(`${ORIGIN}${ROOT}views/serial/main.js`, { method: 'HEAD' }),
      host.context,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
});

function requestWithDestination(url: string, destination: RequestDestination): Request {
  const request = new Request(url);
  Object.defineProperty(request, 'destination', { value: destination });
  return request;
}
