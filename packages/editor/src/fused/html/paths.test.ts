import { describe, expect, it } from 'vitest';
import {
  ASSET_ROOT_DIRECTORY,
  HTML_VIEW_CONTENT_POLICY,
  HTML_VIEW_ENVIRONMENT_POLICY,
  assetRootUrl,
  authorBaseUrl,
  concreteOriginOf,
  decodeDocument,
  imageBuffer,
  mimeTypeOf,
  resolveAssetRequest,
  withHtmlDocumentPreamble,
} from './paths';

const ROOT = '/public/0123456789abcdef/__mica_view__/__mica_package__/';

describe('asset root and author base', () => {
  it('places the package mirror under the environment directory', () => {
    const base = new URL(
      'https://mica-0123.cdn.example.com/public/0123456789abcdef/__mica_view__/',
    );
    expect(assetRootUrl(base).href).toBe(
      'https://mica-0123.cdn.example.com/public/0123456789abcdef/__mica_view__/__mica_package__/',
    );
    expect(ASSET_ROOT_DIRECTORY).toBe('__mica_package__/');
  });

  it('resolves the author document against the directory of its entry', () => {
    const root = new URL(`https://mica-0123.cdn.example.com${ROOT}`);
    expect(authorBaseUrl(root, 'views/serial/index.html')).toBe(
      `https://mica-0123.cdn.example.com${ROOT}views/serial/`,
    );
    expect(authorBaseUrl(root, 'views/serial/registers.html')).toBe(
      `https://mica-0123.cdn.example.com${ROOT}views/serial/`,
    );
    expect(authorBaseUrl(root, 'index.html')).toBe(`https://mica-0123.cdn.example.com${ROOT}`);
  });
});

describe('resolveAssetRequest', () => {
  it('maps one request under the asset root to a package path', () => {
    expect(resolveAssetRequest(`${ROOT}views/serial/main.js`, ROOT)).toBe('views/serial/main.js');
    expect(resolveAssetRequest(`${ROOT}a/b/style.css`, ROOT)).toBe('a/b/style.css');
    expect(resolveAssetRequest(`${ROOT}views%20dir/x.js`, ROOT)).toBe('views dir/x.js');
  });

  it('rejects everything that leaves the package', () => {
    expect(resolveAssetRequest(`${ROOT}`, ROOT)).toBeUndefined();
    expect(resolveAssetRequest('/public/__mica_view__/environment.js', ROOT)).toBeUndefined();
    expect(resolveAssetRequest(`${ROOT}../escape.js`, ROOT)).toBeUndefined();
    expect(resolveAssetRequest(`${ROOT}%2e%2e/escape.js`, ROOT)).toBeUndefined();
    expect(resolveAssetRequest(`${ROOT}views%2Fserial/main.js`, ROOT)).toBeUndefined();
    expect(resolveAssetRequest(`${ROOT}views%5Cserial/main.js`, ROOT)).toBeUndefined();
    expect(resolveAssetRequest(`${ROOT}a//b.js`, ROOT)).toBeUndefined();
    expect(resolveAssetRequest(`${ROOT}a/%zz.js`, ROOT)).toBeUndefined();
    expect(resolveAssetRequest(`${ROOT}/absolute.js`, ROOT)).toBeUndefined();
  });
});

describe('mimeTypeOf', () => {
  it('names the content type of every declared kind', () => {
    expect(mimeTypeOf('views/serial/index.html')).toBe('text/html; charset=utf-8');
    expect(mimeTypeOf('main.mjs')).toBe('text/javascript; charset=utf-8');
    expect(mimeTypeOf('style.CSS')).toBe('text/css; charset=utf-8');
    expect(mimeTypeOf('data.json')).toBe('application/json; charset=utf-8');
    expect(mimeTypeOf('board.webp')).toBe('image/webp');
    expect(mimeTypeOf('font.woff2')).toBe('font/woff2');
    expect(mimeTypeOf('model.wasm')).toBe('application/wasm');
    expect(mimeTypeOf('LICENSE')).toBe('application/octet-stream');
    expect(mimeTypeOf('unknown.zzz')).toBe('application/octet-stream');
  });
});

describe('withHtmlDocumentPreamble', () => {
  const preamble = {
    base: 'https://cdn.example.com/pkg/views/serial/',
    policy: "default-src 'none'",
    style: ':root{--mica-bg:#1c1c1c;color-scheme:dark}',
  };

  it('injects the base, the policy and the theme before the author markup', () => {
    const html = withHtmlDocumentPreamble(
      '<!doctype html><html><head><title>Serial</title></head><body></body></html>',
      preamble,
    );
    expect(html).toContain('<head><meta charset="utf-8">');
    expect(html).toContain('<base href="https://cdn.example.com/pkg/views/serial/">');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('content="default-src');
    expect(html).toContain('<style>:root{--mica-bg:#1c1c1c;color-scheme:dark}</style>');
    expect(html.indexOf('<base')).toBeLessThan(html.indexOf('<title>'));
    // The theme must exist before any author script runs, or the first paint has no tokens.
    expect(html.indexOf('color-scheme:dark')).toBeLessThan(html.indexOf('<title>'));
  });

  it('adds a head when the document has none', () => {
    expect(withHtmlDocumentPreamble('<html lang="zh"><body></body></html>', preamble)).toContain(
      '<html lang="zh"><head><meta charset="utf-8">',
    );
    expect(withHtmlDocumentPreamble('<!doctype html><p>hi</p>', preamble)).toContain(
      '<!doctype html><head><meta charset="utf-8">',
    );
    expect(withHtmlDocumentPreamble('<p>hi</p>', preamble)).toContain(
      '<head><meta charset="utf-8"><meta http-equiv',
    );
  });

  it('escapes the injected attribute values and never closes the style element early', () => {
    const html = withHtmlDocumentPreamble('<head></head>', {
      base: 'https://cdn.example.com/?a="b"&c=<d>',
      policy: "script-src 'self'",
      style: 'body{background:url(</style><script>alert(1)</script>)}',
    });
    expect(html).toContain('href="https://cdn.example.com/?a=&quot;b&quot;&amp;c=&lt;d>"');
    expect(html).toContain('content="script-src');
    expect(html).not.toContain('</style><script>');
    expect(html).toContain('<\\/style>');
  });
});

describe('content policies', () => {
  it('keeps the author policy stricter than the environment policy', () => {
    expect(HTML_VIEW_ENVIRONMENT_POLICY).toContain("frame-src 'self'");
    expect(HTML_VIEW_CONTENT_POLICY).toContain("frame-src 'none'");
    expect(HTML_VIEW_ENVIRONMENT_POLICY).not.toContain("frame-src 'none'");
    // Neither policy may reach a network origin other than the environment itself.
    for (const policy of [HTML_VIEW_CONTENT_POLICY, HTML_VIEW_ENVIRONMENT_POLICY]) {
      expect(policy).not.toContain('http:');
      expect(policy).not.toContain('https:');
      expect(policy).toContain("default-src 'none'");
    }
  });
});
describe('concreteOriginOf', () => {
  it('keeps a concrete HTTP(S) origin and rejects opaque documents', () => {
    expect(concreteOriginOf('https://mica-1.example.com/p/__mica_view__/index.html')).toBe(
      'https://mica-1.example.com',
    );
    expect(concreteOriginOf('http://mica-1.localhost:5193/x/')).toBe(
      'http://mica-1.localhost:5193',
    );
    expect(concreteOriginOf('about:srcdoc')).toBeUndefined();
    expect(concreteOriginOf('null')).toBeUndefined();
    expect(concreteOriginOf('')).toBeUndefined();
    expect(concreteOriginOf(undefined)).toBeUndefined();
  });

  it('rejects the location of an opaque frame instead of matching a wildcard', () => {
    expect(concreteOriginOf('about:blank')).toBeUndefined();
    expect(concreteOriginOf('data:text/html,<p>x</p>')).toBeUndefined();
    expect(concreteOriginOf('blob:https://mica-1.example.com/0000')).toBeUndefined();
    // Two frames of one environment always share this concrete origin.
    expect(concreteOriginOf(`${'https://mica-1.example.com'}/p/__mica_view__/content.html`)).toBe(
      'https://mica-1.example.com',
    );
  });
});

describe('byte helpers', () => {
  it('decodes a document and strips its byte order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x70, 0x3e]);
    expect(decodeDocument(bytes)).toBe('<p>');
  });

  it('copies bytes into a plain array buffer', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = imageBuffer(bytes);
    expect(buffer.byteLength).toBe(3);
    expect(new Uint8Array(buffer)).toEqual(bytes);
  });
});
