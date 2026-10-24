import { createLedDescription, createMcuDescription } from '../compiler';
import type { DeviceBehaviorApi } from '../compiler';

/**
 * Shared fixtures of the runtime tests.
 *
 * The returned objects are `as const` so `Circuit.create` infers literal device
 * ids and types, which is what gives the tests their typed accessors.
 */

/** `mcu1.PA0 -> led1.anode`, `led1.cathode -> GND`. */
export function mcuLedInput() {
  return {
    devices: [
      { id: 'mcu1', type: 'teaching-mcu', description: createMcuDescription() },
      { id: 'led1', type: 'ideal-led', description: createLedDescription() },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  } as const;
}

/** One toggling MCU and nothing else. */
export function mcuOnlyInput() {
  return {
    devices: [{ id: 'mcu1', type: 'teaching-mcu', description: createMcuDescription() }],
    connections: [],
  } as const;
}

/**
 * MCU whose pin is owned by the host: no `tick`, so `writePin`/`setPin` decide
 * the level and the pin stays where the host put it.
 */
export function latchMcuLedInput() {
  return {
    devices: [
      {
        id: 'mcu1',
        type: 'mcu',
        description: {
          pins: { PA0: { direction: 'output' } },
          // Any behaviour keeps the built-in default initialize, which puts the
          // output pin into push-pull.
          behaviors: { update: () => {} },
        },
      },
      { id: 'led1', type: 'ideal-led', description: createLedDescription() },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  } as const;
}

/** MCU with integer/bool states so the register accessor has something to read. */
export function registerMcuInput() {
  return {
    devices: [
      {
        id: 'mcu1',
        type: 'mcu',
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

/** Two independent MCU + LED pairs: one host-driven latch, one toggling MCU. */
export function twoPairInput() {
  return {
    devices: [
      {
        id: 'mcu1',
        type: 'mcu',
        description: {
          pins: { PA0: { direction: 'output' } },
          behaviors: { update: () => {} },
        },
      },
      { id: 'led1', type: 'ideal-led', description: createLedDescription() },
      { id: 'mcu2', type: 'teaching-mcu', description: createMcuDescription() },
      { id: 'led2', type: 'ideal-led', description: createLedDescription() },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
      { from: 'mcu2.PA0', to: 'led2.anode' },
      { from: 'led2.cathode', to: 'GND' },
    ],
  } as const;
}

/** Two drivers on one net; only compiles with `allowMultiDriver`. */
export function multiDriverInput() {
  return {
    devices: [
      { id: 'mcu1', type: 'teaching-mcu', description: createMcuDescription() },
      { id: 'mcu2', type: 'teaching-mcu', description: createMcuDescription() },
      { id: 'led1', type: 'ideal-led', description: createLedDescription() },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'mcu2.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
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
      { id: 'mcu1', type: 'teaching-mcu', description: createMcuDescription() },
    ],
    connections: [{ from: 'mcu1.PA0', to: 'count1.clk' }],
  } as const;
}
