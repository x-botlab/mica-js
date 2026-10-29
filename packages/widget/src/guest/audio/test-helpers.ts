import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import { widgetAudioWorkletService } from './protocol';
import type {
  WidgetAudioEndedMessage,
  WidgetAudioProgress,
  WidgetAudioStreamInit,
  WidgetAudioStreamOpened,
  WidgetAudioToneInit,
  WidgetAudioToneSettings,
  WidgetAudioWorkletService,
} from './protocol';

/** Lets pending RPC messages (macrotasks) settle. */
export async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export interface WorkletCall {
  readonly member: string;
  readonly args: readonly unknown[];
}

/** Guest-side view of a fake worklet: the contract, plus recorded calls and injected events. */
export interface FakeWorklet {
  readonly port: MessagePort;
  readonly calls: WorkletCall[];
  readonly samples: (Int16Array | Float32Array)[];
  /** Set to make `writeStream` refuse blocks. */
  acceptWrites: boolean;
  /** Set to make `createStream` refuse the stream. */
  acceptStreams: boolean;
  receivesProgress(progress: WidgetAudioProgress): void;
  receivesEnded(ended: WidgetAudioEndedMessage): void;
  callsOf(member: string): WorkletCall[];
  dispose(): void;
}

export function createFakeWorklet(): FakeWorklet {
  const channel = new MessageChannel();
  const endpoint: RpcEndpoint = createRpc(channel.port1);
  const calls: WorkletCall[] = [];
  const samples: (Int16Array | Float32Array)[] = [];
  const progressListeners = new Set<(progress: WidgetAudioProgress) => void>();
  const endedListeners = new Set<(ended: WidgetAudioEndedMessage) => void>();

  const worklet: FakeWorklet = {
    port: channel.port2,
    calls,
    samples,
    acceptWrites: true,
    acceptStreams: true,
    receivesProgress(progress) {
      for (const listener of [...progressListeners]) listener(progress);
    },
    receivesEnded(ended) {
      for (const listener of [...endedListeners]) listener(ended);
    },
    callsOf(member) {
      return calls.filter((call) => call.member === member);
    },
    dispose() {
      endpoint.dispose();
      channel.port1.close();
    },
  };

  const service: WidgetAudioWorkletService = {
    createTone(session: string, init: WidgetAudioToneInit): void {
      calls.push({ member: 'createTone', args: [session, init] });
    },
    setTone(session: string, voiceId: string, settings: WidgetAudioToneSettings): void {
      calls.push({ member: 'setTone', args: [session, voiceId, settings] });
    },
    stopTone(session: string, voiceId: string, options: { fadeMs: number }): void {
      calls.push({ member: 'stopTone', args: [session, voiceId, options] });
    },
    createStream(session: string, init: WidgetAudioStreamInit): WidgetAudioStreamOpened {
      calls.push({ member: 'createStream', args: [session, init] });
      return { accepted: worklet.acceptStreams };
    },
    writeStream(session: string, streamId: string, block: Int16Array | Float32Array): boolean {
      calls.push({ member: 'writeStream', args: [session, streamId, block.length] });
      samples.push(block);
      return worklet.acceptWrites;
    },
    clearStream(session: string, streamId: string): void {
      calls.push({ member: 'clearStream', args: [session, streamId] });
    },
    endStream(session: string, streamId: string): void {
      calls.push({ member: 'endStream', args: [session, streamId] });
    },
    closeStream(session: string, streamId: string): void {
      calls.push({ member: 'closeStream', args: [session, streamId] });
    },
    onDidProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    onDidEnded(listener) {
      endedListeners.add(listener);
      return () => endedListeners.delete(listener);
    },
  };

  endpoint.register(widgetAudioWorkletService, service);
  return worklet;
}
