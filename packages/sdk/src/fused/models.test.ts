import { timePs } from '@mica-js/core';
import { Emitter } from '@mica-js/core/lifecycle';
import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type { DeviceContext, ProcessBatchRegistration, TopicMessage } from '@mica-js/simulator';
import { describe, expect, it, vi } from 'vitest';
import { ModelBinding } from './models.js';

function fakeContext(registerProcessBatch: (registration: ProcessBatchRegistration) => Disposable) {
  const topics = new Emitter<TopicMessage>();
  const context: DeviceContext = {
    props: Object.freeze({}),
    inputs: Object.freeze({}),
    memory: Object.freeze({}),
    topics: Object.freeze({
      onDidReceive: topics.event as Event<TopicMessage>,
      publish() {},
    }),
    reportError() {},
    registerProcessBatch,
    attachJit: () => ({ dispose() {} }),
    loadBytes() {},
  };
  return { context, topics };
}

describe('fused ModelBinding context', () => {
  it('forwards registerProcessBatch to the simulator device context', () => {
    const registration: ProcessBatchRegistration = {
      process: { kind: 'start', index: 0 },
      loop: 0,
      stopBefore: 'deadline',
    };
    const released = vi.fn();
    const { context, topics } = fakeContext((received) => {
      expect(received).toBe(registration);
      return { dispose: released };
    });
    const binding = new ModelBinding({
      instanceId: 'probe',
      methods: { ping: { params: { type: 'null' }, returns: { type: 'null' } } },
      events: {},
      types: {},
      props: {},
      factory: (model) => {
        const subscription = model.registerProcessBatch(registration);
        return {
          methods: {
            ping() {
              subscription.dispose();
              return null;
            },
          },
          sync() {},
          dispose() {},
        };
      },
      report: () => {},
      blocked: () => undefined,
      now: () => timePs(0),
    });
    try {
      binding.create(context);
      expect(binding.invoke('ping', null)).toBeNull();
      expect(released).toHaveBeenCalledOnce();
      expect(topics.event).toBeDefined();
    } finally {
      binding.invalidate();
      topics.dispose();
    }
  });
});
