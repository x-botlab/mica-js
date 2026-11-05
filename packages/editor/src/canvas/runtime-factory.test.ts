import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasRuntimeFactory } from './runtime-factory';

const mocks = vi.hoisted(() => ({
  deviceWorker: vi.fn(),
  simulation: vi.fn(),
  widgetWorker: vi.fn(),
  sandbox: vi.fn(),
  widgets: vi.fn(),
}));
vi.mock('@mica-js/simulator/sandbox', () => ({
  createSimulationRuntimeGuestSandbox: mocks.deviceWorker,
  createSimulationRuntimeFromWorker: mocks.simulation,
}));
vi.mock('@mica-js/widget', () => ({
  createWidgetHostGuestSandbox: mocks.widgetWorker,
  createWidgetSandboxFromWorker: mocks.sandbox,
  createWidgetRuntime: mocks.widgets,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deviceWorker.mockReturnValue({ terminate: vi.fn(async () => {}) });
  mocks.simulation.mockResolvedValue({ dispose: vi.fn(async () => {}) });
  mocks.widgetWorker.mockReturnValue({ terminate: vi.fn(async () => {}) });
  mocks.sandbox.mockResolvedValue({ terminate: vi.fn(async () => {}) });
  mocks.widgets.mockReturnValue({
    dispose: vi.fn(async () => {}),
    audio: { suspend: vi.fn(), resume: vi.fn() },
  });
  vi.stubGlobal('AudioContext', undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('canvas sandbox composition', () => {
  function mockAudio() {
    const context = {
      state: 'suspended',
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const constructor = vi.fn(function () {
      return context;
    });
    vi.stubGlobal('AudioContext', constructor);
    return { context, constructor };
  }

  it('owns audio, starts suspended and closes the context exactly once', async () => {
    const { context, constructor } = mockAudio();
    const runtimes = await new CanvasRuntimeFactory().create({} as HTMLElement);
    expect(constructor).toHaveBeenCalledOnce();
    expect(mocks.widgets).toHaveBeenCalledWith(expect.anything(), { audio: { context } });
    expect(runtimes.widgets.audio.suspend).toHaveBeenCalledOnce();
    await runtimes.resumeAudio();
    expect(context.resume).toHaveBeenCalledOnce();
    context.state = 'running';
    await runtimes.resumeAudio();
    expect(context.resume).toHaveBeenCalledOnce();
    await runtimes.dispose();
    await runtimes.dispose();
    expect(context.close).toHaveBeenCalledOnce();
    context.state = 'suspended';
    await runtimes.resumeAudio();
    expect(context.resume).toHaveBeenCalledOnce();
  });

  it('works without Web Audio', async () => {
    const runtimes = await new CanvasRuntimeFactory().create({} as HTMLElement);
    expect(mocks.widgets).toHaveBeenCalledWith(expect.anything(), {});
    await expect(runtimes.resumeAudio()).resolves.toBeUndefined();
    await runtimes.dispose();
  });

  it('closes audio on initialization failure', async () => {
    const { context } = mockAudio();
    mocks.widgets.mockImplementationOnce(() => {
      throw new Error('runtime failed');
    });
    await expect(new CanvasRuntimeFactory().create({} as HTMLElement)).rejects.toThrow(
      'runtime failed',
    );
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('wires a direct topic port and owns both runtimes through idempotent cleanup', async () => {
    const container = {} as HTMLElement;
    const runtimes = await new CanvasRuntimeFactory().create(container);
    expect(mocks.deviceWorker).toHaveBeenCalledExactlyOnceWith({ container });
    expect(mocks.widgetWorker).toHaveBeenCalledExactlyOnceWith({ container });
    const devicePort = mocks.simulation.mock.calls[0]![1].topicPort as MessagePort;
    const widgetPort = mocks.sandbox.mock.calls[0]![1].devicePort as MessagePort;
    expect(devicePort).toBeInstanceOf(MessagePort);
    expect(widgetPort).toBeInstanceOf(MessagePort);
    expect(devicePort).not.toBe(widgetPort);
    const closing = runtimes.dispose();
    expect(runtimes.dispose()).toBe(closing);
    await closing;
    expect(runtimes.widgets.dispose).toHaveBeenCalledOnce();
    expect(runtimes.simulation.dispose).toHaveBeenCalledOnce();
    devicePort.close();
    widgetPort.close();
  });

  it('releases the simulation and worker when widget startup rejects', async () => {
    mocks.sandbox.mockRejectedValueOnce(new Error('worker failed'));
    await expect(new CanvasRuntimeFactory().create({} as HTMLElement)).rejects.toThrow(
      'worker failed',
    );
    expect((await mocks.simulation.mock.results[0]!.value).dispose).toHaveBeenCalledOnce();
    expect(mocks.widgetWorker.mock.results[0]!.value.terminate).toHaveBeenCalledOnce();
  });

  it('cleans up initialized resources when the next worker constructor throws', async () => {
    mocks.widgetWorker.mockImplementationOnce(() => {
      throw new Error('unsupported browser');
    });
    await expect(new CanvasRuntimeFactory().create({} as HTMLElement)).rejects.toThrow(
      'unsupported browser',
    );
    expect((await mocks.simulation.mock.results[0]!.value).dispose).toHaveBeenCalledOnce();
  });
});
