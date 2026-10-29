import type { SandboxWorker } from '@mica-js/sandbox';
import type { DeviceSimulationHost } from '@mica-js/simulator';
import type { WidgetHost, WidgetProvider } from '@mica-js/widget';
import {
  createWidgetHost,
  createWidgetHostGuestSandbox,
  createWidgetSandboxFromWorker,
} from '@mica-js/widget';
import type { HostFs } from '@mica-js/widget';
import {
  createDeviceSimulationHostFromSandbox,
  createDeviceSimulationHostGuestSandbox,
} from '@mica-js/simulator/sandbox';
import type { CanvasBindingTargetInfo, HostProvider, HostProviderCreateOptions } from './provider';

/**
 * Label of the RFC 0018 device simulation guest.
 *
 * A project that owns devices passes its own worker for this label; the default one ships with
 * `@mica-js/simulator` and resolves no devices.
 */
export const deviceSimulationGuest = 'device';
export const widgetGuest = 'widget';

/** The three dependencies needed to build the device and widget hosts. */
export interface SandboxHostProviderOptions {
  /**
   * Creates a fresh worker for the `device` or `widget` guest.
   *
   * Omit it to use the guests both packages ship: `createDeviceSimulationHostGuestSandbox()` for
   * `device` and `createWidgetHostGuestSandbox()` for `widget`. Provide it to run your own guest —
   * for example one that bundles your device library.
   */
  readonly getSandboxWorker?: (label: string) => SandboxWorker | Promise<SandboxWorker>;
  readonly fs: HostFs;
  readonly widgetProvider: WidgetProvider;
}

/** Starts the guest each package ships; a custom guest is provided through the options. */
function createPackagedSandboxWorker(label: string): SandboxWorker {
  if (label === deviceSimulationGuest)
    return createDeviceSimulationHostGuestSandbox({ name: label });
  if (label === widgetGuest) return createWidgetHostGuestSandbox({ name: label });
  throw new Error(`Unknown sandbox label: ${label}`);
}

/**
 * The default {@link HostProvider}: starts the device guest, builds the `DeviceSimulationHost` over
 * it, and wraps that in a `WidgetHost`.
 *
 * The two guests are separate workers, so the provider also wires the direct topic channel between
 * them (RFC 0018): one `MessagePort` end travels to each guest with its first ordinary message,
 * and topic traffic then runs worker-to-worker instead of through the host. Both hosts belong to the provider,
 * so an editor built on it owns its whole runtime: `dispose()` disposes the widget host — which
 * terminates the widget guest — and then the device host, which terminates the device guest. The
 * device host stays reachable through {@link SandboxHostProvider.deviceHost} for topics, schematics
 * and simulation publishes.
 */
export class SandboxHostProvider implements HostProvider {
  readonly #options: SandboxHostProviderOptions;
  #creation: Promise<WidgetHost> | undefined;
  #widgetHost: WidgetHost | undefined;
  #deviceHost: DeviceSimulationHost | undefined;
  /** The direct topic channel; kept so a failed start can close the end no worker received. */
  #channel: MessageChannel | undefined;
  #disposal: Promise<void> | undefined;
  #disposed = false;

  constructor(options: SandboxHostProviderOptions) {
    this.#options = options;
  }

  /** Device simulation host created for the widget host, once `createWidgetHost()` settled. */
  get deviceHost(): DeviceSimulationHost | undefined {
    return this.#deviceHost;
  }

  /** Widget host handed to the editor, once `createWidgetHost()` settled. */
  get widgetHost(): WidgetHost | undefined {
    return this.#widgetHost;
  }

  createWidgetHost(options?: HostProviderCreateOptions): Promise<WidgetHost> {
    if (this.#disposed) {
      return Promise.reject(new Error('The sandbox host provider was already disposed.'));
    }
    // One host per provider: a second editor created over the same provider would share — and on
    // dispose, kill — the runtime of the first one.
    this.#creation ??= this.#create(options);
    return this.#creation;
  }

  async #create(createOptions?: HostProviderCreateOptions): Promise<WidgetHost> {
    const { fs, widgetProvider } = this.#options;
    const getSandboxWorker = this.#options.getSandboxWorker ?? createPackagedSandboxWorker;
    // The two guests are separate workers, so a direct topic channel is one port pair: the device
    // guest gets one end, the widget guest the other, and neither needs the host in the middle.
    const channel = new MessageChannel();
    this.#channel = channel;
    let sandbox: SandboxWorker | undefined;
    try {
      sandbox = await getSandboxWorker(deviceSimulationGuest);
      await sandbox.ready;
    } catch (error) {
      closePort(channel.port1);
      closePort(channel.port2);
      await sandbox?.terminate('device simulation host failed to start').catch(() => undefined);
      throw error;
    }
    let deviceHost: DeviceSimulationHost;
    try {
      deviceHost = await createDeviceSimulationHostFromSandbox({
        sandbox,
        fs,
        ports: [channel.port1],
      });
    } catch (error) {
      // The guest was started for a host that will never exist; the adapter only terminates the
      // worker when its own handshake fails.
      closePort(channel.port1);
      closePort(channel.port2);
      await sandbox.terminate('device simulation host failed to start').catch(() => undefined);
      throw error;
    }
    this.#deviceHost = deviceHost;
    let host: WidgetHost;
    try {
      host = createWidgetHost(
        {
          widgetProvider,
          deviceHost,
          fs,
          ...(createOptions?.audio === undefined ? {} : { audio: createOptions.audio }),
          devicePort: channel.port2,
        },
        async (sandboxOptions) => {
          const widgetWorker = await getSandboxWorker(widgetGuest);
          await widgetWorker.ready;
          return createWidgetSandboxFromWorker(widgetWorker, sandboxOptions);
        },
      );
    } catch (error) {
      // Nothing will drive the device host; release it instead of leaving its guest running.
      this.#deviceHost = undefined;
      closePort(channel.port2);
      await deviceHost.dispose().catch(() => undefined);
      throw error;
    }
    this.#widgetHost = host;
    return host;
  }

  /**
   * Device topics of the loaded schematic, resolved into the shape a binding picker lists.
   *
   * A creation still in flight is awaited first, so a caller that asks right after
   * `createWidgetHost()` still gets the endpoints of the device host it is building. The topics the
   * guest reports already carry the designator; the symbol id stands in when the schematic sets none.
   */
  async getBindingTargets(): Promise<readonly CanvasBindingTargetInfo[]> {
    if (this.#disposed) {
      return [];
    }
    if (this.#deviceHost === undefined && this.#creation !== undefined) {
      await this.#creation.catch(() => undefined);
    }
    const deviceHost = this.#deviceHost;
    if (deviceHost === undefined) {
      return [];
    }
    const topics = await deviceHost.getTopics();
    return topics.map((topic) => ({
      symbol: topic.symbol,
      designator: topic.designator ?? topic.symbol,
      port: topic.port,
      direction: topic.direction,
      type: topic.type,
    }));
  }

  dispose(): Promise<void> {
    this.#disposal ??= this.#release();
    return this.#disposal;
  }

  async #release(): Promise<void> {
    this.#disposed = true;
    // A creation still in flight produces a host nobody will use; wait for it so its sandboxes are
    // released here instead of leaking. The editor waits for `ready` before disposing, so this is
    // the provider-on-its-own path.
    await this.#creation?.catch(() => undefined);
    const widgetHost = this.#widgetHost;
    const deviceHost = this.#deviceHost;
    const channel = this.#channel;
    this.#widgetHost = undefined;
    this.#deviceHost = undefined;
    this.#channel = undefined;
    try {
      // Widget first: it is the only consumer of the device host, so its instances go away before
      // the simulation they were bound to.
      await widgetHost?.dispose();
    } finally {
      await deviceHost?.dispose();
      // Closing a port a worker already owns is a no-op; this releases the ends nobody took.
      closePort(channel?.port1);
      closePort(channel?.port2);
    }
  }
}

/** Releases one end of a port pair the workers never adopted. */
function closePort(port: MessagePort | undefined): void {
  try {
    port?.close();
  } catch {
    // Already closed with the guest.
  }
}
