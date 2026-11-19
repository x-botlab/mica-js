import { createRpc } from '@mica-js/core/rpc';
import { describe, expect, it, vi } from 'vitest';
import { connectFusedAudio } from './audio';

function fixture(setAudioState: () => Promise<void>) {
  const channel = new MessageChannel();
  const rpc = createRpc(channel.port1);
  const report = vi.fn();
  const audio = connectFusedAudio(
    rpc,
    {
      setAudioState,
      attachAudio: async (port) => {
        port.close();
      },
    },
    {
      context: new AudioContextStub() as unknown as AudioContext,
    },
    report,
  );
  return {
    audio,
    report,
    dispose() {
      audio.dispose();
      rpc.dispose();
      channel.port2.close();
    },
  };
}

class AudioContextStub {
  readonly state = 'suspended';
  readonly sampleRate = 48000;
  readonly destination = { connect() {} };
}

describe('audio bridge diagnostics', () => {
  it('reports a failed state delivery instead of silently hiding it', async () => {
    const test = fixture(async () => {
      throw new Error('display disconnected');
    });
    try {
      await Promise.resolve();
      expect(test.report).toHaveBeenCalledOnce();
      expect(test.report).toHaveBeenCalledWith({
        code: 'audio/failed',
        message: 'Audio bridge setAudioState failed: Error: display disconnected',
      });
    } finally {
      test.dispose();
    }
  });

  it('ignores a state delivery rejection that arrives after disposal', async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const test = fixture(() => pending);
    test.dispose();
    reject(new Error('endpoint disposed'));
    await Promise.resolve();
    expect(test.report).not.toHaveBeenCalled();
  });
});
