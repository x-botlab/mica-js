import type { PayloadType } from '@mica-js/core/canvas';
import type { WidgetAudioOptions, WidgetHost } from '@mica-js/widget';

/**
 * One endpoint of the loaded schematic a widget port can bind to.
 *
 * The shape is what a binding picker needs: the symbol id a binding names, the designator shown to
 * users, the port key and the contract of that port. `CanvasEditor.getBindingTargets()` returns
 * these without handing out the device host that produces them.
 */
export interface CanvasBindingTargetInfo {
  /** Symbol instance id the binding names. */
  readonly symbol: string;
  /** Reference designator shown to users; the symbol id when the schematic sets none. */
  readonly designator: string;
  readonly port: string;
  readonly direction: 'input' | 'output';
  readonly type: PayloadType;
}

export interface HostProviderCreateOptions {
  readonly audio?: WidgetAudioOptions;
}

/**
 * Creates the widget runtime an editor drives and owns it for the editor's lifetime.
 *
 * The editor never assembles a host itself: a real host needs guest bundles, a file system, a
 * device simulation and a container, and those belong to the application. It asks a provider for
 * the host once, while `ready` is pending, and hands the teardown back through
 * {@link HostProvider.dispose}.
 */
export interface HostProvider {
  /**
   * Creates the host the editor coordinates with.
   *
   * Awaited while the editor initializes, so a provider may start sandboxes first — the slowest
   * part of a real host. The editor then hands `CanvasEditorOptions.document` to the returned host
   * and mounts over the snapshot that host reports.
   */
  createWidgetHost(options?: HostProviderCreateOptions): WidgetHost | Promise<WidgetHost>;

  /**
   * Endpoints the schematic loaded behind the host offers, so a binding picker can list them
   * without reaching for the device host itself.
   *
   * `CanvasEditor.getBindingTargets()` calls it once per request, after the editor's document
   * loaded, so the answer follows the schematic the host currently runs. A provider that owns no
   * device side returns an empty array; after {@link HostProvider.dispose} it may also answer with
   * an empty array, because the device host it would ask is gone.
   *
   * The endpoints belong to the loaded schematic, not to the document alone: a caller that just
   * loaded a document binding another schematic waits for that load before asking.
   */
  getBindingTargets(): Promise<readonly CanvasBindingTargetInfo[]>;

  /**
   * Releases the host and everything the provider created behind it.
   *
   * `CanvasEditor.dispose()` calls it once per editor. It has to be idempotent and has to stay
   * safe while {@link HostProvider.createWidgetHost} is still in flight: an editor disposed during
   * startup disposes a host it never used.
   */
  dispose(): Promise<void>;
}
