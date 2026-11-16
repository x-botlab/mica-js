/**
 * Routing of one package asset worker fetch event (RFC 0023).
 *
 * Kept apart from the worker entry so the decision is testable against a real `Request`: only the
 * reserved package directory of the deployment belongs to this worker. Requests there are answered
 * by the verified package lane of an authorized client, or refused with an explicit `403` when no
 * environment authorized the client. Everything else — the bootstrap documents, the worker itself
 * and unrelated application assets — falls through to the network untouched.
 */
import { resolveAssetRequest } from '../paths';
import { denyPackageRequest, isReservedPackagePath, respondToAsset } from './asset-response';
import type { IAssetBytes } from './asset-response';

/** The part of a worker `FetchEvent` the routing needs. */
export interface IPackageFetchEvent {
  readonly request: Request;
  /** Client that made the request; `''` for a request without a client. */
  readonly clientId: string;
  respondWith(response: Response | Promise<Response>): void;
}

/** Everything one package request is judged against. */
export interface IPackageFetchContext {
  /** Origin the environment is served from; nothing else is reachable. */
  readonly origin: string;
  /** Reserved package directory of this deployment, normally `<scope>__mica_package__/`. */
  readonly packagePrefix: string;
  /** Package root the client is authorized for; `undefined` when no environment granted it. */
  readonly authorizedRoot: (clientId: string) => string | undefined;
  /** Verified package lane of the installed grant, if any. */
  readonly assets: IAssetBytes | undefined;
}

/** Answers one fetch event of the package worker, or leaves it to the network. */
export function servePackageRequest(
  event: IPackageFetchEvent,
  context: IPackageFetchContext,
): void {
  let url: URL;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }
  if (url.origin !== context.origin) return;
  if (!isReservedPackagePath(url.pathname, context.packagePrefix)) return;
  const root = context.authorizedRoot(event.clientId);
  const assets = context.assets;
  if (root === undefined || assets === undefined) {
    // Never the network: the deployment shell would answer a package path with the application.
    event.respondWith(denyPackageRequest());
    return;
  }
  if (resolveAssetRequest(url.pathname, root) === undefined) {
    event.respondWith(denyPackageRequest());
    return;
  }
  event.respondWith(respondToAsset(event.request, { origin: context.origin, root, assets }));
}
