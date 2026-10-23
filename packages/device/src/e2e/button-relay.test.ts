import { describe, expect, it } from 'vitest';
import {
  ElectricalConflictError,
  SchedulerError,
  createPowerRuntime,
  createScheduler,
  type TopologyPinRef,
} from '@mica-js/core';
import { DeviceError, createDeviceInstance, loadDeviceModule } from '../index';
import type { DeviceInstance } from '../index';
import {
  BUTTON_DEVICE_ID,
  RELAY_DEVICE_ID,
  circuit,
  createRig,
  exampleProvider,
  pinState,
  readExampleDescription,
  withRig,
  type Rig,
} from './test-helpers';

const NO1: TopologyPinRef = { instanceId: 'board', pinName: 'NO1' };
const NC1: TopologyPinRef = { instanceId: 'board', pinName: 'NC1' };
const NO2: TopologyPinRef = { instanceId: 'board', pinName: 'NO2' };
const NC2: TopologyPinRef = { instanceId: 'board', pinName: 'NC2' };
const IN1: TopologyPinRef = { instanceId: 'k1', pinName: 'IN' };

function relayPatch(instanceId: string, energized: boolean) {
  return {
    instanceId,
    connections: [
      { connectionId: 'normallyOpen', state: energized ? 'closed' : 'open' },
      { connectionId: 'normallyClosed', state: energized ? 'open' : 'closed' },
    ],
  };
}

function contactPatch(instanceId: string, closed: boolean) {
  return {
    instanceId,
    connections: [{ connectionId: 'contact', state: closed ? 'closed' : 'open' }],
  };
}

function expectIdle(rig: Rig, channel = '1'): void {
  expect(rig.connection(`sw${channel}`, 'contact')).toBe('open');
  expect(rig.connection(`k${channel}`, 'normallyOpen')).toBe('open');
  expect(rig.connection(`k${channel}`, 'normallyClosed')).toBe('closed');
  expect(rig.voltage({ instanceId: 'board', pinName: `NO${channel}` })).toBe(0);
  expect(rig.voltage({ instanceId: 'board', pinName: `NC${channel}` })).toBe(5);
}

function button(rig: Rig, instanceId = 'sw1'): DeviceInstance {
  const instance = rig.buttons.get(instanceId);
  if (instance === undefined) {
    throw new Error(`Missing button instance ${instanceId}`);
  }
  return instance;
}

function relay(rig: Rig, instanceId = 'k1'): DeviceInstance {
  const instance = rig.relays.get(instanceId);
  if (instance === undefined) {
    throw new Error(`Missing relay instance ${instanceId}`);
  }
  return instance;
}

describe('ideal button and ideal relay end-to-end (#58)', () => {
  it('loads the committed pairs and initializes both channels on the real kernel', async () => {
    const rig = await createRig();
    try {
      rig.settle();

      expect(button(rig).state).toBe('ready');
      expect(relay(rig).state).toBe('ready');
      expect([...relay(rig).description.pins.keys()].sort()).toEqual(['COM', 'IN', 'NC', 'NO']);
      expect([...relay(rig).description.connections.keys()].sort()).toEqual([
        'normallyClosed',
        'normallyOpen',
      ]);
      expect(button(rig).description.ports.get('pressed')).toMatchObject({
        direction: 'input',
        type: 'boolean',
      });

      expectIdle(rig, '1');
      expectIdle(rig, '2');

      // initialize applies the declared contact defaults; nothing else ran.
      expect(rig.patches).toEqual([
        contactPatch('sw1', false),
        relayPatch('k1', false),
        contactPatch('sw2', false),
        relayPatch('k2', false),
      ]);
      expect(rig.scheduler.now).toBe(0);
    } finally {
      rig.destroy();
    }
  });

  it('closes the passive button contact and switches the isolated relay network', async () => {
    await withRig((rig) => {
      rig.settle();
      const before = rig.patches.length;

      rig.press('sw1', true);
      // The topic listener only posts an IR entry; no topology work happens synchronously.
      expect(rig.patches).toHaveLength(before);
      rig.settle();

      // The button updated its own passive contact and never drove a pin.
      expect(rig.power.pinIntent({ instanceId: 'sw1', pinName: 'A' })).toMatchObject({
        mode: 'high-z',
        outputEnabled: false,
        pull: 'none',
      });
      const coil = rig.power.networkOf({ instanceId: 'board', pinName: 'COIL1' });
      expect(coil?.result).toMatchObject({ state: 'driven', voltage: 5, strength: 'strong' });
      expect(
        (coil?.result?.contributions ?? []).filter((entry) => entry.instanceId === 'sw1'),
      ).toEqual([]);

      // Observation captured IN=1, the IR entry applied one atomic SPDT patch.
      expect(rig.power.sampleDigital(IN1)).toEqual({ value: 1, ready: true, source: 'sampled' });
      expect(rig.patches.slice(before)).toEqual([
        contactPatch('sw1', true),
        relayPatch('k1', true),
      ]);
      expect(rig.connection('k1', 'normallyOpen')).toBe('closed');
      expect(rig.connection('k1', 'normallyClosed')).toBe('open');
      // The switched network follows the contact state.
      expect(rig.voltage(NO1)).toBe(5);
      expect(rig.voltage(NC1)).toBe(0);
      // The untouched channel keeps its idle network.
      expectIdle(rig, '2');
    });
  });

  it('releases the contact and restores the idle network without extra patches', async () => {
    await withRig((rig) => {
      rig.settle();
      rig.press('sw1', true);
      rig.settle();
      const afterPress = rig.patches.length;

      rig.press('sw1', false);
      rig.settle();

      expect(rig.patches.slice(afterPress)).toEqual([
        contactPatch('sw1', false),
        relayPatch('k1', false),
      ]);
      expectIdle(rig, '1');
      expect(rig.power.sampleDigital(IN1)).toEqual({ value: 0, ready: true, source: 'sampled' });
    });
  });

  it('samples the committed coil level when initialize runs', async () => {
    await withRig(
      (rig) => {
        rig.settle();
        expect(rig.connection('k1', 'normallyOpen')).toBe('closed');
        expect(rig.connection('k1', 'normallyClosed')).toBe('open');
        expect(rig.voltage(NO1)).toBe(5);
        expect(rig.voltage(NC1)).toBe(0);
        expect(rig.patches.filter((patch) => patch.instanceId === 'k1')).toEqual([
          relayPatch('k1', true),
        ]);
      },
      { initialCoilHigh: true },
    );
  });

  it('applies a queued short pulse from the captured levels instead of resampling', async () => {
    await withRig((rig) => {
      rig.settle();
      const before = rig.patches.length;

      // Both messages are accepted before any entry runs, so both edges are queued.
      rig.press('sw1', true);
      rig.press('sw1', false);
      rig.settle();

      // A resampling implementation would apply [open, open]; the captured values are [1, 0].
      expect(rig.patches.slice(before)).toEqual([
        contactPatch('sw1', true),
        contactPatch('sw1', false),
        relayPatch('k1', true),
        relayPatch('k1', false),
      ]);
      expectIdle(rig, '1');
    });
  });

  it('stays quiet on repeated levels and idle settles', async () => {
    await withRig((rig) => {
      rig.settle();
      rig.press('sw1', true);
      rig.settle();
      const afterFirst = rig.patches.length;

      rig.press('sw1', true);
      rig.settle();
      // Only the button re-asserted its own contact; no edge means no relay patch.
      expect(rig.patches.slice(afterFirst)).toEqual([contactPatch('sw1', true)]);
      expect(rig.connection('k1', 'normallyOpen')).toBe('closed');
      expect(rig.voltage(NO1)).toBe(5);

      const afterRepeat = rig.patches.length;
      rig.settle();
      rig.settle();
      expect(rig.patches).toHaveLength(afterRepeat);
      expect(rig.voltage(NO1)).toBe(5);
      expect(rig.voltage(NC1)).toBe(0);
    });
  });

  it('resets the button explicitly and rejects relay reset', async () => {
    await withRig((rig) => {
      rig.settle();
      rig.press('sw1', true);
      rig.settle();
      expect(rig.connection('k1', 'normallyOpen')).toBe('closed');

      button(rig).reset();
      rig.settle();
      expectIdle(rig, '1');

      // Explicit reset is idempotent; a second reset keeps the contact open.
      const afterReset = rig.patches.length;
      button(rig).reset();
      rig.settle();
      expect(rig.patches).toHaveLength(afterReset + 1);
      expectIdle(rig, '1');

      // The relay model does not declare reset; the host reports it as unsupported.
      let resetFailure: unknown;
      try {
        relay(rig).reset();
      } catch (error) {
        resetFailure = error;
      }
      expect(resetFailure).toBeInstanceOf(DeviceError);
      expect((resetFailure as DeviceError).code).toBe('device/lifecycle-unsupported');
    });
  });

  it('keeps two instances of the same loaded modules isolated', async () => {
    const rig = await createRig();
    try {
      rig.settle();
      rig.press('sw1', true);
      rig.settle();

      expect(rig.connection('k1', 'normallyOpen')).toBe('closed');
      expect(rig.connection('sw2', 'contact')).toBe('open');
      expectIdle(rig, '2');
      expect(rig.voltage(NO2)).toBe(0);
      expect(rig.voltage(NC2)).toBe(5);

      rig.press('sw2', true);
      rig.settle();
      expect(rig.connection('k2', 'normallyOpen')).toBe('closed');
      expect(rig.connection('k1', 'normallyOpen')).toBe('closed');
      expect(rig.voltage(NO2)).toBe(5);

      rig.press('sw1', false);
      rig.settle();
      expectIdle(rig, '1');
      expect(rig.connection('k2', 'normallyOpen')).toBe('closed');
      expect(rig.voltage(NO2)).toBe(5);
    } finally {
      rig.destroy();
    }
  });

  it('rejects a model whose description disagrees with its implementation', async () => {
    const scheduler = createScheduler();
    const layout = circuit();
    const power = createPowerRuntime(scheduler, layout.power, {
      instanceId: 'power',
      pinStates: layout.pinStates,
    });
    try {
      const description = await readExampleDescription(RELAY_DEVICE_ID);
      const connections = {
        ...(description['connections'] as Record<string, unknown>),
      };
      delete connections['normallyOpen'];
      const loaded = await loadDeviceModule(
        RELAY_DEVICE_ID,
        exampleProvider({
          [RELAY_DEVICE_ID]: { description: { ...description, connections } },
        }),
      );
      expect(() =>
        createDeviceInstance(loaded, scheduler, {
          instanceId: 'k1',
          pinHost: power,
          connections: { topology: power },
        }),
      ).toThrowError(expect.objectContaining({ code: 'device/connection-unknown' }));

      const buttonDescription = await readExampleDescription(BUTTON_DEVICE_ID);
      const button = await loadDeviceModule(
        BUTTON_DEVICE_ID,
        exampleProvider({
          [BUTTON_DEVICE_ID]: {
            description: {
              ...buttonDescription,
              ports: { pressed: { direction: 'output', type: 'boolean' } },
            },
          },
        }),
      );
      expect(() =>
        createDeviceInstance(button, scheduler, { instanceId: 'sw1', pinHost: power }),
      ).toThrowError(expect.objectContaining({ code: 'device/topic-direction' }));

      // A model whose IR contract is invalid is rejected at link time, not installed.
      const brokenCode = `export default function createDevice(api) {
        const input = api.ir.pin('IN');
        const changed = api.ir.entry('changed', ['u32']);
        api.ir.observeDigital('control', { trigger: input, captures: [input], target: changed });
        const initialize = api.ir.lifecycle('initialize', []);
        initialize.body((b) => {
          b.return([]);
        });
        return { initialize };
      }`;
      const broken = await loadDeviceModule(
        RELAY_DEVICE_ID,
        exampleProvider({ [RELAY_DEVICE_ID]: { code: brokenCode } }),
      );
      expect(() =>
        createDeviceInstance(broken, scheduler, {
          instanceId: 'k1',
          pinHost: power,
          connections: { topology: power },
        }),
      ).toThrowError(expect.objectContaining({ code: 'device/observe-binding' }));

      // Rejected factories leave the committed topology untouched.
      scheduler.start();
      expect(power.connectionState('k1', 'normallyOpen')).toBe('open');
      expect(power.connectionState('k1', 'normallyClosed')).toBe('closed');
      expect(power.connectionState('sw1', 'contact')).toBe('open');
    } finally {
      power.destroy();
    }
  });

  it('gates powered-down sense pins instead of fabricating a voltage', async () => {
    await withRig((rig) => {
      rig.settle();
      rig.press('sw1', true);
      rig.settle();
      rig.press('sw1', false);
      rig.settle();
      const before = rig.patches.length;

      rig.setSupply(0);
      rig.settle();

      expect(rig.power.domain('board', 'board')).toMatchObject({
        state: 'off',
        voltage: 0,
        groundReady: true,
      });
      expect(rig.power.pinGate(NC1)).toMatchObject({
        ready: false,
        reason: 'domain-off',
      });
      // The physical network still resolves to the load rail, but the gated device sample
      // reports "not ready" rather than a fake 0 V.
      expect(rig.power.networkOf(NC1)?.result).toMatchObject({
        state: 'driven',
        voltage: 5,
      });
      expect(rig.power.sampleVoltage(NC1)).toEqual({
        voltage: 0,
        ready: false,
        source: 'gated',
      });
      expect(rig.power.sampleDigital(NC1)).toEqual({ value: 0, ready: false, source: 'gated' });

      // Losing the logic domain produces no spurious contact switch.
      expect(rig.patches).toHaveLength(before);
      expect(rig.connection('k1', 'normallyOpen')).toBe('open');
      expect(rig.connection('k1', 'normallyClosed')).toBe('closed');

      rig.setSupply(5);
      rig.settle();
      expect(rig.power.domain('board', 'board').state).toBe('on');
      expect(rig.power.sampleVoltage(NC1)).toEqual({
        voltage: 5,
        ready: true,
        source: 'sampled',
      });
    });
  });

  it('keeps committed contact state when electrical resolution reports a conflict', async () => {
    await withRig((rig) => {
      rig.settle();
      // Shorted load rail: the sense pin drives 0 V while the relay will connect it to 5 V.
      rig.setPin(
        pinState('board', 'NO1', {
          mode: 'push-pull',
          outputEnabled: true,
          digitalIntent: false,
        }),
      );
      rig.settle();
      expect(rig.voltage(NO1)).toBe(0);

      rig.press('sw1', true);
      let failure: unknown;
      try {
        rig.settle();
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(SchedulerError);
      expect((failure as SchedulerError).code).toBe('execution-failed');
      expect((failure as SchedulerError).cause).toBeInstanceOf(ElectricalConflictError);
      expect(rig.scheduler.state).toBe('faulted');

      // Both patches committed before the failed resolution are preserved.
      expect(rig.connection('sw1', 'contact')).toBe('closed');
      expect(rig.connection('k1', 'normallyOpen')).toBe('closed');
      expect(rig.connection('k1', 'normallyClosed')).toBe('open');
      // The failed phase leaves committed networks unresolved rather than inventing a result.
      expect(rig.power.networkOf(NO1)?.result).toBeUndefined();
      // The other channel never participated in the conflict.
      expect(rig.connection('k2', 'normallyOpen')).toBe('open');
      expect(rig.connection('k2', 'normallyClosed')).toBe('closed');
    });
  });

  it('produces the same trace for the same input sequence', async () => {
    const run = async (): Promise<{
      readonly patches: unknown;
      readonly measurements: readonly unknown[];
    }> => {
      const rig = await createRig();
      try {
        rig.settle();
        rig.press('sw1', true);
        rig.settle();
        rig.press('sw1', false);
        rig.press('sw1', true);
        rig.settle();
        rig.press('sw1', false);
        rig.settle();
        return {
          patches: [...rig.patches],
          measurements: [
            rig.connection('k1', 'normallyOpen'),
            rig.connection('k1', 'normallyClosed'),
            rig.voltage(NO1),
            rig.voltage(NC1),
            rig.power.sampleDigital(IN1),
          ],
        };
      } finally {
        rig.destroy();
      }
    };

    expect(await run()).toEqual(await run());
  });
});
