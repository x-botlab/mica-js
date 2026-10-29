import type { WidgetAudioState } from '../../guest/audio/protocol';
import type { WidgetAudioControls } from './types';

/**
 * Controls of a host that was created without `audio`.
 *
 * The state is `unavailable` and every setter is a no-op, so callers never have to branch on
 * whether audio is configured.
 */
export const NO_AUDIO_CONTROLS: WidgetAudioControls = {
  state: 'unavailable' as WidgetAudioState,
  setMuted(): void {},
  setInstanceVolume(): void {},
  suspend(): void {},
  resume(): void {},
};
