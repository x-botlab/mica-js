import type { DeviceBehaviorApi } from '../compiler';
import { lampSinkDescription, toggleDriverDescription } from '../compiler/test-helpers';

/**
 * Shared fixtures of the runtime tests.
 *
 * The returned objects are `as const` so `Circuit.create` infers literal device
 * ids, which is what types `circuit.devices.<id>`.
 */

/** `drive1.PA0 -> sink1.anode`, `sink1.cathode -> GND`. */
export function driverSinkInput() {
  return {
    devices: [
      { id: 'drive1', type: 'toggle-driver', description: toggleDriverDescription() },
      { id: 'sink1', type: 'lamp-sink', description: lampSinkDescription() },
    ],
    connections: [
      { from: 'drive1.PA0', to: 'sink1.anode' },
      { from: 'sink1.cathode', to: 'GND' },
    ],
  } as const;
}

/** One toggling driver and nothing else. */
export function driverOnlyInput() {
  return {
    devices: [{ id: 'drive1', type: 'toggle-driver', description: toggleDriverDescription() }],
    connections: [],
  } as const;
}

/**
 * Driver whose pin is owned by the host: no `tick`, so `writePin`/`setPin`
 * decide the level and the pin stays where the host put it.
 */
export function latchDriverSinkInput() {
  return {
    devices: [
      {
        id: 'drive1',
        type: 'toggle-driver',
        description: {
          pins: { PA0: { direction: 'output' } },
          // Any behaviour keeps the generated default initialize, which puts the
          // output pin into push-pull.
          behaviors: { update: () => {} },
        },
      },
      { id: 'sink1', type: 'lamp-sink', description: lampSinkDescription() },
    ],
    connections: [
      { from: 'drive1.PA0', to: 'sink1.anode' },
      { from: 'sink1.cathode', to: 'GND' },
    ],
  } as const;
}

/** Driver with integer/bool/float states so the generic state surface has values to read. */
export function registerDriverInput() {
  return {
    devices: [
      {
        id: 'drive1',
        type: 'toggle-driver',
        description: {
          pins: { PA0: { direction: 'output' } },
          states: {
            R0: { type: 'u32', initial: 0 },
            R1: { type: 'i16', initial: 0 },
            flag: { type: 'bool', initial: false },
            acc: { type: 'f32', initial: 0 },
          },
          behaviors: { update: () => {} },
        },
      },
    ],
    connections: [],
  } as const;
}

/** Two independent driver + sink pairs: one host-driven latch, one toggling driver. */
export function twoPairInput() {
  return {
    devices: [
      {
        id: 'drive1',
        type: 'toggle-driver',
        description: {
          pins: { PA0: { direction: 'output' } },
          behaviors: { update: () => {} },
        },
      },
      { id: 'sink1', type: 'lamp-sink', description: lampSinkDescription() },
      { id: 'drive2', type: 'toggle-driver', description: toggleDriverDescription() },
      { id: 'sink2', type: 'lamp-sink', description: lampSinkDescription() },
    ],
    connections: [
      { from: 'drive1.PA0', to: 'sink1.anode' },
      { from: 'sink1.cathode', to: 'GND' },
      { from: 'drive2.PA0', to: 'sink2.anode' },
      { from: 'sink2.cathode', to: 'GND' },
    ],
  } as const;
}

/** Two drivers on one net; only compiles with `allowMultiDriver`. */
export function multiDriverInput() {
  return {
    devices: [
      { id: 'drive1', type: 'toggle-driver', description: toggleDriverDescription() },
      { id: 'drive2', type: 'toggle-driver', description: toggleDriverDescription() },
      { id: 'sink1', type: 'lamp-sink', description: lampSinkDescription() },
    ],
    connections: [
      { from: 'drive1.PA0', to: 'sink1.anode' },
      { from: 'drive2.PA0', to: 'sink1.anode' },
      { from: 'sink1.cathode', to: 'GND' },
    ],
  } as const;
}

/** Device inspected through the generic accessor surface. */
export function counterInput() {
  return {
    devices: [
      {
        id: 'count1',
        type: 'counter',
        description: {
          pins: { clk: { direction: 'input' } },
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
        },
      },
      { id: 'drive1', type: 'toggle-driver', description: toggleDriverDescription() },
    ],
    connections: [{ from: 'drive1.PA0', to: 'count1.clk' }],
  } as const;
}
