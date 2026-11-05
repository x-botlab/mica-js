import { runInNewContext } from 'node:vm';
import { timePs } from '@mica-js/core';
import { createRpc } from '@mica-js/core/rpc';
import { describe, expect, it, vi } from 'vitest';
import { simulationRuntimeGuestScript } from '../sandbox';
import { simulationRuntimeService, simulationRuntimeTopicService } from './rpc';
import { message, SYMBOL } from './test-helpers';

/** Runs the actual bundled classic-worker bootstrap with real MessagePorts. */
describe('standalone simulation sandbox guest', () => {
  it('boots its own prepared runtime and direct topic service without a legacy host', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    runInNewContext(
      simulationRuntimeGuestScript,
      {
        addEventListener,
        removeEventListener,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        structuredClone,
      },
      { timeout: 5_000 },
    );
    expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    const start = addEventListener.mock.calls[0]![1] as (event: {
      ports: readonly MessagePort[];
    }) => void;
    start({ ports: [] });
    expect(removeEventListener).not.toHaveBeenCalled();
    const primary = new MessageChannel();
    const topic = new MessageChannel();
    const rpc = createRpc(primary.port1);
    const topics = createRpc(topic.port1);
    try {
      start({ ports: [primary.port2, topic.port2] });
      expect(removeEventListener).toHaveBeenCalledWith('message', start);
      const api = rpc.getProxy(simulationRuntimeService);
      const direct = topics.getProxy(simulationRuntimeTopicService);
      await api.load({
        schematic: { version: 1, sheet: { symbols: [], wires: [], junctions: [] } },
        devices: [],
      });
      expect(await api.tick(timePs(3))).toEqual({ simTime: 3, executed: 1 });
      await expect(direct.deliver(message(SYMBOL, 'lamp', true))).rejects.toThrow('Unknown input');
      await api.reset();
      expect(await api.tick(timePs(2))).toEqual({ simTime: 2, executed: 1 });
      await api.dispose();
    } finally {
      topics.dispose();
      rpc.dispose();
      primary.port1.close();
      primary.port2.close();
      topic.port1.close();
      topic.port2.close();
    }
  });
});
