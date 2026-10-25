import { describe, expect, it } from 'vitest';
import type { DeviceBehaviorApi, DeviceDescription } from '../compiler';
import { Circuit } from './circuit';
import { CircuitError } from './types';

/**
 * RFC 0007 — boolean power domains.
 *
 * The fixtures below are test-only device types (the RFC asks for a verification
 * device that is not part of the public device catalogue). Their shape is the
 * one a real MCU description uses: declared domains, a primary `vdd`, and pins
 * that either bind to a domain explicitly or inherit the primary one.
 */

/** MCU that drives `PA0` high from `initialize` and knows two domains. */
function poweredMcuDescription(): DeviceDescription {
  return {
    pins: { PA0: { direction: 'output' } },
    powerDomains: [
      { name: 'vdd', voltage: 3.3 },
      { name: 'vbat', voltage: 3 },
    ],
    behaviors: {
      initialize: (api: DeviceBehaviorApi) => {
        const pin = api.pin('PA0');
        pin.configure('push-pull');
        pin.writeDigital(api.builder.const('bool', true));
      },
    },
  };
}

/** MCU whose `PA0` is held by the host: no `tick`, the latch stays where put. */
function latchMcuDescription(): DeviceDescription {
  return {
    pins: { PA0: { direction: 'output' } },
    // Any behavior keeps the built-in default initialize (push-pull).
    behaviors: { update: () => {} },
  };
}

/** Counts ticks and latches the level it samples, so power gating is visible. */
function poweredCounterDescription(): DeviceDescription {
  return {
    pins: { clk: { direction: 'input' } },
    powerDomains: [{ name: 'vdd', voltage: 3.3 }],
    states: {
      count: { type: 'u32', initial: 0 },
      last: { type: 'bool', initial: false },
    },
    behaviors: {
      update: (api: DeviceBehaviorApi) => {
        const count = api.state<'u32'>('count');
        count.store(api.builder.int.add(count.load(), api.builder.const('u32', 1)));
        api.state<'bool'>('last').store(api.pin('clk').sampleDigital());
      },
    },
  };
}

/** Samples `SENSE` inside a topic handler, i.e. outside a gated phase. */
function poweredProbeDescription(): DeviceDescription {
  return {
    pins: { SENSE: { direction: 'input' } },
    ports: { read: { direction: 'input', type: 'boolean' } },
    powerDomains: [{ name: 'vdd', voltage: 3.3 }],
    states: { last: { type: 'bool', initial: false } },
    behaviors: {
      initialize: (api: DeviceBehaviorApi) => {
        api.topics.subscribe('read', (handler) => {
          handler.state<'bool'>('last').store(handler.pin('SENSE').sampleDigital());
        });
      },
    },
  };
}

/** Two outputs: `MAIN` on the primary domain, `BACKUP` explicitly on `vbat`. */
function splitRailMcuDescription(): DeviceDescription {
  return {
    pins: {
      MAIN: { direction: 'output' },
      BACKUP: { direction: 'output', powerDomain: 'vbat' },
    },
    powerDomains: [
      { name: 'vdd', voltage: 3.3 },
      { name: 'vbat', voltage: 3 },
    ],
    behaviors: {
      initialize: (api: DeviceBehaviorApi) => {
        for (const pin of api.outputs) {
          pin.configure('push-pull');
          pin.writeDigital(api.builder.const('bool', true));
        }
      },
    },
  };
}

/** Drives `PA0` high and declares a normally-closed switch to `OUT`. */
function poweredSwitchDescription(): DeviceDescription {
  return {
    pins: { PA0: { direction: 'output' }, OUT: { direction: 'passive' } },
    connections: { link: { pins: ['PA0', 'OUT'], initial: 'closed' } },
    powerDomains: [{ name: 'vdd', voltage: 3.3 }],
    behaviors: {
      initialize: (api: DeviceBehaviorApi) => {
        const pin = api.pin('PA0');
        pin.configure('push-pull');
        pin.writeDigital(api.builder.const('bool', true));
      },
    },
  };
}

/** `Mcu1.PA0` held by the host; nothing else. */
function latchInput() {
  return {
    devices: [{ id: 'mcu1', type: 'mcu', description: latchMcuDescription() }],
    connections: [],
  } as const;
}

describe('power domains: declaration', () => {
  it('reports every declared domain as powered by default', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'MCU1', type: 'powered-mcu', description: poweredMcuDescription() }],
      connections: [],
    });

    expect(circuit.isPowered('MCU1', 'vdd')).toBe(true);
    expect(circuit.isPowered('MCU1', 'vbat')).toBe(true);
    expect(circuit.samplePin('MCU1', 'PA0')).toEqual({ value: 1, ready: true });
  });

  it('treats devices without domains as always powered', async () => {
    const circuit = await Circuit.create(latchInput());

    expect(circuit.isPowered('mcu1', 'vdd')).toBe(true);
    expect(circuit.isPowered('unknown', 'vdd')).toBe(true);
  });

  it('rejects unknown domains and devices that declare none', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'MCU1', type: 'powered-mcu', description: poweredMcuDescription() },
        { id: 'mcu1', type: 'mcu', description: latchMcuDescription() },
      ],
      connections: [],
    });

    expect(() => circuit.isPowered('MCU1', 'vcc')).toThrowError(CircuitError);
    expect(() => circuit.isPowered('MCU1', 'vcc')).toThrowError(/Power domain MCU1\.vcc not found/);
    expect(() => circuit.isPowered('MCU1', 'vcc')).toThrowError(/vdd, vbat/);
    expect(() => circuit.turnOff('MCU1', 'vcc')).toThrowError(/Power domain MCU1\.vcc not found/);

    expect(() => circuit.turnOn('mcu1', 'vdd')).toThrowError(CircuitError);
    expect(() => circuit.turnOn('mcu1', 'vdd')).toThrowError(/declares no power domains/);

    try {
      circuit.turnOff('MCU1', 'vcc');
    } catch (error) {
      expect((error as CircuitError).code).toBe('power-domain-not-found');
      expect((error as CircuitError).domainName).toBe('vcc');
    }
    try {
      circuit.turnOff('mcu1', 'vdd');
    } catch (error) {
      expect((error as CircuitError).code).toBe('no-power-domains');
    }
  });
});

describe('power domains: gated driving', () => {
  it('releases a driven pin while its domain is off', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'mcu1', type: 'powered-mcu', description: poweredMcuDescription() },
        { id: 'led1', type: 'ideal-led', description: ledDescription() },
      ],
      connections: [
        { from: 'mcu1.PA0', to: 'led1.anode' },
        { from: 'led1.cathode', to: 'GND' },
      ],
    });

    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(true);

    circuit.turnOff('mcu1', 'vdd');
    expect(circuit.isPowered('mcu1', 'vdd')).toBe(false);
    circuit.step();

    // The latch still says high, but the pin is released: the host read and
    // the sink on the net both observe the determinate low level.
    expect(circuit.devices.mcu1.readPin('PA0')).toBe(true);
    expect(circuit.samplePin('mcu1', 'PA0')).toEqual({ value: 0, ready: true });
    expect(circuit.samplePin('led1', 'anode')).toEqual({ value: 0, ready: true });
    expect(circuit.devices.led1.isOn()).toBe(false);
  });

  it('restores the retained drive after turnOn', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'mcu1', type: 'powered-mcu', description: poweredMcuDescription() },
        { id: 'led1', type: 'ideal-led', description: ledDescription() },
      ],
      connections: [
        { from: 'mcu1.PA0', to: 'led1.anode' },
        { from: 'led1.cathode', to: 'GND' },
      ],
    });

    circuit.turnOff('mcu1', 'vdd');
    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(false);

    circuit.turnOn('mcu1', 'vdd');
    expect(circuit.isPowered('mcu1', 'vdd')).toBe(true);
    circuit.step();

    expect(circuit.samplePin('mcu1', 'PA0')).toEqual({ value: 1, ready: true });
    expect(circuit.devices.led1.isOn()).toBe(true);
  });

  it('binds a pin to its own domain instead of the primary one', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'mcu1', type: 'split-rail', description: splitRailMcuDescription() }],
      connections: [],
    });

    circuit.turnOff('mcu1', 'vdd');
    circuit.step();
    expect(circuit.samplePin('mcu1', 'MAIN').value).toBe(0);
    expect(circuit.samplePin('mcu1', 'BACKUP').value).toBe(1);

    circuit.turnOff('mcu1', 'vbat');
    circuit.step();
    expect(circuit.samplePin('mcu1', 'BACKUP').value).toBe(0);
  });

  it('gates the level a closed switch propagates from an unpowered driver', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'u1', type: 'powered-switch', description: poweredSwitchDescription() },
        { id: 'led1', type: 'ideal-led', description: ledDescription() },
      ],
      connections: [
        { from: 'u1.OUT', to: 'led1.anode' },
        { from: 'led1.cathode', to: 'GND' },
      ],
    });

    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(true);

    circuit.turnOff('u1', 'vdd');
    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(false);

    circuit.turnOn('u1', 'vdd');
    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(true);
  });

  it('restores every domain to powered on reset', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'MCU1', type: 'powered-mcu', description: poweredMcuDescription() }],
      connections: [],
    });

    circuit.turnOff('MCU1', 'vdd');
    circuit.turnOff('MCU1', 'vbat');
    circuit.step();
    expect(circuit.isPowered('MCU1', 'vdd')).toBe(false);
    expect(circuit.isPowered('MCU1', 'vbat')).toBe(false);

    circuit.reset();
    expect(circuit.isPowered('MCU1', 'vdd')).toBe(true);
    expect(circuit.isPowered('MCU1', 'vbat')).toBe(true);
    expect(circuit.samplePin('MCU1', 'PA0')).toEqual({ value: 1, ready: true });
  });
});

describe('power domains: gated sampling', () => {
  it('gates the level a device samples inside a topic handler', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'mcu1', type: 'mcu', description: latchMcuDescription() },
        { id: 'probe1', type: 'probe', description: poweredProbeDescription() },
      ],
      connections: [{ from: 'mcu1.PA0', to: 'probe1.SENSE' }],
    });

    circuit.devices.mcu1.writePin('PA0', true);
    circuit.step();
    circuit.deliverTopic('probe1', 'read', true);
    expect(circuit.devices.probe1.getState('last')).toBe(true);

    circuit.turnOff('probe1', 'vdd');
    circuit.deliverTopic('probe1', 'read', true);
    expect(circuit.devices.probe1.getState('last')).toBe(false);

    circuit.turnOn('probe1', 'vdd');
    circuit.deliverTopic('probe1', 'read', true);
    expect(circuit.devices.probe1.getState('last')).toBe(true);
  });

  it('gates the level the host samples from a sensing pin', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'mcu1', type: 'mcu', description: latchMcuDescription() },
        { id: 'probe1', type: 'probe', description: poweredProbeDescription() },
      ],
      connections: [{ from: 'mcu1.PA0', to: 'probe1.SENSE' }],
    });

    circuit.devices.mcu1.writePin('PA0', true);
    circuit.step();
    expect(circuit.samplePin('probe1', 'SENSE')).toEqual({ value: 1, ready: true });

    circuit.turnOff('probe1', 'vdd');
    // The net is still driven high; the sampling pin of the unpowered device
    // reads the determinate low level instead.
    expect(circuit.samplePin('mcu1', 'PA0').value).toBe(1);
    expect(circuit.samplePin('probe1', 'SENSE')).toEqual({ value: 0, ready: true });
  });
});

describe('power domains: gated device logic', () => {
  it('skips tick/update while the primary domain is off', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'count1', type: 'counter', description: poweredCounterDescription() }],
      connections: [],
    });

    circuit.runBatch(5);
    expect(circuit.devices.count1.getState('count')).toBe(5);

    circuit.turnOff('count1', 'vdd');
    circuit.runBatch(5);
    expect(circuit.devices.count1.getState('count')).toBe(5);

    circuit.turnOn('count1', 'vdd');
    circuit.runBatch(2);
    expect(circuit.devices.count1.getState('count')).toBe(7);
  });
});

/** Minimal LED description, matching the built-in `ideal-led` kernel. */
function ledDescription(): DeviceDescription {
  return {
    name: 'ideal-led',
    pins: {
      anode: { direction: 'passive' },
      cathode: { direction: 'passive' },
    },
    states: { lamp: { type: 'bool', initial: false } },
  };
}
