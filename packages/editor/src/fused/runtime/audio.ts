import type { Event } from '@mica-js/core/lifecycle';
import type {
  WidgetAudioApi,
  WidgetAudioStream,
  WidgetAudioState,
  WidgetAudioStreamStatus,
} from '@mica-js/widget/audio-guest';

export type {
  WidgetAudioOptions as IFusedAudioOptions,
  WidgetAudioControls as IFusedAudioControls,
} from '@mica-js/widget/audio-host';
export type {
  WidgetAudioState as FusedAudioState,
  WidgetAudioTone as IFusedAudioTone,
  WidgetAudioToneOptions as IFusedAudioToneOptions,
  WidgetAudioStreamOptions as IFusedAudioStreamOptions,
} from '@mica-js/widget/audio-guest';

export interface IFusedAudioStream extends Omit<WidgetAudioStream, 'onDrain' | 'onStatus'> {
  readonly onDidDrain: Event<void>;
  readonly onDidChangeStatus: Event<WidgetAudioStreamStatus>;
}

/** Audio handles belong to one instance generation, including while its body is hidden. */
export interface IFusedAudio extends Omit<WidgetAudioApi, 'onStateChange' | 'createStream'> {
  readonly onDidChangeState: Event<WidgetAudioState>;
  createStream(options: Parameters<WidgetAudioApi['createStream']>[0]): IFusedAudioStream;
}

/** Adapt the shared audio implementation's subscriptions to the editor lifecycle convention. */
export function fusedAudio(api: WidgetAudioApi): IFusedAudio {
  return {
    get state() {
      return api.state;
    },
    onDidChangeState: (listener) => ({ dispose: api.onStateChange(listener) }),
    tone: (options) => api.tone(options),
    createStream(options) {
      const stream = api.createStream(options);
      return Object.assign(stream, {
        onDidDrain: ((listener) => ({ dispose: stream.onDrain(() => listener()) })) as Event<void>,
        onDidChangeStatus: ((listener) => ({
          dispose: stream.onStatus(listener),
        })) as Event<WidgetAudioStreamStatus>,
      });
    },
  };
}
