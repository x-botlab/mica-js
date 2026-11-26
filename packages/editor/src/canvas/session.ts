import { timePs, toTimePs, type TimePs } from '@mica-js/core';
import { Emitter, type Event, type IDisposable } from '@mica-js/core/lifecycle';
import type { CanvasDocument } from '@mica-js/document/canvas';
import type { IWidgetFrame, WidgetInputEvent } from '@mica-js/widget';
import { createDecorator } from '../instantiation';
import { IDeviceLibraryResolver, IWidgetLibraryResolver } from '../libraries';
import { IFileSystemProvider } from '../provider-services';
import type { IDeviceLibrary, IWidgetLibrary } from '../providers';
import { prepareCanvasResources, canvasBindingReason, type ICanvasResources } from './resources';
import type { ICanvasBindingInfo } from '../canvas-host';
import { canvasSnapshot } from '../canvas-host';
import type { IEditorProperty } from '../host';
import { ICanvasRuntimeFactory, type ICanvasRuntimes } from './runtime-factory';

/** What started one canvas advance round. */
export type CanvasAdvanceTrigger = 'frame' | 'step' | 'dispatch';

/**
 * One completed canvas advance round.
 *
 * Automatic frames report scheduling fields. Manual steps and dispatch refreshes report the same
 * round-trip fields but consume no frame slot. A caller can separate cold start from steady state
 * with `sequence`, `idleMs`, `periodMs` and `skippedSlots`.
 */
export interface ICanvasAdvanceSample {
  /** 1-based observation order within the session. */
  readonly sequence: number;
  readonly trigger: CanvasAdvanceTrigger;
  /** Wall-clock start of the round, in milliseconds on the performance timeline. */
  readonly startedAt: number;
  /** Wall clock when the simulation tick settled; equals `startedAt` when no tick ran. */
  readonly tickCompletedAt: number;
  /** Wall clock when the widget step settled. */
  readonly completedAt: number;
  /** Simulation tick round trip in milliseconds; `undefined` when the round ran no tick. */
  readonly tickMs: number | undefined;
  /** Widget step round trip in milliseconds. */
  readonly widgetMs: number;
  /** Idle time between the previous round's completion and this round's start. */
  readonly idleMs: number | undefined;
  /** Time between the previous round's start and this round's start. */
  readonly periodMs: number | undefined;
  /** Whole frame periods this round started behind its target; zero for manual rounds. */
  readonly skippedSlots: number;
  /** Completed simulation time after the round. */
  readonly simTime: TimePs;
  /** Simulation step requested for the round; zero for paused frames and dispatch refreshes. */
  readonly dt: TimePs;
  readonly running: boolean;
  readonly mode: 'edit' | 'simulation';
  /** Configured frame period in milliseconds. */
  readonly frameMs: number;
}

/** Optional synchronous sink for browser-side scheduling measurement. */
export type ICanvasAdvanceObserver = (sample: ICanvasAdvanceSample) => void;

export interface ICanvasConfiguration {
  readonly uri: string;
  readonly projectRoot?: string;
  readonly stepMs?: number;
  readonly execution?: 'throughput' | 'precise';
  /** Forwarded to the prepared simulation; omitted uses the board default. */
  readonly batchExecution?: boolean;
  readonly voltageReferences?: Readonly<Record<string, number>>;
  readonly container: HTMLElement;
  /** Optional timing sink; omitted means no samples are built. */
  readonly observer?: ICanvasAdvanceObserver;
  /** Called synchronously before an advance round starts awaiting the tick. */
  readonly onAdvanceStart?: () => void;
  /** Called in `finally` after an advance round settles, including on failure. */
  readonly onAdvanceSettled?: () => void;
}
export const ICanvasConfiguration = createDecorator<ICanvasConfiguration>(
  'editor.canvasConfiguration',
);

interface IRunningCanvas {
  readonly runtimes: ICanvasRuntimes;
  readonly frames: Map<string, IWidgetFrame>;
  readonly subscriptions: IDisposable[];
}

export class CanvasSession {
  readonly #renders = new Emitter<void>();
  readonly onDidRender: Event<void> = this.#renders.event;
  readonly #changes = new Emitter<void>();
  readonly onDidChangeState = this.#changes.event;
  readonly #errors = new Emitter<unknown>();
  readonly onDidError = this.#errors.event;

  getProperties(instanceId: string, readOnly: boolean): readonly IEditorProperty[] {
    const resources = this.#resources;
    const instance = resources?.document.widgets.find((item) => item.id === instanceId);
    if (!resources || !instance) throw new Error(`Unknown widget instance "${instanceId}".`);
    const definitions = resources.widgets.get(instance.widget)!.definition.properties;
    return canvasSnapshot(
      Object.entries(definitions).map(([key, descriptor]) => ({
        ...descriptor,
        key,
        label: String(descriptor.label ?? descriptor.title ?? key),
        type: descriptor.type,
        defaultValue: descriptor.default,
        overrideValue: instance.properties?.[key],
        overridden: Object.hasOwn(instance.properties ?? {}, key),
        value: Object.hasOwn(instance.properties ?? {}, key)
          ? instance.properties?.[key]
          : descriptor.default,
        readOnly: readOnly || descriptor.readOnly === true,
      })),
    );
  }

  getBindings(instanceId: string): readonly ICanvasBindingInfo[] {
    const resources = this.#resources;
    const instance = resources?.document.widgets.find((item) => item.id === instanceId);
    if (!resources || !instance) throw new Error(`Unknown widget instance "${instanceId}".`);
    return canvasSnapshot(
      Object.entries(resources.widgets.get(instance.widget)!.definition.ports).map(
        ([port, descriptor]) => ({
          ...descriptor,
          port,
          target: instance.bindings?.[port] ?? null,
          candidates: resources.schematic.sheet.symbols.flatMap((symbol) => {
            const device = resources.devices.find((item) => item.id === symbol.device);
            return Object.keys(device?.definition.ports ?? {}).map((targetPort) => {
              const target = { symbol: symbol.id, port: targetPort };
              const reason = canvasBindingReason(resources, instanceId, port, target);
              return {
                target,
                label: `${symbol.designator ?? symbol.id} / ${device?.definition.displayName ?? symbol.device} / ${targetPort}`,
                compatible: reason === undefined,
                ...(reason === undefined ? {} : { reason }),
              };
            });
          }),
        }),
      ),
    );
  }
  #active: IRunningCanvas | undefined;
  #resources: ICanvasResources | undefined;
  #signature: string | undefined;
  #mode: 'edit' | 'simulation' = 'edit';
  #simTime = timePs(0);
  #running = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nextFrame: number | undefined;
  #advancing = false;
  #advanceSequence = 0;
  #lastStartedAt: number | undefined;
  #lastCompletedAt: number | undefined;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  #disposal: Promise<void> | undefined;
  readonly #frameMs: number;
  readonly #step: TimePs;
  readonly #unlockAudio = (): void => {
    const active = this.#active;
    if (this.#disposed || !this.#running || !active) return;
    void active.runtimes.resumeAudio().catch((error: unknown) => {
      if (!this.#disposed && this.#active === active) this.#errors.fire(error);
    });
  };

  constructor(
    @ICanvasConfiguration private readonly configuration: ICanvasConfiguration,
    @IFileSystemProvider private readonly files: IFileSystemProvider,
    @IDeviceLibraryResolver private readonly devices: IDeviceLibrary,
    @IWidgetLibraryResolver private readonly widgets: IWidgetLibrary,
    @ICanvasRuntimeFactory private readonly factory: ICanvasRuntimeFactory,
  ) {
    this.#frameMs = configuration.stepMs ?? 20;
    if (!Number.isFinite(this.#frameMs) || this.#frameMs <= 0)
      throw new Error('stepMs must be a positive finite number.');
    this.#step = toTimePs(this.#frameMs, 'ms');
    if (this.#step <= 0) throw new Error('stepMs must represent at least one picosecond.');
    configuration.container.addEventListener('pointerdown', this.#unlockAudio, true);
    configuration.container.addEventListener('keydown', this.#unlockAudio, true);
  }

  get mode() {
    return this.#mode;
  }
  get status() {
    return { mode: this.#mode, running: this.#running, simTime: this.#simTime };
  }
  getFrame(id: string): IWidgetFrame | undefined {
    return this.#active?.frames.get(id);
  }

  synchronize(document: CanvasDocument): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#resources && this.#mode !== 'edit')
        throw new Error('Switch to edit mode before changing the canvas.');
      const prepared = await prepareCanvasResources(
        document,
        this.configuration.uri,
        this.files,
        this.devices,
        this.widgets,
        this.configuration.projectRoot,
      );
      this.#assertAlive();
      const signature = JSON.stringify({
        schematic: prepared.schematic,
        voltageReferences: this.configuration.voltageReferences,
        devices: prepared.devices,
        widgets: document.widgets.map((instance) => ({
          id: instance.id,
          widget: instance.widget,
          width: instance.width,
          height: instance.height,
          properties: instance.properties,
          bindings: instance.bindings,
        })),
        modules: [...prepared.widgets],
        assets: [...prepared.assets].map(([id, values]) => [
          id,
          Object.entries(values).map(([key, bytes]) => [key, Array.from(bytes)]),
        ]),
        simulationAssets: Object.entries(prepared.simulationAssets).map(([id, values]) => [
          id,
          Object.entries(values).map(([key, bytes]) => [key, Array.from(bytes)]),
        ]),
      });
      if (signature !== this.#signature) await this.#replace(prepared);
      this.#assertAlive();
      this.#signature = signature;
      this.#resources = prepared;
    });
  }

  setMode(mode: 'edit' | 'simulation'): Promise<void> {
    return this.#enqueue(async () => {
      if (mode !== 'edit' && mode !== 'simulation') throw new TypeError('Invalid canvas mode.');
      if (mode === this.#mode) return;
      this.pause();
      const previous = this.#mode;
      this.#mode = mode;
      try {
        if (this.#resources) await this.#replace(this.#resources);
      } catch (error) {
        this.#mode = previous;
        throw error;
      }
      this.#changes.fire();
    });
  }

  reset(): Promise<void> {
    return this.#enqueue(async () => {
      this.pause();
      if (this.#resources) await this.#replace(this.#resources);
    });
  }

  run(): void {
    this.#assertAlive();
    if (this.#mode !== 'simulation') throw new Error('Switch to simulation mode before running.');
    if (this.#running) return;
    this.#running = true;
    this.#active?.runtimes.widgets.audio.resume();
    this.#unlockAudio();
    this.#changes.fire();
    this.#schedule();
  }

  pause(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#active?.runtimes.widgets.audio.suspend();
    this.#changes.fire();
  }

  step(): Promise<void> {
    return this.#enqueue(() => this.#advance(this.#step, 'step'));
  }

  dispatch(id: string, event: WidgetInputEvent): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#mode !== 'simulation') return;
      await this.#active?.runtimes.widgets.dispatch(id, event);
      if (!this.#running) await this.#advance(timePs(0), 'dispatch');
    });
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.configuration.container.removeEventListener('pointerdown', this.#unlockAudio, true);
    this.configuration.container.removeEventListener('keydown', this.#unlockAudio, true);
    this.pause();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#nextFrame = undefined;
    this.#disposal = this.#queue.then(async () => {
      const active = this.#active;
      this.#active = undefined;
      this.#resources = undefined;
      try {
        if (active) await this.#release(active);
      } finally {
        this.#renders.dispose();
        this.#changes.dispose();
        this.#errors.dispose();
      }
    });
    return this.#disposal;
  }

  async #replace(resources: ICanvasResources): Promise<void> {
    const runtimes = await this.factory.create(this.configuration.container);
    const candidate: IRunningCanvas = { runtimes, frames: new Map(), subscriptions: [] };
    candidate.subscriptions.push(
      runtimes.widgets.onDidRender((frame) => {
        candidate.frames.set(frame.instanceId, frame);
        if (this.#active === candidate) this.#renders.fire();
      }),
    );
    const report = (error: unknown) => {
      if (this.#active === candidate && !this.#disposed) this.#errors.fire(error);
    };
    const widgetErrors = runtimes.widgets.onDidDiagnostic?.(report);
    const simulationErrors = runtimes.simulation.onDidDiagnostic?.(report);
    if (widgetErrors) candidate.subscriptions.push(widgetErrors);
    if (simulationErrors) candidate.subscriptions.push(simulationErrors);
    try {
      this.#assertAlive();
      await runtimes.simulation.load({
        schematic: resources.schematic,
        ...(this.configuration.execution === undefined
          ? {}
          : { execution: this.configuration.execution }),
        ...(this.configuration.batchExecution === undefined
          ? {}
          : { batchExecution: this.configuration.batchExecution }),
        ...(this.configuration.voltageReferences === undefined
          ? {}
          : { voltageReferences: this.configuration.voltageReferences }),
        devices: resources.devices,
        assets: structuredClone(resources.simulationAssets),
      });
      this.#assertAlive();
      for (const instance of resources.document.widgets) {
        await runtimes.widgets.mount({
          instanceId: instance.id,
          widget: instance.widget,
          module: resources.widgets.get(instance.widget)!,
          width: instance.width,
          height: instance.height,
          dpr: globalThis.devicePixelRatio || 1,
          ...(instance.properties === undefined ? {} : { properties: instance.properties }),
          assets: structuredClone(resources.assets.get(instance.id) ?? {}),
        });
        await runtimes.widgets.setBindings(instance.id, instance.bindings ?? {});
        this.#assertAlive();
      }
      await runtimes.widgets.step({ simTime: timePs(0), dt: timePs(0), mode: this.#mode });
      this.#assertAlive();
    } catch (error) {
      await this.#release(candidate).catch(() => undefined);
      throw error;
    }
    const previous = this.#active;
    this.#active = candidate;
    this.#simTime = timePs(0);
    this.#renders.fire();
    if (previous) await this.#release(previous).catch((error) => this.#errors.fire(error));
    this.#schedule();
  }

  async #advance(
    dt: TimePs,
    trigger: CanvasAdvanceTrigger,
    frame?: { readonly target: number },
  ): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#notifyAdvance('onAdvanceStart');
    try {
      const observer = this.configuration.observer;
      const running = this.#running;
      const startedAt = observer === undefined ? 0 : performance.now();
      const skippedSlots =
        frame === undefined || observer === undefined
          ? 0
          : Math.max(0, Math.floor((startedAt - frame.target) / this.#frameMs));
      let tickStartedAt: number | undefined;
      let tickCompletedAt = startedAt;
      if (this.#mode === 'simulation' && dt > 0) {
        if (observer !== undefined) tickStartedAt = performance.now();
        const report = await active.runtimes.simulation.tick(dt);
        if (observer !== undefined) tickCompletedAt = performance.now();
        this.#assertAlive();
        this.#simTime = report.simTime;
      }
      const widgetStartedAt = observer === undefined ? 0 : performance.now();
      await active.runtimes.widgets.step({ simTime: this.#simTime, dt, mode: this.#mode });
      const completedAt = observer === undefined ? 0 : performance.now();
      this.#assertAlive();
      if (observer !== undefined && !this.#disposed)
        this.#observe(observer, {
          trigger,
          startedAt,
          tickStartedAt,
          tickCompletedAt,
          widgetStartedAt,
          completedAt,
          skippedSlots,
          dt,
          running,
        });
    } finally {
      this.#notifyAdvance('onAdvanceSettled');
    }
  }

  #notifyAdvance(hook: 'onAdvanceStart' | 'onAdvanceSettled'): void {
    try {
      this.configuration[hook]?.();
    } catch (error) {
      if (!this.#disposed) this.#errors.fire(error);
    }
  }

  #observe(
    observer: ICanvasAdvanceObserver,
    details: {
      readonly trigger: CanvasAdvanceTrigger;
      readonly startedAt: number;
      readonly tickStartedAt: number | undefined;
      readonly tickCompletedAt: number;
      readonly widgetStartedAt: number;
      readonly completedAt: number;
      readonly skippedSlots: number;
      readonly dt: TimePs;
      readonly running: boolean;
    },
  ): void {
    const idleMs =
      this.#lastCompletedAt === undefined ? undefined : details.startedAt - this.#lastCompletedAt;
    const periodMs =
      this.#lastStartedAt === undefined ? undefined : details.startedAt - this.#lastStartedAt;
    this.#lastStartedAt = details.startedAt;
    this.#lastCompletedAt = details.completedAt;
    this.#advanceSequence += 1;
    try {
      observer({
        sequence: this.#advanceSequence,
        trigger: details.trigger,
        startedAt: details.startedAt,
        tickCompletedAt: details.tickCompletedAt,
        completedAt: details.completedAt,
        tickMs:
          details.tickStartedAt === undefined
            ? undefined
            : details.tickCompletedAt - details.tickStartedAt,
        widgetMs: details.completedAt - details.widgetStartedAt,
        idleMs,
        periodMs,
        skippedSlots: details.skippedSlots,
        simTime: this.#simTime,
        dt: details.dt,
        running: details.running,
        mode: this.#mode,
        frameMs: this.#frameMs,
      });
    } catch (error) {
      if (!this.#disposed) this.#errors.fire(error);
    }
  }

  #schedule(): void {
    if (this.#disposed || !this.#active || this.#timer !== undefined || this.#advancing) return;
    const now = performance.now();
    this.#nextFrame ??= now + this.#frameMs;
    // A late deadline stays late: the next round starts immediately after yielding to the event
    // loop instead of idling until an aligned slot, and one round is in flight per slot.
    this.#timer = setTimeout(() => this.#onFrame(), Math.max(0, this.#nextFrame - now));
  }

  #onFrame(): void {
    this.#timer = undefined;
    if (this.#disposed || !this.#active) return;
    const wakeAt = performance.now();
    const target = this.#nextFrame ?? wakeAt;
    this.#nextFrame = wakeAt + this.#frameMs;
    this.#advancing = true;
    void this.#enqueue(() =>
      this.#advance(this.#running ? this.#step : timePs(0), 'frame', { target }),
    ).then(
      () => {
        this.#advancing = false;
        this.#schedule();
      },
      (error) => {
        this.#advancing = false;
        this.#nextFrame = undefined;
        this.pause();
        if (!this.#disposed) this.#errors.fire(error);
      },
    );
  }

  async #release(active: IRunningCanvas): Promise<void> {
    for (const subscription of active.subscriptions) subscription.dispose();
    active.frames.clear();
    await active.runtimes.dispose();
  }

  #enqueue(run: () => void | Promise<void>): Promise<void> {
    const result = this.#queue.then(async () => {
      this.#assertAlive();
      await run();
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }
  #assertAlive(): void {
    if (this.#disposed) throw new Error('Canvas session is disposed.');
  }
}
export type ICanvasSession = CanvasSession;
export const ICanvasSession = createDecorator<ICanvasSession>('editor.canvasSession');
