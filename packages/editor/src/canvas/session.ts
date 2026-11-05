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

export interface ICanvasConfiguration {
  readonly uri: string;
  readonly projectRoot?: string;
  readonly voltageReferences?: Readonly<Record<string, number>>;
  readonly container: HTMLElement;
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
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  #disposal: Promise<void> | undefined;
  readonly #step = toTimePs(25, 'ms');

  constructor(
    @ICanvasConfiguration private readonly configuration: ICanvasConfiguration,
    @IFileSystemProvider private readonly files: IFileSystemProvider,
    @IDeviceLibraryResolver private readonly devices: IDeviceLibrary,
    @IWidgetLibraryResolver private readonly widgets: IWidgetLibrary,
    @ICanvasRuntimeFactory private readonly factory: ICanvasRuntimeFactory,
  ) {}

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
    this.#changes.fire();
    this.#schedule();
  }

  pause(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#changes.fire();
  }

  step(): Promise<void> {
    return this.#enqueue(() => this.#advance(this.#step));
  }

  dispatch(id: string, event: WidgetInputEvent): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#mode !== 'simulation') return;
      await this.#active?.runtimes.widgets.dispatch(id, event);
      if (!this.#running) await this.#advance(timePs(0));
    });
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.pause();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
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

  async #advance(dt: TimePs): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (this.#mode === 'simulation' && dt > 0) {
      const report = await active.runtimes.simulation.tick(dt);
      this.#assertAlive();
      this.#simTime = report.simTime;
    }
    await active.runtimes.widgets.step({ simTime: this.#simTime, dt, mode: this.#mode });
    this.#assertAlive();
  }

  #schedule(): void {
    if (this.#disposed || !this.#active || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#enqueue(() => this.#advance(this.#running ? this.#step : timePs(0))).then(
        () => this.#schedule(),
        (error) => {
          this.pause();
          if (!this.#disposed) this.#errors.fire(error);
        },
      );
    }, 25);
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
