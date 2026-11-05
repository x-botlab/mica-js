import type { ISimulationRuntime } from '@mica-js/simulator';
import type { IWidgetRuntime } from '@mica-js/widget';
import { createDecorator } from '../instantiation';

export interface ICanvasRuntimes {
  readonly simulation: ISimulationRuntime;
  readonly widgets: IWidgetRuntime;
  resumeAudio(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ICanvasRuntimeFactory {
  create(container: HTMLElement): Promise<ICanvasRuntimes>;
}
export const ICanvasRuntimeFactory = createDecorator<ICanvasRuntimeFactory>(
  'editor.canvasRuntimeFactory',
);

export class CanvasRuntimeFactory implements ICanvasRuntimeFactory {
  async create(container: HTMLElement): Promise<ICanvasRuntimes> {
    const [
      { createSimulationRuntimeFromWorker, createSimulationRuntimeGuestSandbox },
      { createWidgetHostGuestSandbox, createWidgetSandboxFromWorker, createWidgetRuntime },
    ] = await Promise.all([import('@mica-js/simulator/sandbox'), import('@mica-js/widget')]);
    const channel = new MessageChannel();
    let deviceWorker: ReturnType<typeof createSimulationRuntimeGuestSandbox> | undefined;
    let widgetWorker: ReturnType<typeof createWidgetHostGuestSandbox> | undefined;
    let simulation: ISimulationRuntime | undefined;
    let widgets: IWidgetRuntime | undefined;
    let audioContext: AudioContext | undefined;
    try {
      deviceWorker = createSimulationRuntimeGuestSandbox({ container });
      simulation = await createSimulationRuntimeFromWorker(deviceWorker, {
        topicPort: channel.port1,
      });
      widgetWorker = createWidgetHostGuestSandbox({ container });
      const sandbox = await createWidgetSandboxFromWorker(widgetWorker, {
        container,
        devicePort: channel.port2,
      });
      if (typeof globalThis.AudioContext === 'function') audioContext = new AudioContext();
      widgets = createWidgetRuntime(sandbox, {
        ...(audioContext === undefined ? {} : { audio: { context: audioContext } }),
      });
      widgets.audio.suspend();
      const ownedSimulation = simulation;
      const ownedWidgets = widgets;
      let disposal: Promise<void> | undefined;
      return {
        simulation,
        widgets,
        async resumeAudio() {
          if (!disposal && audioContext?.state === 'suspended') await audioContext.resume();
        },
        dispose() {
          return (disposal ??= Promise.allSettled([
            ownedWidgets.dispose(),
            ownedSimulation.dispose(),
            audioContext?.close(),
          ]).then((results) => {
            const errors = results
              .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
              .map((result) => result.reason as unknown);
            if (errors.length)
              throw new AggregateError(errors, 'Canvas runtimes failed to dispose.');
          }));
        },
      };
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      await Promise.allSettled([
        widgets?.dispose() ?? widgetWorker?.terminate('Canvas initialization failed'),
        simulation?.dispose() ?? deviceWorker?.terminate('Canvas initialization failed'),
        audioContext?.close(),
      ]);
      throw error;
    }
  }
}
