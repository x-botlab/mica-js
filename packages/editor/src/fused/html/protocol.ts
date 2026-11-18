/**
 * Wire contracts of the device HTML view bridge (RFC 0023).
 *
 * One environment per `(instanceId, viewId)`: a trusted OUTER frame on a deployment directory of its
 * own origin and one INNER sandboxed frame inside it. Both are real documents of that origin
 * (`index.html` and `content.html`), so every origin of both frames is concrete and comparable.
 * The outer owns the author document: it writes it into the inner document once the inner bootstrap
 * announced that the API and the package grant are in place. Three `MessagePort` lanes cross that
 * boundary, and only the control lane ever reaches the outer frame:
 *
 * | Lane    | Peers       | Carries                                                          |
 * | ------- | ----------- | ---------------------------------------------------------------- |
 * | control | host, outer | loading, theme, errors, and the two port grants                  |
 * | author  | host, inner | model methods and events, props, assets, close, view identity    |
 * | package | host, SW    | verified package bytes of one asset request                      |
 *
 * The outer never proxies a package read or a model call: it receives the two dedicated ports over
 * the control lane and hands them straight to the worker and to the sandboxed frame. Author code
 * never receives a model implementation, the editor DOM, a `MessagePort` or any host proxy.
 */
import { defineRpcService } from '@mica-js/core/rpc';
import type { Value } from '@mica-js/document/fused';
import type { ModelEvent } from '@mica-js/sdk/fused';
import type { WorkbenchThemeColors } from '../theme';
import type { FusedPresentationProps } from '../runtime/protocol';

/** Diagnostic codes the HTML view contract reports (RFC 0023 "校验"). */
export type HtmlViewDiagnosticCode =
  | 'view/invalid-base-url-template'
  | 'view/unknown-entry'
  | 'view/unavailable-mode'
  | 'view/load-failed'
  | 'view/bridge-failed'
  | 'view/execution-failed';

/** Failure of one HTML view; the container shows device, title and reason. */
export interface IHtmlViewFailure {
  readonly code: HtmlViewDiagnosticCode;
  readonly message: string;
  readonly instanceId: string;
  readonly viewId: string;
  readonly title: string;
  readonly device: string;
}

/** Local contract failure of the HTML view host or of one environment. */
export class HtmlViewError extends Error {
  readonly code: HtmlViewDiagnosticCode;
  readonly instanceId: string | undefined;
  readonly viewId: string | undefined;

  constructor(
    code: HtmlViewDiagnosticCode,
    message: string,
    options: { readonly instanceId?: string; readonly viewId?: string } = {},
  ) {
    super(message);
    this.name = 'HtmlViewError';
    this.code = code;
    this.instanceId = options.instanceId;
    this.viewId = options.viewId;
  }
}

export function isHtmlViewError(value: unknown): value is HtmlViewError {
  return value instanceof HtmlViewError;
}

/** Control message the editor posts into a freshly loaded environment. */
export const HTML_VIEW_CONNECT = 'mica:view:connect';

/** Acknowledgement the environment posts back once it owns the transferred port. */
export const HTML_VIEW_ACK = 'mica:view:ack';

/** Control message that grants the environment's asset worker its package channel. */
export const HTML_VIEW_ASSETS = 'mica:view:assets';

/** Acknowledgement of {@link HTML_VIEW_ASSETS}: the worker owns the package port. */
export const HTML_VIEW_ASSETS_ACK = 'mica:view:assets-ack';

/** Control message the inner frame posts into the asset worker to authorize its own requests. */
export const HTML_VIEW_ATTACH = 'mica:view:attach';

/** Acknowledgement of {@link HTML_VIEW_ATTACH}; only then may the author document load. */
export const HTML_VIEW_ATTACH_ACK = 'mica:view:attach-ack';

/** Control message the inner frame posts to the environment once its bootstrap runs. */
export const HTML_VIEW_CHILD_HELLO = 'mica:view:child-hello';

/** Control message the environment answers with the bridge port of the inner frame. */
export const HTML_VIEW_CHILD_CONNECT = 'mica:view:child-connect';

/** Control message the inner frame posts once its API and its package grant are in place. */
export const HTML_VIEW_CHILD_PREPARED = 'mica:view:child-prepared';

/**
 * Query parameter that carries the one-time token of one inner frame.
 *
 * The inner document is a real same-origin URL, so both frames derive the environment origin from
 * their own location; only the frame token travels in the URL, and it never grants host access.
 */
export const HTML_VIEW_FRAME_PARAM = 'view';

/** Resolved workbench theme one environment mirrors into its author document. */
export interface IHtmlViewTheme {
  readonly appearance: 'dark' | 'light';
  /** Computed CSS colors of the workbench tokens; every token is present. */
  readonly colors: WorkbenchThemeColors;
}

/** Everything one environment needs before the author document exists. */
export interface IHtmlViewTarget {
  readonly instanceId: string;
  readonly viewId: string;
  readonly device: string;
  readonly title: string;
  /** Package-root relative `.html` entry of the view. */
  readonly entry: string;
  /** Absolute URL prefix that serves the verified package files of this view. */
  readonly assetRoot: string;
  /** Resolved property snapshot, identical to the one the model received. */
  readonly props: FusedPresentationProps;
  /** Declared model methods; empty for a device without a model. */
  readonly methods: readonly string[];
  /** Declared model events; empty for a device without a model. */
  readonly events: readonly string[];
  /** Whether the device declares a model; an absent model leaves `api.model` undefined. */
  readonly hasModel: boolean;
}

export interface IHtmlViewConnectMessage {
  readonly type: typeof HTML_VIEW_CONNECT;
  /** One-time value of this environment; messages of stale pages never match it. */
  readonly token: string;
  /** Origin the environment must use for every message back to the editor. */
  readonly parentOrigin: string;
  readonly target: IHtmlViewTarget;
}

export interface IHtmlViewAckMessage {
  readonly type: typeof HTML_VIEW_ACK;
  readonly token: string;
}

/**
 * Grant of the package asset worker: the prefix it serves plus two ports.
 *
 * The first port is the dedicated package lane of the editor, the second one is where the worker
 * acknowledges the grant. The environment page that installs the grant is the only client the
 * registry admits, and it never answers a package read itself.
 */
export interface IHtmlViewAssetGrantMessage {
  readonly type: typeof HTML_VIEW_ASSETS;
  readonly token: string;
  /** URL pathname of the package asset root this worker serves. */
  readonly root: string;
}

export interface IHtmlViewAssetAckMessage {
  readonly type: typeof HTML_VIEW_ASSETS_ACK;
  readonly token: string;
}

/** Authorization of one inner frame in the package asset worker. */
export interface IHtmlViewAttachMessage {
  readonly type: typeof HTML_VIEW_ATTACH;
  /** Grant token the frame read from its own view identity, never from the author document. */
  readonly token: string;
}

export interface IHtmlViewAttachAckMessage {
  readonly type: typeof HTML_VIEW_ATTACH_ACK;
  readonly token: string;
}

/** Handshake of the inner bootstrap, posted before any author script exists. */
export interface IHtmlViewChildHelloMessage {
  readonly type: typeof HTML_VIEW_CHILD_HELLO;
  readonly token: string;
}

/** Answer of the environment, carrying the one author port of the inner frame. */
export interface IHtmlViewChildConnectMessage {
  readonly type: typeof HTML_VIEW_CHILD_CONNECT;
  readonly token: string;
}

/** Announcement of the inner frame that its API and its package grant are in place. */
export interface IHtmlViewChildPreparedMessage {
  readonly type: typeof HTML_VIEW_CHILD_PREPARED;
  readonly token: string;
}

/** One model event pushed into an environment, for an event it subscribed to. */
export interface IFusedHtmlModelEventWire {
  readonly name: string;
  readonly payload: ModelEvent<Value>;
}

/**
 * Author-facing capabilities of one inner frame, served directly by the editor.
 *
 * Every member is bound to the lease of one view: the declared methods and events of that instance,
 * the verified package of that lock and the live proxy of that model.
 */
export interface IFusedHtmlHostService {
  /** Reads one declared package file; `path` is package-root relative and verified. */
  readAsset(path: string): Promise<Uint8Array>;
  /** Invokes one declared model method through the live model proxy of the instance. */
  callModel(method: string, params: Value): Promise<Value>;
  /** Starts receiving one declared model event. */
  subscribe(event: string): Promise<void>;
  /** Stops receiving one declared model event. */
  unsubscribe(event: string): Promise<void>;
  /** Every subscribed model event of this environment, in production order. */
  onDidModelEvent(listener: (event: IFusedHtmlModelEventWire) => void): () => void;
  /** Announces that the editor released this environment. */
  onDidClose(listener: () => void): () => void;
  /** Reports an author failure; the editor faults the view (RFC 0023). */
  reportFailure(code: string, message: string): Promise<void>;
}

/**
 * Lifecycle capabilities of the trusted outer frame, served directly by the editor.
 *
 * This lane carries no model call and no author resource read: the outer loads the view, relays the
 * theme, reports failures and hands the two dedicated ports on.
 */
export interface IFusedHtmlHostControlService {
  /** Reads one declared package file of this view; the outer reads its author document with it. */
  readAsset(path: string): Promise<Uint8Array>;
  /** Computed theme of the workbench at this moment. */
  getTheme(): Promise<IHtmlViewTheme>;
  /** Announces every later theme of the workbench, including appearance changes. */
  onDidThemeChange(listener: (theme: IHtmlViewTheme) => void): () => void;
  /** Announces that the author document is written; the view leaves the loading state. */
  ready(): Promise<void>;
  /** Reports an author failure; the editor faults the view (RFC 0023). */
  reportFailure(code: string, message: string): Promise<void>;
  /** Announces that the environment goes away without an editor request. */
  closed(): void;
  /**
   * Grants the dedicated package lane of this view's asset worker, once.
   *
   * The port is transferred into the worker straight from the outer frame, so no author document
   * and no editor page ever holds it; the grant token decides which clients it serves.
   */
  assetPort(): Promise<MessagePort>;
  /**
   * Grants the dedicated author lane of this view's inner frame, once.
   *
   * The port is transferred into the sandboxed frame straight from the outer frame, after that
   * frame announced its own hello with the token of this environment.
   */
  contentPort(): Promise<MessagePort>;
}

/** Package bytes the editor answers one asset request with. */
export interface IFusedHtmlAssetService {
  /** Reads one package file for an asset request; every failure answers `404`. */
  read(path: string): Promise<Uint8Array>;
}

/** Identity of one view, as the inner frame receives it before the author document exists. */
export interface IHtmlViewContent {
  /**
   * Package grant token of this environment.
   *
   * It never appears in the author document; the inner frame presents it to the asset worker so
   * only this frame may read the package files of the view.
   */
  readonly token: string;
  readonly target: IHtmlViewTarget;
}

/**
 * View identity the inner frame reads from the editor before the author document exists.
 *
 * It shares the author lane port with {@link IFusedHtmlHostService}, so props, declared methods and
 * events arrive from the same lease and never travel through the outer frame.
 */
export interface IFusedHtmlContentViewService {
  /** Reads the identity of the view; the inner frame calls this exactly once. */
  view(): Promise<IHtmlViewContent>;
}

/** Typed author lane between the editor and one inner frame. */
export const fusedHtmlHostService = defineRpcService<IFusedHtmlHostService>('fused-html-host');

/** Typed control lane between the editor and one trusted environment page. */
export const fusedHtmlHostControlService =
  defineRpcService<IFusedHtmlHostControlService>('fused-html-host-control');

/** Typed package lane between the editor and one environment's asset worker. */
export const fusedHtmlAssetService = defineRpcService<IFusedHtmlAssetService>('fused-html-asset');

/** Typed view identity lane of one inner frame; it shares the author lane port. */
export const fusedHtmlContentViewService =
  defineRpcService<IFusedHtmlContentViewService>('fused-html-content-view');
