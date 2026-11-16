/**
 * Response building of the package asset worker (RFC 0023).
 *
 * Kept apart from the worker entry so the routing rules are testable in Node. A controlled
 * environment page may only read its own package: page navigations are refused, another origin is
 * unreachable (the policy also pins the origin), and every unreadable file answers `404` instead of
 * a network fallback.
 */
import { imageBuffer, mimeTypeOf, resolveAssetRequest } from '../paths';

/** Package bytes of one environment; the worker's RPC proxy satisfies it. */
export interface IAssetBytes {
  read(path: string): Promise<Uint8Array>;
}

/** Everything one asset request is judged against. */
export interface IAssetRequestContext {
  /** Origin the environment is served from; nothing else is reachable. */
  readonly origin: string;
  /** URL pathname of the package asset root. */
  readonly root: string;
  readonly assets: IAssetBytes;
}

/** Answers one request of a granted environment page. */
export async function respondToAsset(
  request: Request,
  context: IAssetRequestContext,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return text('Unreadable asset request.', 400);
  }
  if (request.destination === 'document') {
    // The author document is written into the environment page, so a navigation is always a view
    // leaving its granted document (RFC 0023). Refuse it before any bytes are served.
    return text('Device view navigation is not allowed.', 403);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  if (url.origin !== context.origin) {
    return text('Device views reach no other origin.', 404);
  }
  const path = resolveAssetRequest(url.pathname, context.root);
  if (path === undefined) {
    return text('Package file unavailable.', 404);
  }
  try {
    const bytes = await context.assets.read(path);
    return new Response(request.method === 'HEAD' ? null : imageBuffer(bytes), {
      status: 200,
      headers: {
        'content-type': mimeTypeOf(path),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return text('Package file unavailable.', 404);
  }
}

/**
 * Explicit refusal of one request under the reserved package directory.
 *
 * A client that no environment authorized must never reach the network for a package path: the
 * deployment shell would answer `200` with the application page, which looks like a successful
 * read. The answer is a plain `403` instead, whatever the client tried to fetch.
 */
export function denyPackageRequest(): Response {
  return text('Package files are reserved for the authorized device view.', 403);
}

/**
 * Whether one request path belongs to the reserved package directory of a deployment.
 *
 * Independent of any grant: the directory name is reserved for the package mirror, so both an
 * authorized and an unauthorized client are answered by the worker instead of the network.
 */
export function isReservedPackagePath(pathname: string, prefix: string): boolean {
  const directory = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // An undecodable path keeps its raw form; the file lookup rejects it.
  }
  return decoded === directory || decoded.startsWith(`${directory}/`);
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
