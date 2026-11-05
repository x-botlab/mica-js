import { timePs } from '@mica-js/core';
import type { TimePs } from '@mica-js/core';
import { Emitter } from '@mica-js/core/lifecycle';
import type { Event } from '@mica-js/core/lifecycle';
import type { CanvasBindingTarget, PayloadType } from '@mica-js/document/canvas';
import type { WidgetAudioMountInfo } from '../guest/audio/protocol';
import { mergeProperties } from '../guest/widget/props';
import {
  widgetAssetFailedEvent,
  widgetConfigureMethod,
  widgetDeliverMethod,
  widgetErrorEvent,
  widgetFrameEvent,
  widgetLoadMethod,
  widgetMountMethod,
  widgetPointerMethod,
  widgetPublishEvent,
  widgetResizeMethod,
  widgetSetAssetsMethod,
  widgetSetBindingsMethod,
  widgetSetPropertiesMethod,
  widgetStepMethod,
  widgetUnmountMethod,
} from '../guest/widget/protocol';
import type {
  WidgetAssetFailedMessage,
  WidgetErrorMessage,
  WidgetFrameMessage,
  WidgetPublishMessage,
} from '../guest/widget/protocol';
import type { WidgetInputEvent } from '../guest/widget/types';
import { WidgetAudioEngine } from '../host/audio/engine';
import type {
  AudioContextLike,
  AudioNodeLike,
  AudioWorkletNodeLike,
  WidgetAudioEngineOptions,
} from '../host/audio/engine';
import { NO_AUDIO_CONTROLS } from '../host/audio/noop';
import type { WidgetAudioControls, WidgetAudioOptions } from '../host/audio/types';
import type { WidgetSandbox } from '../host/types';
import type { WidgetModule } from '../types';
import { WidgetRuntimeError } from './errors';
import type {
  IPreparedWidgetInstance,
  IWidgetFrame,
  IWidgetFrameContext,
  IWidgetInstanceUpdate,
  IWidgetMessage,
  IWidgetRuntime,
  IWidgetRuntimeDiagnostic,
  IWidgetRuntimeDiagnosticCode,
  IWidgetRuntimeDiagnosticPhase,
  IWidgetRuntimeOptions,
} from './types';

interface IRuntimeInstance {
  readonly instanceId: string;
  readonly widget: string;
  readonly module: WidgetModule;
  readonly generation: number;
  width: number;
  height: number;
  dpr: number;
  bitmap: ImageBitmap | undefined;
  sequence: number;
  mounted: boolean;
  audioSession: string | undefined;
}

/** One deliver or pointer call accepted by `deliver` / `dispatch`, waiting for the next step. */
interface IPendingCall {
  readonly instanceId: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * Creates the widget runtime over an existing sandbox.
 *
 * The runtime owns the sandbox: `dispose()` terminates it, so the caller must not keep using it
 * afterwards. The runtime never reads documents or files, resolves widget modules, drives a clock
 * or talks to a device runtime; those stay with the editor that calls it.
 */
export function createWidgetRuntime(
  sandbox: WidgetSandbox,
  options: IWidgetRuntimeOptions = {},
): IWidgetRuntime {
  return new WidgetRuntimeImpl(sandbox, options);
}

class WidgetRuntimeImpl implements IWidgetRuntime {
  readonly #sandbox: WidgetSandbox;
  readonly #engine: WidgetAudioEngine | undefined;
  readonly #instances = new Map<string, IRuntimeInstance>();
  readonly #pending: IPendingCall[] = [];
  readonly #published = new Emitter<IWidgetMessage>();
  readonly #rendered = new Emitter<IWidgetFrame>();
  readonly #diagnostics = new Emitter<IWidgetRuntimeDiagnostic>();
  readonly #unsubscribers: (() => void)[] = [];

  readonly onDidPublish: Event<IWidgetMessage> = this.#published.event;
  readonly onDidRender: Event<IWidgetFrame> = this.#rendered.event;
  readonly onDidDiagnostic: Event<IWidgetRuntimeDiagnostic> = this.#diagnostics.event;
  readonly audio: WidgetAudioControls;

  /** Serializes mount, update, unmount, setBindings and step; a failure never poisons the chain. */
  #tail: Promise<void> = Promise.resolve();
  #configured: Promise<boolean> | undefined;
  #simTime: TimePs = timePs(0);
  #generation = 0;
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(sandbox: WidgetSandbox, options: IWidgetRuntimeOptions) {
    this.#sandbox = sandbox;

    const audioOptions: WidgetAudioOptions | undefined = options.audio;
    if (audioOptions === undefined) {
      this.audio = NO_AUDIO_CONTROLS;
    } else {
      const context = audioOptions.context;
      const getAudioWorklet = audioOptions.getAudioWorklet;
      const engineOptions: WidgetAudioEngineOptions = {
        context: context as unknown as AudioContextLike,
        ...(audioOptions.destination === undefined
          ? {}
          : { destination: audioOptions.destination as unknown as AudioNodeLike }),
        ...(getAudioWorklet === undefined
          ? {}
          : {
              loadWorklet: () => getAudioWorklet(context) as Promise<AudioWorkletNodeLike>,
            }),
        ...(audioOptions.limits === undefined ? {} : { limits: audioOptions.limits }),
        report: (code, instanceId, message) =>
          this.#report(code, 'audio', message, instanceId === '' ? {} : { instanceId }),
        notify: {
          emitPort: (port) => {
            const lane = sandbox.audio;
            if (lane === undefined) {
              closePort(port);
              return;
            }
            try {
              lane.attachPort(port);
            } catch {
              closePort(port);
            }
          },
          emitState: (state) => {
            try {
              sandbox.audio?.setState(state);
            } catch {
              // The sandbox is already gone; its guest state no longer matters.
            }
          },
        },
      };
      const engine = new WidgetAudioEngine(engineOptions);
      this.#engine = engine;
      this.audio = engine;
    }

    this.#unsubscribers.push(
      sandbox.on(widgetFrameEvent, (payload) => this.#onFrame(payload)),
      sandbox.on(widgetPublishEvent, (payload) => this.#onPublish(payload)),
      sandbox.on(widgetErrorEvent, (payload) => this.#onError(payload)),
      sandbox.on(widgetAssetFailedEvent, (payload) => this.#onAssetFailed(payload)),
    );
  }

  mount(instance: IPreparedWidgetInstance): Promise<void> {
    return this.#run(async () => {
      const prepared = normalizePrepared(instance);
      this.#assertActive();
      if (this.#instances.has(prepared.instanceId)) {
        throw new WidgetRuntimeError(
          'widget/instance-exists',
          `Widget instance "${prepared.instanceId}" is already mounted.`,
        );
      }
      const ref = splitRef(prepared.widget);
      if (ref === undefined) {
        throw new WidgetRuntimeError(
          'widget/invalid-instance',
          `Widget reference "${prepared.widget}" must use the "<package>:<widget>" form.`,
        );
      }

      await this.#configure();
      this.#assertActive();

      const record: IRuntimeInstance = {
        instanceId: prepared.instanceId,
        widget: prepared.widget,
        module: prepared.module,
        generation: ++this.#generation,
        width: prepared.width,
        height: prepared.height,
        dpr: prepared.dpr,
        bitmap: undefined,
        sequence: 0,
        mounted: false,
        audioSession: undefined,
      };
      this.#instances.set(record.instanceId, record);

      try {
        await this.#sandbox.call(widgetLoadMethod, {
          packages: [
            {
              id: ref.packageId,
              modules: {
                [ref.widgetId]: {
                  definition: prepared.module.definition,
                  code: prepared.module.code,
                },
              },
            },
          ],
        });
        this.#assertOwnership(record);

        const audio = await this.#openAudio(record);
        this.#assertOwnership(record);

        const properties = mergeProperties(
          prepared.module.definition.properties,
          prepared.properties,
        );
        await this.#sandbox.call(widgetMountMethod, {
          instanceId: record.instanceId,
          widget: record.widget,
          width: record.width,
          height: record.height,
          dpr: record.dpr,
          props: properties,
          ...(prepared.assets === undefined ? {} : { assets: prepared.assets }),
          generation: record.generation,
          audio,
        });
        this.#assertOwnership(record);
        record.mounted = true;
      } catch (error) {
        this.#forget(record);
        await this.#releaseGuest(record.instanceId);
        if (record.audioSession !== undefined) {
          this.#engine?.closeSession(record.instanceId, record.audioSession);
        }
        if (this.#disposed) {
          throw new WidgetRuntimeError(
            'widget/disposed',
            `Mount of widget instance "${prepared.instanceId}" was cancelled before it finished.`,
          );
        }
        if (this.#sandbox.state === 'terminated') {
          this.#report(
            'widget/runtime-failed',
            'runtime',
            'The widget sandbox terminated during mount.',
          );
          throw new WidgetRuntimeError(
            'widget/sandbox-failed',
            'The widget sandbox terminated during mount.',
            { cause: error },
          );
        }
        this.#report(
          'widget/mount-failed',
          'mount',
          `Widget "${prepared.widget}" failed to mount: ${describeError(error)}`,
          { instanceId: prepared.instanceId, widget: prepared.widget },
        );
        throw error instanceof WidgetRuntimeError
          ? error
          : new WidgetRuntimeError(
              'widget/sandbox-failed',
              `Widget "${prepared.widget}" failed to mount: ${describeError(error)}`,
              { cause: error },
            );
      }
    });
  }

  update(instanceId: string, update: IWidgetInstanceUpdate): Promise<void> {
    return this.#run(async () => {
      requireId(instanceId);
      this.#assertActive();
      const record = this.#requireMounted(instanceId);

      if (update.width !== undefined || update.height !== undefined || update.dpr !== undefined) {
        const width =
          update.width === undefined ? record.width : requireSize(update.width, 'width');
        const height =
          update.height === undefined ? record.height : requireSize(update.height, 'height');
        const dpr = update.dpr === undefined ? record.dpr : requireDpr(update.dpr);
        await this.#call(
          widgetResizeMethod,
          [instanceId, width, height, dpr],
          record,
          'widget/update-failed',
          'update',
        );
        record.width = width;
        record.height = height;
        record.dpr = dpr;
      }

      if (update.properties !== undefined) {
        const properties = mergeProperties(record.module.definition.properties, update.properties);
        await this.#call(
          widgetSetPropertiesMethod,
          [instanceId, properties],
          record,
          'widget/update-failed',
          'update',
        );
      }

      if (update.assets !== undefined) {
        await this.#call(
          widgetSetAssetsMethod,
          [instanceId, update.assets],
          record,
          'widget/update-failed',
          'update',
        );
      }
    });
  }

  unmount(instanceId: string): Promise<void> {
    return this.#run(async () => {
      requireId(instanceId);
      // Disposal already cleared every instance and terminated the sandbox.
      if (this.#disposed) return;
      const record = this.#instances.get(instanceId);
      if (record === undefined) return;

      this.#instances.delete(instanceId);
      this.#closeRecord(record);
      for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
        if (this.#pending[index]?.instanceId === instanceId) this.#pending.splice(index, 1);
      }
      if (record.audioSession !== undefined) {
        this.#engine?.closeSession(instanceId, record.audioSession);
      }
      try {
        await this.#sandbox.call(widgetUnmountMethod, instanceId);
      } catch (error) {
        this.#report(
          'widget/unmount-failed',
          'unmount',
          `Widget instance "${instanceId}" could not be released: ${describeError(error)}`,
          { instanceId, widget: record.widget },
        );
      }
    });
  }

  deliver(message: IWidgetMessage): Promise<void> {
    try {
      if (this.#disposed) {
        throw new WidgetRuntimeError('widget/disposed', 'The widget runtime is disposed.');
      }
      const record = this.#requireMounted(message.instanceId);
      const port = record.module.definition.ports[message.port];
      if (port === undefined) {
        throw new WidgetRuntimeError(
          'widget/unknown-port',
          `Widget instance "${message.instanceId}" has no port ${JSON.stringify(message.port)}.`,
        );
      }
      if (port.direction !== 'input') {
        throw new WidgetRuntimeError(
          'widget/invalid-direction',
          `Port "${message.port}" of "${message.instanceId}" is an output.`,
        );
      }
      if (!payloadMatches(port.type, message.payload)) {
        throw new WidgetRuntimeError(
          'widget/invalid-payload',
          `Payload for "${message.instanceId}.${message.port}" does not match ${port.type}.`,
        );
      }
      const simTime = requireTime(message.simTime, 'simTime');
      this.#pending.push({
        instanceId: message.instanceId,
        method: widgetDeliverMethod,
        args: [message.instanceId, message.port, message.payload, simTime],
      });
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  dispatch(instanceId: string, event: WidgetInputEvent): Promise<void> {
    try {
      if (this.#disposed) {
        throw new WidgetRuntimeError('widget/disposed', 'The widget runtime is disposed.');
      }
      this.#requireMounted(instanceId);
      if (
        typeof event !== 'object' ||
        event === null ||
        typeof event.type !== 'string' ||
        event.type === ''
      ) {
        throw new WidgetRuntimeError(
          'widget/invalid-payload',
          'A widget input event needs a nonempty type.',
        );
      }
      this.#pending.push({
        instanceId,
        method: widgetPointerMethod,
        args: [instanceId, event],
      });
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  step(context: IWidgetFrameContext): Promise<void> {
    return this.#run(async () => {
      this.#assertActive();
      const simTime = requireTime(context.simTime, 'simTime');
      const dt = requireTime(context.dt, 'dt');
      if (context.mode !== 'edit' && context.mode !== 'simulation') {
        throw new WidgetRuntimeError(
          'widget/invalid-step',
          `Unknown widget step mode: ${String(context.mode)}.`,
        );
      }

      await this.#configure();
      this.#assertActive();

      for (const call of this.#pending.splice(0)) {
        const record = this.#instances.get(call.instanceId);
        if (record === undefined || !record.mounted) {
          this.#report(
            'widget/deliver-failed',
            'deliver',
            `Queued ${call.method} for "${call.instanceId}" was dropped: the instance is not mounted.`,
            { instanceId: call.instanceId },
          );
          continue;
        }
        try {
          await this.#sandbox.call(call.method, ...call.args);
        } catch (error) {
          if (this.#disposed) {
            throw new WidgetRuntimeError(
              'widget/disposed',
              'Widget step was cancelled by runtime disposal.',
            );
          }
          this.#report(
            'widget/deliver-failed',
            'deliver',
            `Widget call "${call.method}" failed for "${call.instanceId}": ${describeError(error)}`,
            { instanceId: call.instanceId, widget: record.widget },
          );
        }
      }

      this.#simTime = simTime;
      try {
        await this.#sandbox.call(widgetStepMethod, { simTime, dt, mode: context.mode });
      } catch (error) {
        if (this.#disposed) {
          throw new WidgetRuntimeError(
            'widget/disposed',
            'Widget step was cancelled by runtime disposal.',
          );
        }
        this.#report('widget/step-failed', 'step', `Widget step failed: ${describeError(error)}`);
        throw new WidgetRuntimeError(
          'widget/sandbox-failed',
          `Widget step failed: ${describeError(error)}`,
          { cause: error },
        );
      }
    });
  }

  setBindings(
    instanceId: string,
    bindings: Readonly<Record<string, CanvasBindingTarget>>,
  ): Promise<void> {
    return this.#run(async () => {
      const normalized = normalizeBindings(bindings);
      requireId(instanceId);
      this.#assertActive();
      const record = this.#requireMounted(instanceId);
      await this.#call(
        widgetSetBindingsMethod,
        [instanceId, normalized],
        record,
        'widget/update-failed',
        'update',
      );
    });
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    this.#pending.length = 0;
    // Terminating now is what cancels a mount that is still waiting for the guest: its pending
    // calls reject, the operation cleans up its own record, and the queued shutdown then runs.
    const terminating = terminateSandbox(this.#sandbox);
    this.#disposal = this.#run(async () => {
      const records = [...this.#instances.values()];
      this.#instances.clear();
      for (const record of records) this.#closeRecord(record);
      for (const unsubscribe of this.#unsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // The sandbox may already be gone.
        }
      }
      this.#engine?.dispose();
      await terminating;
      this.#published.dispose();
      this.#rendered.dispose();
      this.#diagnostics.dispose();
    });
    return this.#disposal;
  }

  /** Runs one operation after the previous one, whether it resolved or rejected. */
  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new WidgetRuntimeError('widget/disposed', 'The widget runtime is disposed.');
    }
    if (this.#sandbox.state === 'terminated') {
      throw new WidgetRuntimeError('widget/sandbox-failed', 'The widget sandbox is terminated.');
    }
  }

  #assertOwnership(record: IRuntimeInstance): void {
    if (this.#disposed) {
      throw new WidgetRuntimeError(
        'widget/disposed',
        `Mount of widget instance "${record.instanceId}" was cancelled before it finished.`,
      );
    }
    if (this.#instances.get(record.instanceId) !== record) {
      throw new WidgetRuntimeError(
        'widget/unknown-instance',
        `Widget instance "${record.instanceId}" was replaced during mount.`,
      );
    }
  }

  #requireMounted(instanceId: string): IRuntimeInstance {
    const record = this.#instances.get(instanceId);
    if (record === undefined || !record.mounted) {
      throw new WidgetRuntimeError(
        'widget/unknown-instance',
        `Widget instance "${instanceId}" is not mounted.`,
      );
    }
    return record;
  }

  #configure(): Promise<boolean> {
    const existing = this.#configured;
    if (existing !== undefined) return existing;

    const pending = this.#sandbox
      .call(widgetConfigureMethod, {
        explicitStepping: true,
        directTopicService: 'simulation-runtime',
      })
      .then((result) => result === true)
      .catch((error: unknown) => {
        this.#configured = undefined;
        const message = `Widget guest configuration failed: ${describeError(error)}`;
        this.#report('widget/runtime-failed', 'runtime', message);
        throw new WidgetRuntimeError('widget/sandbox-failed', message, { cause: error });
      });
    this.#configured = pending;
    return pending;
  }

  async #openAudio(record: IRuntimeInstance): Promise<WidgetAudioMountInfo> {
    const engine = this.#engine;
    if (engine === undefined) return { state: 'unavailable' };
    const info = await engine.open(record.instanceId);
    if (info.session !== undefined) record.audioSession = info.session;
    return info;
  }

  async #call(
    method: string,
    args: readonly unknown[],
    record: IRuntimeInstance,
    code: IWidgetRuntimeDiagnosticCode,
    phase: IWidgetRuntimeDiagnosticPhase,
  ): Promise<void> {
    try {
      await this.#sandbox.call(method, ...args);
    } catch (error) {
      if (this.#disposed) {
        throw new WidgetRuntimeError(
          'widget/disposed',
          `Widget call "${method}" was cancelled by runtime disposal.`,
        );
      }
      this.#report(
        code,
        phase,
        `Widget call "${method}" failed for "${record.instanceId}": ${describeError(error)}`,
        { instanceId: record.instanceId, widget: record.widget },
      );
      throw new WidgetRuntimeError(
        'widget/sandbox-failed',
        `Widget call "${method}" failed for "${record.instanceId}": ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  #forget(record: IRuntimeInstance): void {
    if (this.#instances.get(record.instanceId) === record) {
      this.#instances.delete(record.instanceId);
    }
    this.#closeRecord(record);
  }

  #closeRecord(record: IRuntimeInstance): void {
    const bitmap = record.bitmap;
    record.bitmap = undefined;
    closeBitmap(bitmap);
  }

  async #releaseGuest(instanceId: string): Promise<void> {
    try {
      await this.#sandbox.call(widgetUnmountMethod, instanceId);
    } catch {
      // The guest never created the instance, or the sandbox is already gone.
    }
  }

  #onFrame(payload: unknown): void {
    const message = payload as Partial<WidgetFrameMessage> | null | undefined;
    if (message === null || typeof message !== 'object') return;
    const { instanceId, bitmap } = message;
    if (typeof instanceId !== 'string' || !isBitmap(bitmap)) return;
    if (this.#disposed) {
      closeBitmap(bitmap);
      return;
    }

    const record = this.#instances.get(instanceId);
    if (
      record === undefined ||
      (message.generation !== undefined && message.generation !== record.generation)
    ) {
      // A frame of an unmounted instance, or of the instance that used to own this id.
      closeBitmap(bitmap);
      return;
    }

    const width = frameNumber(message.width, record.width);
    const height = frameNumber(message.height, record.height);
    const dpr = frameNumber(message.dpr, record.dpr);
    const previous = record.bitmap;
    record.bitmap = bitmap;
    record.width = width;
    record.height = height;
    record.dpr = dpr;
    record.sequence += 1;
    closeBitmap(previous);

    this.#fire(this.#rendered, 'render', {
      instanceId,
      width,
      height,
      dpr,
      bitmap,
      sequence: record.sequence,
    });
  }

  #onPublish(payload: unknown): void {
    const message = payload as Partial<WidgetPublishMessage> | null | undefined;
    if (message === null || typeof message !== 'object') return;
    const { instanceId, port } = message;
    if (typeof instanceId !== 'string' || typeof port !== 'string') return;
    if (this.#disposed) return;

    const record = this.#instances.get(instanceId);
    if (record === undefined) {
      this.#report(
        'widget/publish-rejected',
        'publish',
        `Publish from unknown widget instance "${instanceId}" was dropped.`,
        { instanceId, port },
      );
      return;
    }
    const definitionPort = record.module.definition.ports[port];
    if (definitionPort === undefined) {
      this.#report(
        'widget/publish-rejected',
        'publish',
        `Widget "${instanceId}" published on unknown port "${port}".`,
        { instanceId, widget: record.widget, port },
      );
      return;
    }
    if (definitionPort.direction !== 'output') {
      this.#report(
        'widget/publish-rejected',
        'publish',
        `Widget "${instanceId}" published on input port "${port}".`,
        { instanceId, widget: record.widget, port },
      );
      return;
    }
    if (!payloadMatches(definitionPort.type, message.payload)) {
      this.#report(
        'widget/publish-rejected',
        'publish',
        `Publish on "${instanceId}.${port}" does not match ${definitionPort.type}.`,
        { instanceId, widget: record.widget, port },
      );
      return;
    }

    this.#fire(this.#published, 'publish', {
      instanceId,
      port,
      payload: message.payload,
      simTime: publishTime(message.simTime, this.#simTime),
      ...(message.direct === true ? { direct: true as const } : {}),
    });
  }

  #onError(payload: unknown): void {
    const message = payload as Partial<WidgetErrorMessage> | null | undefined;
    if (message === null || typeof message !== 'object') return;
    if (typeof message.instanceId !== 'string') return;
    // A mount failure travels back through the rejected `mount()` call instead.
    if (message.phase !== 'render' && message.phase !== 'deliver') return;

    const record = this.#instances.get(message.instanceId);
    const code: IWidgetRuntimeDiagnosticCode =
      message.phase === 'render' ? 'widget/render-failed' : 'widget/deliver-failed';
    const name = message.error?.name ?? 'Error';
    const text = message.error?.message ?? 'Unknown widget failure';
    this.#report(
      code,
      message.phase,
      `Widget "${message.instanceId}" failed during ${message.phase}: ${name}: ${text}`,
      {
        instanceId: message.instanceId,
        ...(record === undefined ? {} : { widget: record.widget }),
      },
    );
  }

  #onAssetFailed(payload: unknown): void {
    const message = payload as Partial<WidgetAssetFailedMessage> | null | undefined;
    if (message === null || typeof message !== 'object') return;
    if (typeof message.instanceId !== 'string') return;

    const src = typeof message.src === 'string' ? message.src : 'unknown';
    const name = message.error?.name ?? 'Error';
    const text = message.error?.message ?? 'Unknown asset failure';
    const record = this.#instances.get(message.instanceId);
    this.#report(
      'widget/asset-failed',
      'asset',
      `Widget "${message.instanceId}" could not read asset "${src}": ${name}: ${text}`,
      {
        instanceId: message.instanceId,
        ...(record === undefined ? {} : { widget: record.widget }),
      },
    );
  }

  #report(
    code: IWidgetRuntimeDiagnosticCode,
    phase: IWidgetRuntimeDiagnosticPhase,
    message: string,
    ids: {
      readonly instanceId?: string;
      readonly widget?: string;
      readonly port?: string;
    } = {},
  ): void {
    if (this.#disposed) return;
    const diagnostic: IWidgetRuntimeDiagnostic = {
      code,
      message,
      phase,
      ...(ids.instanceId === undefined ? {} : { instanceId: ids.instanceId }),
      ...(ids.widget === undefined ? {} : { widget: ids.widget }),
      ...(ids.port === undefined ? {} : { port: ids.port }),
    };
    this.#fire(this.#diagnostics, 'diagnostic', diagnostic);
  }

  /** Observer exceptions never break the instance flow a diagnostic or frame reports. */
  #fire<T>(emitter: Emitter<T>, label: string, value: T): void {
    try {
      emitter.fire(value);
    } catch (error) {
      console.error(`[@mica-js/widget] ${label} listener threw`, error);
    }
  }
}

function normalizePrepared(instance: IPreparedWidgetInstance): IPreparedWidgetInstance {
  if (typeof instance !== 'object' || instance === null) {
    throw new WidgetRuntimeError('widget/invalid-instance', 'A prepared widget is required.');
  }
  requireId(instance.instanceId);
  if (typeof instance.widget !== 'string' || !instance.widget.includes(':')) {
    throw new WidgetRuntimeError(
      'widget/invalid-instance',
      'A prepared widget needs a "<package>:<widget>" reference.',
    );
  }
  const module = instance.module;
  if (
    typeof module !== 'object' ||
    module === null ||
    typeof module.code !== 'string' ||
    typeof module.definition !== 'object' ||
    module.definition === null ||
    typeof module.definition.ports !== 'object' ||
    module.definition.ports === null
  ) {
    throw new WidgetRuntimeError(
      'widget/invalid-instance',
      `Widget "${instance.widget}" has no complete module.`,
    );
  }
  return {
    instanceId: instance.instanceId,
    widget: instance.widget,
    module,
    width: requireSize(instance.width, 'width'),
    height: requireSize(instance.height, 'height'),
    dpr: requireDpr(instance.dpr),
    ...(instance.properties === undefined ? {} : { properties: instance.properties }),
    ...(instance.assets === undefined ? {} : { assets: instance.assets }),
  };
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new WidgetRuntimeError(
      'widget/invalid-instance',
      'A widget instance id must be a nonempty string.',
    );
  }
  return value;
}

function requireSize(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new WidgetRuntimeError(
      'widget/invalid-instance',
      `${name}=${String(value)} must be a finite nonnegative number.`,
    );
  }
  return value;
}

function requireDpr(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new WidgetRuntimeError(
      'widget/invalid-instance',
      `dpr=${String(value)} must be a finite positive number.`,
    );
  }
  return value;
}

function requireTime(value: unknown, name: string): TimePs {
  try {
    return timePs(value as number);
  } catch (error) {
    throw new WidgetRuntimeError(
      'widget/invalid-time',
      `${name} must be a valid time in picoseconds: ${describeError(error)}`,
      { cause: error },
    );
  }
}

function publishTime(value: unknown, fallback: TimePs): TimePs {
  if (typeof value !== 'number') return fallback;
  try {
    return timePs(value);
  } catch {
    return fallback;
  }
}

function frameNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeBindings(
  value: Readonly<Record<string, CanvasBindingTarget>>,
): Readonly<Record<string, CanvasBindingTarget>> {
  if (typeof value !== 'object' || value === null) {
    throw new WidgetRuntimeError('widget/invalid-update', 'Bindings must be an object.');
  }
  const bindings: Record<string, CanvasBindingTarget> = {};
  for (const [port, target] of Object.entries(value)) {
    if (
      typeof target !== 'object' ||
      target === null ||
      typeof target.symbol !== 'string' ||
      target.symbol === '' ||
      typeof target.port !== 'string' ||
      target.port === ''
    ) {
      throw new WidgetRuntimeError(
        'widget/invalid-update',
        `Binding "${port}" needs a nonempty symbol and port.`,
      );
    }
    bindings[port] = { symbol: target.symbol, port: target.port };
  }
  return Object.freeze(bindings);
}

function splitRef(ref: string): { packageId: string; widgetId: string } | undefined {
  const separator = ref.indexOf(':');
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  return { packageId: ref.slice(0, separator), widgetId: ref.slice(separator + 1) };
}

function isBitmap(value: unknown): value is ImageBitmap {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ImageBitmap).close === 'function'
  );
}

function isVec2d(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as { readonly x?: unknown; readonly y?: unknown };
  return typeof point.x === 'number' && typeof point.y === 'number';
}

/** Mirrors the shared value model: a payload must match the declared port type exactly. */
function payloadMatches(type: PayloadType, payload: unknown): boolean {
  switch (type) {
    case 'boolean':
      return typeof payload === 'boolean';
    case 'number':
      return typeof payload === 'number';
    case 'string':
      return typeof payload === 'string';
    case 'bytes':
    case 'bytes<rgb565>':
    case 'bytes<segments>':
      return payload instanceof Uint8Array;
    case 'vec2d':
      return isVec2d(payload);
    case 'vec3d':
      return isVec2d(payload) && typeof (payload as { readonly z?: unknown }).z === 'number';
  }
}

function closeBitmap(bitmap: ImageBitmap | undefined): void {
  if (bitmap === undefined) return;
  try {
    bitmap.close();
  } catch {
    // Already detached.
  }
}

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // Already closed.
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' ? error : String(error);
}

async function terminateSandbox(sandbox: WidgetSandbox): Promise<void> {
  try {
    await sandbox.terminate('widget runtime disposed');
  } catch {
    // Already terminated.
  }
}
