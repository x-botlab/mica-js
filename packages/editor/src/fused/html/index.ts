/**
 * `@mica-js/editor/fused/html`: device HTML view environments of the fused editor (RFC 0023).
 *
 * The manager owns one independent-origin environment per `(instanceId, viewId)`. The parent
 * workbench owns the layout: it calls {@link IHtmlViewHost.open} for a declared device view, keeps
 * `handle.element` mounted through {@link IHtmlViewHandle.attach} and closes or releases it with the
 * session. Docking, floating and collapse only re-attach or hide the owner, so the page, its
 * listeners and the model proxy survive every layout change.
 *
 * Each environment is two real documents of one per-view origin, which no editor page shares:
 *
 * | Frame | Document                        | Owns                                                           |
 * | ----- | ------------------------------- | -------------------------------------------------------------- |
 * | outer | `index.html` + `environment.js` | the control lane, the theme relay, the package grant, the write |
 * | inner | `content.html` + `content.js`   | the author document, `acquireDeviceViewApi`, model events       |
 *
 * The outer frame is trusted and permanent; the inner frame is sandboxed and hosts the author HTML.
 * Both have concrete origins, so every message and every DOM access compares exact origins. Three
 * lanes belong to one view and only the control lane reaches the outer: the editor creates a
 * dedicated port for the author frame (props, declared methods, model events, declared package
 * files, close) and a dedicated port for the environment's package worker, and the outer transfers
 * both during the initialization. It writes the author document into `frame.contentDocument` once
 * the inner bootstrap announced that `acquireDeviceViewApi` and the package grant are in place. A
 * navigation or reload of the inner frame fails the view instead of silently starting a second
 * environment.
 *
 * ```ts
 * const views = createHtmlViewHost({
 *   viewBaseUrlTemplate: options.viewBaseUrlTemplate,
 *   container: mount,
 *   registry: options.deviceProvider,
 *   ...createHtmlViewRuntimeSource({
 *     runtime,
 *     device: (id) => {
 *       const manifest = devices.get(id)?.manifest;
 *       return manifest === undefined ? undefined : htmlViewDeviceDeclaration(manifest);
 *     },
 *   }),
 * });
 * const handle = await views.open({ instanceId, viewId: 'serial', location: 'floating' });
 * // The owner already lives in the manager layer: attach() only positions it over the slot.
 * handle.attach(floatingBody);
 * handle.setVisible(expanded);
 * views.onDidChange(({ type, handle }) => {
 *   if (type === 'failed') showFailure(handle.failure);
 * });
 * ```
 *
 * ## Theme
 *
 * The workbench forwards the *computed* colors of its tokens with
 * {@link IHtmlViewHost.setTheme}, so a `var(...)` of the host page is already resolved. Each
 * environment injects those variables and `color-scheme` into the author document root before any
 * author script runs and updates the same root in place afterwards: a theme change (including a
 * system appearance change) never reloads a frame and never loses author input, model session or
 * document history. An environment that receives no theme keeps a complete dark palette.
 *
 * ## Deployment
 *
 * `viewBaseUrlTemplate` names an absolute HTTP(S) directory whose hostname carries one `${id}`
 * label, for example
 * `https://${id}.cdn.example.com/public/<commit>/__mica_view__/`. Every environment substitutes a
 * fresh label, so each view runs on its own origin; a template resolving to the editor origin is
 * rejected. The access application deploys five build outputs of this package there:
 *
 * | File               | Source entry                                   | Notes                                |
 * | ------------------ | ---------------------------------------------- | ------------------------------------ |
 * | `index.html`       | `fused/html/environment/index.html`            | copy verbatim, no bundling needed    |
 * | `content.html`     | `fused/html/environment/content.html`          | copy verbatim, no bundling needed    |
 * | `environment.js`   | `fused/html/environment/entry.ts`              | ES module, self-contained            |
 * | `environment-sw.js`| `fused/html/environment/service-worker.ts`     | ES module, single file, no imports   |
 * | `content.js`       | `fused/html/environment/content.ts`            | ES module, self-contained            |
 *
 * `environment.js` resolves `environment-sw.js` and `content.html` from its own URL, so every file
 * must sit next to `index.html`. The worker is registered with the package asset scope
 * `__mica_package__/` under the same directory. Serve all five as `text/html` and
 * `text/javascript` over a secure context (HTTPS, or `*.localhost` in development, where
 * `http://${id}.localhost:<port>/<path>/` gives every environment an independent origin). No
 * other environment file is needed; the device packages themselves are never published, because
 * the environment reads their bytes from the editor over the typed bridge.
 *
 * A browser without service worker support cannot serve package-relative HTML, CSS and module
 * requests from memory; the environment then reports `view/load-failed` instead of pretending the
 * view loaded, and the rest of the workbench keeps running.
 */
export { createHtmlViewHost, htmlViewKey } from './host';
export type {
  HtmlViewChangeType,
  HtmlViewLocation,
  HtmlViewState,
  IHtmlViewChange,
  IHtmlViewHandle,
  IHtmlViewHost,
  IHtmlViewHostOptions,
  IHtmlViewInstance,
  IHtmlViewOpenRequest,
} from './host';
export { createHtmlViewRuntimeSource, htmlViewDeviceDeclaration } from './source';
export type {
  IHtmlViewDeviceDeclaration,
  IHtmlViewRuntimeSource,
  IHtmlViewSourceOptions,
} from './source';
export { createDeviceViewSession, assertAssetPath } from './client';
export type {
  IDeviceViewApi,
  IDeviceViewModel,
  IDeviceViewSession,
  IDeviceViewSessionOptions,
  IHtmlAssets,
} from './client';
export {
  DEFAULT_HTML_VIEW_THEME,
  applyHtmlViewTheme,
  htmlViewThemeCss,
  htmlViewThemeEquals,
  normalizeHtmlViewTheme,
} from './theme';
export {
  htmlEnvironmentUrl,
  newHtmlEnvironmentId,
  parseHtmlViewBase,
  VIEW_ENV_LABEL,
} from './base-url';
export type { IHtmlViewBase } from './base-url';
export {
  ASSET_ROOT_DIRECTORY,
  ENVIRONMENT_BOOTSTRAP_FILE,
  ENVIRONMENT_CONTENT_DOCUMENT_FILE,
  ENVIRONMENT_CONTENT_FILE,
  ENVIRONMENT_DOCUMENT_FILE,
  ENVIRONMENT_WORKER_FILE,
  HTML_VIEW_CONTENT_POLICY,
  HTML_VIEW_ENVIRONMENT_POLICY,
  assetRootUrl,
  authorBaseUrl,
  decodeDocument,
  mimeTypeOf,
  resolveAssetRequest,
  withHtmlDocumentPreamble,
} from './paths';
export type { IHtmlDocumentPreamble } from './paths';
export {
  HTML_VIEW_ACK,
  HTML_VIEW_ASSETS,
  HTML_VIEW_ASSETS_ACK,
  HTML_VIEW_ATTACH,
  HTML_VIEW_ATTACH_ACK,
  HTML_VIEW_CHILD_CONNECT,
  HTML_VIEW_CHILD_HELLO,
  HTML_VIEW_CHILD_PREPARED,
  HTML_VIEW_CONNECT,
  HTML_VIEW_FRAME_PARAM,
  HtmlViewError,
  fusedHtmlAssetService,
  fusedHtmlContentViewService,
  fusedHtmlHostControlService,
  fusedHtmlHostService,
  isHtmlViewError,
} from './protocol';
export type {
  HtmlViewDiagnosticCode,
  IFusedHtmlAssetService,
  IFusedHtmlContentViewService,
  IFusedHtmlHostControlService,
  IFusedHtmlHostService,
  IFusedHtmlModelEventWire,
  IHtmlViewAckMessage,
  IHtmlViewAssetAckMessage,
  IHtmlViewAssetGrantMessage,
  IHtmlViewAttachAckMessage,
  IHtmlViewAttachMessage,
  IHtmlViewChildConnectMessage,
  IHtmlViewChildHelloMessage,
  IHtmlViewChildPreparedMessage,
  IHtmlViewConnectMessage,
  IHtmlViewContent,
  IHtmlViewFailure,
  IHtmlViewTarget,
  IHtmlViewTheme,
} from './protocol';
/*
 * `environment/entry.ts`, `environment/content.ts` and `environment/service-worker.ts` are
 * deployment entries, not library API: they self-start inside their frame and are bundled by the
 * access application.
 */
