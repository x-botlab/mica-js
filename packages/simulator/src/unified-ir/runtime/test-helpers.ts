import { lampSinkDescription, toggleDriverDescription } from '../compiler/test-helpers';

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
