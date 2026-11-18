/**
 * Package asset worker of the device HTML view environments (RFC 0023), bundled as
 * `environment-sw.js` and served from the environment deployment directory.
 *
 * The editor owns the verified package reads, so this worker never touches the environment page
 * after its grant: it receives the dedicated package port of the editor together with the grant and
 * answers every request under the environment's asset root with file bytes from there. Only two
 * clients are served: the page that installed the grant and the one inner frame that attached with
 * the grant token. Every request under the reserved package directory is answered by this worker —
 * served from the verified package, or refused with an explicit `403` when the client was not
 * authorized — so a package path never reaches the network. Everything else (the bootstrap files
 * and unrelated application assets) falls through untouched. A closed lane leaves no channel behind:
 * every later package request of this worker is refused instead of retried.
 */
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint, RpcProxy } from '@mica-js/core/rpc';
import {
  HTML_VIEW_ASSETS,
  HTML_VIEW_ASSETS_ACK,
  HTML_VIEW_ATTACH,
  HTML_VIEW_ATTACH_ACK,
  fusedHtmlAssetService,
} from '../protocol';
import type { IHtmlViewAssetAckMessage } from '../protocol';
import type { IFusedHtmlAssetService } from '../protocol';
import { ASSET_ROOT_DIRECTORY } from '../paths';
import { AssetGrantRegistry } from './asset-grant';
import type { IAssetClientIdentity } from './asset-grant';
import { servePackageRequest } from './package-fetch';

interface IWorkerMessageEvent {
  readonly data: unknown;
  readonly ports: readonly MessagePort[];
  /** Client that posted the message; its id binds every request this worker answers. */
  readonly source: IAssetClientIdentity | null;
}

interface IWorkerFetchEvent {
  readonly request: Request;
  /** Client that made the request; a grant only answers the clients it authorized. */
  readonly clientId: string;
  respondWith(response: Response | Promise<Response>): void;
}

interface IWorkerExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

/** Minimal shape of the service worker global scope; the DOM lib has no worker declarations. */
interface IWorkerScope {
  addEventListener(type: 'install', listener: () => void): void;
  addEventListener(type: 'activate', listener: (event: IWorkerExtendableEvent) => void): void;
  addEventListener(type: 'message', listener: (event: IWorkerMessageEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: IWorkerFetchEvent) => void): void;
  skipWaiting?(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  readonly location: { readonly origin: string };
  readonly registration: { readonly scope: string };
}

interface IAssetChannel {
  readonly endpoint: RpcEndpoint;
  readonly assets: RpcProxy<IFusedHtmlAssetService>;
}

const scope = globalThis as unknown as IWorkerScope;
const grants = new AssetGrantRegistry(scope.registration.scope);
/** Reserved package directory of this deployment; nothing under it is ever fetched from the network. */
const packagePrefix = new URL(ASSET_ROOT_DIRECTORY, scope.registration.scope).pathname;
let channel: IAssetChannel | undefined;

scope.addEventListener('install', () => {
  void scope.skipWaiting?.();
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(scope.clients.claim());
});

scope.addEventListener('message', (event) => {
  const data = event.data as { readonly type?: unknown } | null;
  if (data === null || typeof data !== 'object') return;
  if (data.type === HTML_VIEW_ASSETS) acceptGrant(event);
  else if (data.type === HTML_VIEW_ATTACH) acceptAttach(event);
});

/**
 * Installs the package lane of one environment page and acknowledges the grant.
 *
 * `ports[0]` is the editor's package lane and `ports[1]` only carries the acknowledgement back, so a
 * page that installs no grant gets no answer and the environment fails explicitly. The inner frame
 * is created only after that answer, so the grant is in place before any author resource fetch.
 */
function acceptGrant(event: IWorkerMessageEvent): void {
  const port = event.ports[0];
  if (port === undefined) return;
  const grant = grants.grant(event.data, event.source);
  if (grant === undefined) return;
  channel?.endpoint.dispose();
  const endpoint = createRpc(port);
  const installed: IAssetChannel = { endpoint, assets: endpoint.getProxy(fusedHtmlAssetService) };
  // A lane the editor released leaves no proxy behind: the worker answers the next request of this
  // grant with an explicit `403` instead of an RPC that can never settle.
  endpoint.onDidClose(() => {
    if (channel === installed) channel = undefined;
  });
  channel = installed;
  const ack: IHtmlViewAssetAckMessage = { type: HTML_VIEW_ASSETS_ACK, token: grant.token };
  event.ports[1]?.postMessage(ack);
}

/** Authorizes the inner frame of one environment and answers through its private port. */
function acceptAttach(event: IWorkerMessageEvent): void {
  const grant = grants.attach(event.data, event.source);
  if (grant === undefined) return;
  event.ports[0]?.postMessage({ type: HTML_VIEW_ATTACH_ACK, token: grant.token });
}

scope.addEventListener('fetch', (event) => {
  servePackageRequest(event, {
    origin: scope.location.origin,
    packagePrefix,
    authorizedRoot: (clientId) => grants.serves(clientId),
    assets: channel?.assets,
  });
});
