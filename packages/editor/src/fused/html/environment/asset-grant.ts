/**
 * Authorization state of one package asset worker (RFC 0023).
 *
 * The worker serves exactly one environment: the page that granted it and the one inner frame that
 * presented the grant token. Every other client of the same origin is refused, so an environment can
 * never read the package of another view even when both are served from the same deployment.
 * Navigations, other origins and undeclared files are rejected by {@link respondToAsset}; this module
 * only decides *who* may ask.
 */

/**
 * Identity of one service worker client, as much as the worker needs.
 *
 * `url` is reported for diagnostics only. Both frames of an environment are real documents of the
 * same origin, but a URL alone is never authorization: the client id and the grant token decide,
 * and the token reaches the inner frame only through the trusted bridge.
 */
export interface IAssetClientIdentity {
  readonly id?: string | undefined;
  readonly frameType?: string | undefined;
  readonly url?: string | undefined;
}

/** Package scope granted to one environment. */
export interface IAssetGrant {
  readonly token: string;
  /** URL pathname of the package mirror this worker serves. */
  readonly root: string;
  /** Environment page that installed the grant. */
  readonly parentClientId: string;
  /** Inner frame that presented the grant token, if it already attached. */
  readonly childClientId: string | undefined;
}

interface IMutableGrant {
  readonly token: string;
  readonly root: string;
  readonly parentClientId: string;
  childClientId: string | undefined;
}

/** Tokens are unguessable capabilities; a short value is a caller bug, not a grant. */
const MIN_TOKEN_LENGTH = 16;

/** Window frame types a client of this deployment directory may report. */
const NESTED_FRAME_TYPES: ReadonlySet<string> = new Set(['nested']);

/** Authorization of the clients of one environment. */
export class AssetGrantRegistry {
  readonly #scope: string;
  readonly #origin: string;
  #grant: IMutableGrant | undefined;

  /** @param scope Absolute URL of the worker scope, normally `registration.scope`. */
  constructor(scope: string) {
    this.#scope = scopePath(scope);
    this.#origin = new URL(scope).origin;
  }

  /** Deployment directory this worker belongs to; every grant must stay inside it. */
  get scope(): string {
    return this.#scope;
  }

  /** The active grant, if any. */
  get active(): IAssetGrant | undefined {
    return this.#grant === undefined ? undefined : snapshot(this.#grant);
  }

  /**
   * Installs the grant of one environment page, replacing any previous grant.
   *
   * @returns the installed grant, or `undefined` when the message, the package root or the client
   * cannot own a grant; the worker then stays without a package channel.
   */
  grant(
    message: unknown,
    client: IAssetClientIdentity | null | undefined,
  ): IAssetGrant | undefined {
    const token = readToken(message);
    const root = readRoot(message);
    const clientId = readClientId(client);
    if (token === undefined || root === undefined || clientId === undefined) return undefined;
    // A grant may only cover a directory of its own deployment, never the worker script itself.
    if (!insideScope(root, this.#scope)) return undefined;
    if (!this.#admits(client)) return undefined;
    this.#grant = { token, root, parentClientId: clientId, childClientId: undefined };
    return snapshot(this.#grant);
  }

  /**
   * Authorizes the inner frame that presented the grant token.
   *
   * Only the token decides: it reaches the frame over the trusted bridge and never appears in the
   * author document, so a client of this origin that cannot present it keeps no access.
   */
  attach(
    message: unknown,
    client: IAssetClientIdentity | null | undefined,
  ): IAssetGrant | undefined {
    const grant = this.#grant;
    if (grant === undefined) return undefined;
    const token = readToken(message);
    const clientId = readClientId(client);
    if (token === undefined || token !== grant.token || clientId === undefined) return undefined;
    // The inner document of an environment is a frame of this deployment directory. Chrome reports
    // `nested` for every iframe client, so that is the value a real attach carries; a top-level
    // page of the origin, an auxiliary window or a non-window client is never the inner document.
    if (!isNestedFrame(client)) return undefined;
    if (!this.#admits(client)) return undefined;
    if (clientId !== grant.parentClientId) grant.childClientId = clientId;
    return snapshot(grant);
  }

  /**
   * Correlates one client with this deployment directory.
   *
   * Both frames of an environment are served from the worker scope, so a client URL that leaves the
   * scope (or carries another origin) is not part of this environment even with a valid token. A
   * browser that reports no URL for the client leaves the token as the only authority.
   */
  #admits(client: IAssetClientIdentity | null | undefined): boolean {
    const url = client?.url;
    if (url === undefined || url === '') return true;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return parsed.origin === this.#origin && insideScope(parsed.pathname, this.#scope);
  }

  /** Package root one client may read, or `undefined` when the client is not authorized. */
  serves(clientId: string | undefined): string | undefined {
    const grant = this.#grant;
    if (grant === undefined) return undefined;
    const id = readClientId({ id: clientId });
    if (id === undefined) return undefined;
    return id === grant.parentClientId || id === grant.childClientId ? grant.root : undefined;
  }

  /** Releases the active grant; a reloaded environment page installs a fresh one. */
  clear(): void {
    this.#grant = undefined;
  }
}

function snapshot(grant: IMutableGrant): IAssetGrant {
  return Object.freeze({
    token: grant.token,
    root: grant.root,
    parentClientId: grant.parentClientId,
    childClientId: grant.childClientId,
  });
}

function readToken(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const token = (message as { readonly token?: unknown }).token;
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) return undefined;
  return token;
}

function readRoot(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const root = (message as { readonly root?: unknown }).root;
  if (typeof root !== 'string' || !root.endsWith('/')) return undefined;
  if (!root.startsWith('/') || root.includes('\\') || root.includes('?') || root.includes('#'))
    return undefined;
  if (root.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return root;
}

/** Whether a client identity belongs to a document nested in another frame. */
function isNestedFrame(client: IAssetClientIdentity | null | undefined): boolean {
  const frameType = client?.frameType;
  return frameType === undefined || NESTED_FRAME_TYPES.has(frameType);
}

function readClientId(client: IAssetClientIdentity | null | undefined): string | undefined {
  const id = client?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function scopePath(scope: string): string {
  const url = new URL(scope);
  const path = url.pathname;
  return path.endsWith('/') ? path : `${path}/`;
}

/** Whether `root` is served by the worker whose deployment directory is `scope`. */
export function insideScope(root: string, scope: string): boolean {
  const directory = scope.endsWith('/') ? scope : `${scope}/`;
  return root !== directory && root.startsWith(directory);
}
