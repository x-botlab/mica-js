import { createRpc } from '@mica-js/core/rpc';
import type { RpcProxy } from '@mica-js/core/rpc';
import { WidgetAudioProcessor } from './processor';
import type { AudioContextLike, AudioNodeLike, AudioWorkletNodeLike } from './engine';
import { widgetAudioControlService, widgetAudioWorkletService } from '../../guest/audio/protocol';
import type {
  WidgetAudioControlService,
  WidgetAudioDiagnostic,
  WidgetAudioEndedMessage,
  WidgetAudioProgress,
  WidgetAudioWorkletService,
} from '../../guest/audio/protocol';

export const TEST_SAMPLE_RATE = 48000;

/** Lets pending RPC messages (macrotasks) settle. */
export async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export class FakeDestination implements AudioNodeLike {
  connections = 0;

  connect(): void {
    this.connections += 1;
  }

  disconnect(): void {
    this.connections -= 1;
  }
}

export class FakeAudioContext implements AudioContextLike {
  readonly sampleRate: number;
  readonly destination = new FakeDestination();
  state: string;
  moduleLoads = 0;
  /** Set to hold `addModule` open. */
  moduleReady: Promise<void> | undefined;
  readonly audioWorklet = {
    addModule: async (): Promise<void> => {
      this.moduleLoads += 1;
      if (this.moduleReady !== undefined) await this.moduleReady;
    },
  };
  readonly #stateListeners = new Set<() => void>();

  constructor(options: { sampleRate?: number; state?: string } = {}) {
    this.sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
    this.state = options.state ?? 'running';
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.#stateListeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.#stateListeners.delete(listener);
  }

  /** Simulates the browser suspending or resuming the context on its own. */
  setState(state: string): void {
    this.state = state;
    for (const listener of [...this.#stateListeners]) listener();
  }
}

/** Renders `frames` frames the way an `AudioWorkletProcessor` would be called. */
export function renderFrames(
  processor: WidgetAudioProcessor,
  frames = 128,
): { left: Float32Array; right: Float32Array } {
  const output = [[new Float32Array(frames), new Float32Array(frames)]];
  processor.process(output);
  return { left: output[0]![0]!, right: output[0]![1]! };
}

/** A worklet node whose host port drives a real processor; the engine still owns the host side. */
export interface WorkletNodeHarness {
  readonly processor: WidgetAudioProcessor;
  readonly node: AudioWorkletNodeLike;
  render(frames?: number): { left: Float32Array; right: Float32Array };
  dispose(): void;
}

export function createWorkletNode(options: { sampleRate?: number } = {}): WorkletNodeHarness {
  const channel = new MessageChannel();
  const processor = new WidgetAudioProcessor({
    sampleRate: options.sampleRate ?? TEST_SAMPLE_RATE,
  });
  processor.attachHostPort(channel.port1);
  const node: AudioWorkletNodeLike = {
    port: channel.port2,
    connect() {},
    disconnect() {},
  };
  return {
    processor,
    node,
    render: (frames = 128) => renderFrames(processor, frames),
    dispose: () => {
      processor.dispose();
      channel.port1.close();
    },
  };
}

/** One guest endpoint attached to the processor, with the events it received recorded. */
export interface GuestHarness {
  readonly proxy: RpcProxy<WidgetAudioWorkletService>;
  readonly progress: WidgetAudioProgress[];
  readonly ended: WidgetAudioEndedMessage[];
  dispose(): void;
}

/** Processor plus a host control proxy and a factory for guest endpoints; used by worklet tests. */
export interface ProcessorHarness {
  readonly processor: WidgetAudioProcessor;
  readonly control: RpcProxy<WidgetAudioControlService>;
  readonly diagnostics: WidgetAudioDiagnostic[];
  render(frames?: number): { left: Float32Array; right: Float32Array };
  guest(runtimeId: string): Promise<GuestHarness>;
  dispose(): void;
}

export function createProcessorHarness(options: { sampleRate?: number } = {}): ProcessorHarness {
  const channel = new MessageChannel();
  const processor = new WidgetAudioProcessor({
    sampleRate: options.sampleRate ?? TEST_SAMPLE_RATE,
  });
  processor.attachHostPort(channel.port1);
  const hostEndpoint = createRpc(channel.port2);
  const control = hostEndpoint.getProxy(widgetAudioControlService, {
    transfer: (member, args) => (member === 'attachGuestPort' ? [args[1] as MessagePort] : []),
  });
  const diagnostics: WidgetAudioDiagnostic[] = [];
  control.onDidDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  const guests: GuestHarness[] = [];

  return {
    processor,
    control,
    diagnostics,
    render: (frames = 128) => renderFrames(processor, frames),
    async guest(runtimeId: string): Promise<GuestHarness> {
      const guestChannel = new MessageChannel();
      await control.attachGuestPort(runtimeId, guestChannel.port1);
      const endpoint = createRpc(guestChannel.port2);
      const proxy = endpoint.getProxy(widgetAudioWorkletService, {
        transfer: (member, args) =>
          member === 'writeStream' && args[2] instanceof Float32Array
            ? [args[2].buffer]
            : member === 'writeStream' && args[2] instanceof Int16Array
              ? [args[2].buffer]
              : [],
      });
      const progress: WidgetAudioProgress[] = [];
      const ended: WidgetAudioEndedMessage[] = [];
      proxy.onDidProgress((entry) => progress.push(entry));
      proxy.onDidEnded((entry) => ended.push(entry));
      const guest: GuestHarness = {
        proxy,
        progress,
        ended,
        dispose: () => {
          endpoint.dispose();
          guestChannel.port2.close();
        },
      };
      guests.push(guest);
      return guest;
    },
    dispose: () => {
      for (const guest of guests) guest.dispose();
      processor.dispose();
      hostEndpoint.dispose();
      channel.port1.close();
    },
  };
}

export function makeSession(session: string, runtimeId: string) {
  return {
    session,
    runtimeId,
    instanceId: `instance-${session}`,
    maxVoices: 4,
    maxStreams: 2,
  };
}

export function makeStream(streamId: string, overrides: Record<string, unknown> = {}) {
  return {
    streamId,
    sampleRate: TEST_SAMPLE_RATE,
    channels: 1 as const,
    format: 'f32' as const,
    capacityFrames: 480,
    startFrames: 48,
    volume: 1,
    ...overrides,
  };
}
