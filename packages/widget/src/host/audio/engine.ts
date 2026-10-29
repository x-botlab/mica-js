import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint, RpcProxy } from '@mica-js/core/rpc';
import {
  defaultMaxStreams,
  defaultMaxVoices,
  widgetAudioControlService,
  widgetAudioWorkletProcessor,
} from '../../guest/audio/protocol';
import type {
  WidgetAudioControlService,
  WidgetAudioDiagnostic,
  WidgetAudioDiagnosticCode,
  WidgetAudioLimits,
  WidgetAudioMountInfo,
  WidgetAudioState,
} from '../../guest/audio/protocol';
import { widgetAudioWorkletUrl } from './worklet';

/** Structural stand-ins for the Web Audio nodes the engine touches; tests inject fakes. */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect?(): void;
}

export interface AudioContextLike {
  readonly sampleRate: number;
  /** `suspended` | `running` | `closed` for a real context. */
  readonly state: string;
  readonly destination: AudioNodeLike;
  readonly audioWorklet?: { addModule(url: string): Promise<void> };
  /**
   * Fired by a real context whenever the browser suspends or resumes it on its own (autoplay
   * policy, hidden page, a caller calling `suspend()` / `resume()`). Used as a fallback when the
   * context lacks `addEventListener`; fakes may leave it `null`.
   */
  onstatechange?: ((event?: unknown) => void) | null;
  /** Preferred over `onstatechange`: subscribing must not clobber the caller's own handler. */
  addEventListener?(type: 'statechange', listener: () => void): void;
  removeEventListener?(type: 'statechange', listener: () => void): void;
}

export interface AudioWorkletNodeLike extends AudioNodeLike {
  readonly port: MessagePort;
}

export interface MessageChannelLike {
  readonly port1: MessagePort;
  readonly port2: MessagePort;
}

/** Host-side sinks the engine reports into; the widget host owns the sandbox plumbing. */
export interface WidgetAudioNotifier {
  /** Hands the direct guest ↔ worklet port to the sandbox. */
  emitPort(port: MessagePort): void;
  emitState(state: WidgetAudioState): void;
}

export interface WidgetAudioEngineOptions {
  readonly context: AudioContextLike;
  readonly destination?: AudioNodeLike;
  readonly limits?: Partial<WidgetAudioLimits>;
  readonly report: (code: WidgetAudioDiagnosticCode, instanceId: string, message: string) => void;
  readonly notify: WidgetAudioNotifier;
  /** Loads the audio worklet node; tests or applications may provide their own loader. */
  readonly loadWorklet?: () => Promise<AudioWorkletNodeLike>;
  readonly createChannel?: () => MessageChannelLike;
  readonly createWorkletNode?: (context: AudioContextLike, name: string) => AudioWorkletNodeLike;
}

interface InstanceAudio {
  readonly instanceId: string;
  readonly session: string;
}

/**
 * Host half of the audio path (RFC 0016).
 *
 * Owns the one `AudioWorkletNode`, the session tokens, and the two RPC endpoints that reach the
 * worklet: host controls over the node port, and the direct guest channel it hands to the sandbox.
 * No audio node other than that worklet is created here: tones, mixing and volume all live inside
 * the worklet.
 */
export class WidgetAudioEngine {
  readonly #context: AudioContextLike;
  readonly #destination: AudioNodeLike;
  readonly #report: WidgetAudioEngineOptions['report'];
  readonly #notify: WidgetAudioNotifier;
  readonly #limits: WidgetAudioLimits;
  readonly #loadWorklet: (() => Promise<AudioWorkletNodeLike>) | undefined;
  readonly #createChannel: () => MessageChannelLike;
  readonly #createWorkletNode: (context: AudioContextLike, name: string) => AudioWorkletNodeLike;
  readonly #runtimeId = `r${Math.random().toString(36).slice(2, 10)}`;
  readonly #instances = new Map<string, InstanceAudio>();
  #worklet: AudioWorkletNodeLike | undefined;
  #endpoint: RpcEndpoint | undefined;
  #control: RpcProxy<WidgetAudioControlService> | undefined;
  #booting: Promise<boolean> | undefined;
  #available: boolean | undefined;
  #muted = false;
  #suspended = false;
  #sessionCounter = 0;
  #disposed = false;
  #lastState: WidgetAudioState | undefined;
  #detachStateListener: (() => void) | undefined;
  /** Context state moved without an engine call; guests get the same ordered notification. */
  readonly #onContextStateChange = (): void => {
    if (this.#disposed) return;
    this.#syncState();
  };

  constructor(options: WidgetAudioEngineOptions) {
    this.#context = options.context;
    this.#destination = options.destination ?? options.context.destination;
    this.#report = options.report;
    this.#notify = options.notify;
    this.#limits = {
      maxVoices: Math.max(1, Math.floor(options.limits?.maxVoices ?? defaultMaxVoices)),
      maxStreams: Math.max(1, Math.floor(options.limits?.maxStreams ?? defaultMaxStreams)),
    };
    this.#loadWorklet = options.loadWorklet;
    this.#createChannel =
      options.createChannel ??
      (() => {
        const channel = new MessageChannel();
        return { port1: channel.port1, port2: channel.port2 };
      });
    this.#createWorkletNode =
      options.createWorkletNode ??
      ((context, name) => {
        const ctor = (
          globalThis as {
            AudioWorkletNode?: new (
              context: unknown,
              name: string,
              options: unknown,
            ) => AudioWorkletNodeLike;
          }
        ).AudioWorkletNode;
        if (!ctor) throw new Error('AudioWorkletNode is not available');
        return new ctor(context, name, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
      });
  }

  /**
   * Current availability.
   *
   * `unavailable` means "no audio at all": the host configured none, the browser lacks
   * `AudioWorklet`, or the worklet module failed to load.
   */
  get state(): WidgetAudioState {
    if (this.#disposed || this.#available === false) return 'unavailable';
    if (this.#available !== true || this.#suspended) return 'suspended';
    return this.#context.state === 'running' ? 'running' : 'suspended';
  }

  /** Limits in force, so a caller can mirror them in its own UI. */
  get limits(): WidgetAudioLimits {
    return this.#limits;
  }

  /**
   * Opens the mount generation of one instance.
   *
   * Resolves once the worklet registered the session token, so the `mount` request that carries it
   * can never arrive after the first guest call of that generation.
   */
  async open(instanceId: string): Promise<WidgetAudioMountInfo> {
    if (this.#disposed) return { state: 'unavailable' };
    const available = await this.#boot();
    if (!available) return { state: 'unavailable' };

    this.close(instanceId);
    this.#sessionCounter += 1;
    const session = `${this.#runtimeId}-${this.#sessionCounter}`;
    this.#instances.set(instanceId, { instanceId, session });
    try {
      await this.#control?.openSession({
        session,
        runtimeId: this.#runtimeId,
        instanceId,
        maxVoices: this.#limits.maxVoices,
        maxStreams: this.#limits.maxStreams,
      });
    } catch (error) {
      this.#report(
        'widget/audio-failed',
        instanceId,
        `The audio worklet rejected the session: ${describe(error)}`,
      );
    }
    this.#syncState();
    return { state: this.state, session };
  }

  setMuted(muted: boolean): void {
    this.#muted = muted === true;
    this.#call((control) => control.setMuted(this.#muted));
  }

  setInstanceVolume(instanceId: string, volume: number): void {
    if (typeof volume !== 'number') {
      throw new TypeError('WidgetHost.audio.setInstanceVolume expects a number');
    }
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new RangeError('WidgetHost.audio.setInstanceVolume expects a value in [0, 1]');
    }
    const instance = this.#instances.get(instanceId);
    if (!instance) return;
    this.#call((control) => control.setSessionVolume(instance.session, volume));
  }

  /** Freezes audio without touching the caller's `AudioContext`. */
  suspend(): void {
    if (this.#disposed || this.#suspended) return;
    this.#suspended = true;
    this.#call((control) => control.suspend());
    this.#syncState();
  }

  resume(): void {
    if (this.#disposed) return;
    this.#suspended = false;
    this.#call((control) => control.resume());
    this.#syncState();
  }

  /**
   * Closes the instance only when it still belongs to `session`.
   *
   * A mount attempt that lost its id may have opened its own audio generation after the host's
   * cleanup sweep; closing by id alone would tear down the replacement instead.
   */
  closeSession(instanceId: string, session: string): void {
    const instance = this.#instances.get(instanceId);
    if (!instance || instance.session !== session) return;
    this.close(instanceId);
  }

  /** Drops one instance: its session token is revoked and the worklet ends its voices and streams. */
  close(instanceId: string): void {
    const instance = this.#instances.get(instanceId);
    if (!instance) return;
    this.#instances.delete(instanceId);
    this.#call((control) => control.closeSession(instance.session));
  }

  /**
   * Drops every instance and hands the worklet a fresh guest channel.
   *
   * Called when the sandbox goes away: the old guest port died with it, and the next sandbox needs
   * a port of its own.
   */
  reset(): void {
    for (const instanceId of [...this.#instances.keys()]) {
      this.close(instanceId);
    }
    if (this.#available === true && this.#control !== undefined) {
      void this.#restartRuntime();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const instanceId of [...this.#instances.keys()]) {
      this.close(instanceId);
    }
    // Sent before the flag flips: the worklet drops the runtime, its sessions and its guest port.
    this.#call((control) => control.detachGuestPort(this.#runtimeId));
    this.#disposed = true;
    this.#detachStateListener?.();
    this.#detachStateListener = undefined;
    this.#endpoint?.dispose();
    this.#endpoint = undefined;
    this.#control = undefined;
    const worklet = this.#worklet;
    this.#worklet = undefined;
    if (worklet !== undefined) {
      closePort(worklet.port);
      try {
        worklet.disconnect?.();
      } catch {
        // Already detached.
      }
    }
  }

  /** Boots the worklet once; a failure is permanent for the lifetime of the engine. */
  #boot(): Promise<boolean> {
    this.#booting ??= this.#start().catch((error: unknown) => {
      this.#available = false;
      // A load that fails after `dispose()` is not a widget problem and has no live host to hear it.
      if (!this.#disposed) {
        this.#report('widget/audio-failed', '', `Widget audio is unavailable: ${describe(error)}`);
      }
      return false;
    });
    return this.#booting;
  }

  async #start(): Promise<boolean> {
    if (
      this.#loadWorklet === undefined &&
      typeof this.#context.audioWorklet?.addModule !== 'function'
    ) {
      this.#available = false;
      return false;
    }

    this.#listenForContextState();
    const worklet = await (this.#loadWorklet?.() ?? this.#loadDefaultWorklet());
    if (this.#disposed) {
      // `dispose()` ran while the module was loading: release the node instead of wiring it up.
      closePort(worklet.port);
      try {
        worklet.disconnect?.();
      } catch {
        // Already detached.
      }
      return false;
    }
    this.#worklet = worklet;
    const endpoint = createRpc(worklet.port);
    this.#endpoint = endpoint;
    const control = endpoint.getProxy(widgetAudioControlService, {
      transfer: (member, args) => (member === 'attachGuestPort' ? [args[1] as MessagePort] : []),
    });
    this.#control = control;
    control.onDidDiagnostic((diagnostic) => this.#onDiagnostic(diagnostic));
    worklet.connect(this.#destination);
    await this.#attachRuntime();
    this.#available = true;
    return true;
  }

  /**
   * Mirrors the context's own `statechange` onto mounted guests.
   *
   * The caller owns the `AudioContext`, so its state can move without the engine asking: autoplay
   * policy keeping it suspended, the browser suspending a hidden page, or the caller calling
   * `resume()`. Guests read `api.audio.state` and `onStateChange`, so those moves must be forwarded.
   */
  #listenForContextState(): void {
    if (this.#detachStateListener) return;
    const context = this.#context;
    if (typeof context.addEventListener === 'function') {
      context.addEventListener('statechange', this.#onContextStateChange);
      this.#detachStateListener = () =>
        context.removeEventListener?.('statechange', this.#onContextStateChange);
      return;
    }
    if (!('onstatechange' in context)) return;
    // Contexts that only expose the handler property keep the caller's value for `dispose()`.
    const previous = context.onstatechange;
    context.onstatechange = this.#onContextStateChange;
    this.#detachStateListener = () => {
      if (context.onstatechange === this.#onContextStateChange) context.onstatechange = previous;
    };
  }

  /** Worklet → host diagnostics, attributed back to the instance that owns the session. */
  #onDiagnostic(diagnostic: WidgetAudioDiagnostic): void {
    const owner = [...this.#instances.values()].find(
      (entry) => entry.session === diagnostic.session,
    );
    // A revoked token means the message is late; the RFC drops it instead of raising diagnostics.
    if (!owner) return;
    this.#report(diagnostic.code, owner.instanceId, diagnostic.message);
  }

  async #loadDefaultWorklet(): Promise<AudioWorkletNodeLike> {
    await this.#context.audioWorklet?.addModule(widgetAudioWorkletUrl());
    return this.#createWorkletNode(this.#context, widgetAudioWorkletProcessor);
  }

  async #restartRuntime(): Promise<void> {
    const control = this.#control;
    if (control === undefined) return;
    try {
      await control.detachGuestPort(this.#runtimeId);
    } catch {
      // The worklet already forgot the runtime; a new channel follows anyway.
    }
    await this.#attachRuntime();
  }

  /** Transfers a fresh port to the worklet and hands the other end to the guest. */
  async #attachRuntime(): Promise<void> {
    const control = this.#control;
    if (control === undefined || this.#disposed) return;
    const channel = this.#createChannel();
    try {
      await control.attachGuestPort(this.#runtimeId, channel.port1);
    } catch (error) {
      closePort(channel.port1);
      closePort(channel.port2);
      this.#report(
        'widget/audio-failed',
        '',
        `The audio worklet rejected the guest port: ${describe(error)}`,
      );
      return;
    }
    this.#notify.emitPort(channel.port2);
  }

  /** Fires one host → worklet call; a missing or closed worklet is not a widget failure. */
  #call(run: (control: RpcProxy<WidgetAudioControlService>) => Promise<unknown>): void {
    const control = this.#control;
    if (control === undefined || this.#disposed) return;
    try {
      void run(control).catch(() => undefined);
    } catch {
      // The endpoint is already closed.
    }
  }

  #syncState(): void {
    const next = this.state;
    if (next === this.#lastState) return;
    this.#lastState = next;
    this.#notify.emitState(next);
  }
}

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // Already closed.
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' ? error : String(error);
}
