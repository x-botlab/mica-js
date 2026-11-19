/**
 * Resource mapping of one device HTML environment (RFC 0023).
 *
 * The environment is served from a deployment directory of its own origin, so relative HTML, CSS
 * and ES module references must resolve *inside the package*. Every package file therefore lives
 * under one asset root whose path mirrors the package root; the author document gets a `<base>`
 * pointing at its own package directory. The environment's service worker turns those requests into
 * verified package reads and refuses everything else, including page navigations.
 *
 * The trusted environment document creates one inner sandboxed frame from
 * {@link ENVIRONMENT_CONTENT_DOCUMENT_FILE}; both are real documents of the same per-view origin,
 * which no editor page shares, and the environment writes the author document into the inner
 * document itself.
 */
import { packagePathProblem } from '@mica-js/document/fused';

/** Directory under the environment base URL that serves the package files. */
export const ASSET_ROOT_DIRECTORY = '__mica_package__/';

/** Bootstrap document the editor loads in the environment iframe. */
export const ENVIRONMENT_DOCUMENT_FILE = 'index.html';

/** Bundled bootstrap module loaded by {@link ENVIRONMENT_DOCUMENT_FILE}. */
export const ENVIRONMENT_BOOTSTRAP_FILE = 'environment.js';

/** Document the environment loads in the inner sandbox frame; a real same-origin URL. */
export const ENVIRONMENT_CONTENT_DOCUMENT_FILE = 'content.html';

/** Bundled bootstrap module {@link ENVIRONMENT_CONTENT_DOCUMENT_FILE} loads. */
export const ENVIRONMENT_CONTENT_FILE = 'content.js';

/** Bundled service worker that serves the package files of one environment. */
export const ENVIRONMENT_WORKER_FILE = 'environment-sw.js';

/**
 * Content security policy of the author document and of the inner content document.
 *
 * Package scripts, styles, fonts and images are same-origin because the asset worker serves them;
 * opaque `blob:` URLs are the `assets.getUrl` results of the view itself. Nothing else is reachable:
 * the author page has no network, no frames and no form targets. The inner document is served with
 * this policy so an author document can never nest another frame, whatever the trusted environment
 * allows itself.
 */
export const HTML_VIEW_CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ');

/**
 * Policy of the trusted environment document.
 *
 * It only differs from the author policy where the environment itself needs more: exactly one inner
 * frame of its own deployment directory, and the asset worker registration. The inner document is
 * served with {@link HTML_VIEW_CONTENT_POLICY}, so the author document still cannot nest frames,
 * reach another origin or post a form.
 */
export const HTML_VIEW_ENVIRONMENT_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' blob:",
  "worker-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ');

/** Absolute URL prefix that serves the verified package files of one environment. */
export function assetRootUrl(baseUrl: URL): URL {
  return new URL(ASSET_ROOT_DIRECTORY, baseUrl);
}

/**
 * Base URL the author document resolves relative references against.
 *
 * The asset root mirrors the package root, so the document base is the directory of the view entry
 * and `./main.js` of `views/serial/index.html` resolves to the package file `views/serial/main.js`.
 */
export function authorBaseUrl(assetRoot: URL, entry: string): string {
  const root = assetRoot.href.endsWith('/') ? assetRoot.href : `${assetRoot.href}/`;
  const separator = entry.lastIndexOf('/');
  return separator <= 0 ? root : `${root}${entry.slice(0, separator + 1)}`;
}

/**
 * Package path of one asset request, or `undefined` when the request leaves the package.
 *
 * `root` is the pathname of {@link assetRootUrl}; requests outside it, encoded separators and empty
 * segments are rejected, so a view cannot read the environment bootstrap or another package.
 */
export function resolveAssetRequest(pathname: string, root: string): string | undefined {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0) return undefined;
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (decoded.length === 0 || decoded === '.' || decoded === '..') return undefined;
    if (decoded.includes('/') || decoded.includes('\\')) return undefined;
    segments.push(decoded);
  }
  const path = segments.join('/');
  return packagePathProblem(path) === undefined ? path : undefined;
}

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  bin: 'application/octet-stream',
});

/** Response content type of one package file. */
export function mimeTypeOf(path: string): string {
  const separator = path.lastIndexOf('.');
  if (separator <= 0) return 'application/octet-stream';
  return MIME_TYPES[path.slice(separator + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** Preamble injected into the author document before any of its own markup. */
export interface IHtmlDocumentPreamble {
  /** Absolute base URL the author document resolves relative references against. */
  readonly base: string;
  /** Content security policy of the author document. */
  readonly policy: string;
  /** Theme declarations of the environment, applied before any author script runs. */
  readonly style: string;
}

/**
 * Injects the document preamble of one view.
 *
 * The `<base>` must be the first base element, the policy travels with the document because it is
 * written into a document of its own, and the theme declarations come before every author script so
 * the author never paints a frame with missing tokens.
 */
export function withHtmlDocumentPreamble(html: string, preamble: IHtmlDocumentPreamble): string {
  const markup = [
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(preamble.policy)}">`,
    `<base href="${escapeAttribute(preamble.base)}">`,
    `<style>${preamble.style.replace(/<\/style/gi, '<\\/style')}</style>`,
  ].join('');
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${markup}${html.slice(at)}`;
  }
  const open = /<html\b[^>]*>/i.exec(html);
  if (open !== null) {
    const at = open.index + open[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype !== null) {
    const at = doctype.index + doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<head>${markup}</head>${html}`;
}

/** Concrete HTTP(S) origin; used to reject an opaque or malformed frame location. */
const FRAME_ORIGIN = /^https?:\/\/[^/]+$/;

/**
 * Concrete HTTP(S) origin of a URL, or `undefined` when the document has no comparable origin.
 *
 * Both frames of an environment are real documents of the deployment directory, so their origins
 * are concrete; this guard keeps a stray `about:`, `blob:` or `data:` location from ever being
 * compared as if it were the environment.
 */
export function concreteOriginOf(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return FRAME_ORIGIN.test(parsed.origin) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Owns a plain `ArrayBuffer` copy of one byte snapshot.
 *
 * `Blob`, `Response` and the transfer list reject a `SharedArrayBuffer`-backed view, so every byte
 * snapshot that leaves this module is copied first.
 */
export function imageBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Decodes package bytes as UTF-8 text, tolerating a byte order mark. */
export function decodeDocument(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
}

/** Escapes one attribute value; policy, base and token never reach the document unescaped. */
export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
