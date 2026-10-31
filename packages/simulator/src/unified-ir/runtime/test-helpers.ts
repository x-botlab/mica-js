import { physicalDescription } from '../compiler/test-helpers';

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

export function driverOnlyInput() {
  return {
    devices: [{ id: 'drive1', type: 'toggle-driver', description: toggleDriverDescription() }],
    connections: [],
  } as const;
}

export function registerDriverInput() {
  return {
    devices: [
      {
        id: 'drive1',
        type: 'toggle-driver',
        description: physicalDescription(
          {
            pins: { PA0: { kind: 'signal' } },
            states: {
              R0: { type: 'u32', initial: 0 },
              R1: { type: 'i16', initial: 0 },
              flag: { type: 'bool', initial: false },
              acc: { type: 'f32', initial: 0 },
            },
          },
          ['PA0'],
        ),
      },
    ],
    connections: [],
  } as const;
}
import type { DeviceBehaviorApi } from '../compiler';
import { lampSinkDescription, toggleDriverDescription } from '../compiler/test-helpers';

/** Device inspected through the generic accessor surface. */
export function counterInput() {
  return {
    devices: [
      {
        id: 'count1',
        type: 'counter',
        description: physicalDescription({
          pins: { clk: { kind: 'signal' } },
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
        }),
      },
      {
        id: 'drive1',
        type: 'toggle-driver',
        description: physicalDescription(toggleDriverDescription()),
      },
    ],
    connections: [{ from: 'drive1.PA0', to: 'count1.clk' }],
  } as const;
}
