import type {
  ElectricalPinInput,
  PowerDefinition,
  TopologyDefinition,
  TopologyPinRef,
} from '@mica-js/core';
import { BUTTON_SYMBOL, MCU_SYMBOL, RELAY_SYMBOL } from './symbols';

export const IDEAL_5V_MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
});

export function pin(
  instanceId: string,
  pinName: string,
  overrides: Partial<ElectricalPinInput> = {},
): ElectricalPinInput {
  return {
    instanceId,
    pinName,
    powerReady: true,
    mode: 'high-z',
    outputEnabled: false,
    pull: 'none',
    model: IDEAL_5V_MODEL,
    ...overrides,
  };
}

export function signal(instanceId: string, pinName: string): TopologyPinRef {
  return { instanceId, pinName };
}

/** Everything a host must own to run one schematic: the electrical definition and its intents. */
export interface BoardFixture {
  readonly power: PowerDefinition;
  readonly pinStates: readonly ElectricalPinInput[];
}

const SW = BUTTON_SYMBOL.id;
const K = RELAY_SYMBOL.id;
const U = MCU_SYMBOL.id;

/**
 * Button contact wired between VCC and a pulled-down sense net.
 *
 * The contact is passive, so the sense net only rises while the button is pressed; `SENSE` sits
 * on the board logic domain, which is what the bench reads.
 */
export const BUTTON_BOARD: BoardFixture = (() => {
  const topology: TopologyDefinition = {
    pins: [
      { instanceId: 'board', pinName: 'VCC', kind: 'power' },
      { instanceId: 'board', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'board', pinName: 'SENSE', kind: 'signal' },
      { instanceId: SW, pinName: 'A', kind: 'signal' },
      { instanceId: SW, pinName: 'B', kind: 'signal' },
    ],
    wires: [
      { wireId: 'ground', pins: [signal('board', 'GND')], globalGnd: true },
      { wireId: 'vcc', pins: [signal(SW, 'A'), signal('board', 'VCC')] },
      { wireId: 'sense', pins: [signal(SW, 'B'), signal('board', 'SENSE')] },
    ],
    connections: [{ instanceId: SW, connectionId: 'contact', pins: ['A', 'B'], initial: 'open' }],
  };
  return {
    power: {
      topology,
      devices: [
        {
          instanceId: 'board',
          powerDomains: {
            logic: { supply: 'VCC', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
          },
          pins: { SENSE: { powerDomain: 'logic' } },
        },
      ],
    },
    pinStates: [
      pin('board', 'VCC', { mode: 'analog', outputEnabled: true, voltageIntent: 5 }),
      pin('board', 'GND'),
      pin('board', 'SENSE', { pull: 'down' }),
      pin(SW, 'A'),
      pin(SW, 'B'),
    ],
  };
})();

/**
 * The #58 chain: the button contact feeds the relay coil, the coil switches an isolated LOAD rail,
 * and the switched side is observed through the board's NO/NC pull-downs.
 */
export const BUTTON_RELAY_BOARD: BoardFixture = (() => {
  const topology: TopologyDefinition = {
    pins: [
      { instanceId: 'board', pinName: 'VCC', kind: 'power' },
      { instanceId: 'board', pinName: 'LOAD', kind: 'power' },
      { instanceId: 'board', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'board', pinName: 'COIL', kind: 'signal' },
      { instanceId: 'board', pinName: 'NO', kind: 'signal' },
      { instanceId: 'board', pinName: 'NC', kind: 'signal' },
      { instanceId: SW, pinName: 'A', kind: 'signal' },
      { instanceId: SW, pinName: 'B', kind: 'signal' },
      { instanceId: K, pinName: 'IN', kind: 'signal' },
      { instanceId: K, pinName: 'COM', kind: 'signal' },
      { instanceId: K, pinName: 'NO', kind: 'signal' },
      { instanceId: K, pinName: 'NC', kind: 'signal' },
    ],
    wires: [
      { wireId: 'ground', pins: [signal('board', 'GND')], globalGnd: true },
      { wireId: 'vcc', pins: [signal(SW, 'A'), signal('board', 'VCC')] },
      { wireId: 'coil', pins: [signal(SW, 'B'), signal(K, 'IN'), signal('board', 'COIL')] },
      { wireId: 'com', pins: [signal(K, 'COM'), signal('board', 'LOAD')] },
      { wireId: 'no', pins: [signal(K, 'NO'), signal('board', 'NO')] },
      { wireId: 'nc', pins: [signal(K, 'NC'), signal('board', 'NC')] },
    ],
    connections: [
      { instanceId: SW, connectionId: 'contact', pins: ['A', 'B'], initial: 'open' },
      { instanceId: K, connectionId: 'normallyOpen', pins: ['COM', 'NO'], initial: 'open' },
      { instanceId: K, connectionId: 'normallyClosed', pins: ['COM', 'NC'], initial: 'closed' },
    ],
  };
  return {
    power: {
      topology,
      devices: [
        {
          instanceId: 'board',
          powerDomains: {
            board: { supply: 'VCC', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
          },
          pins: { NO: { powerDomain: 'board' }, NC: { powerDomain: 'board' } },
        },
      ],
    },
    pinStates: [
      pin('board', 'VCC', { mode: 'analog', outputEnabled: true, voltageIntent: 5 }),
      pin('board', 'LOAD', { mode: 'analog', outputEnabled: true, voltageIntent: 5 }),
      pin('board', 'GND'),
      pin('board', 'COIL', { pull: 'down' }),
      pin('board', 'NO', { pull: 'down' }),
      pin('board', 'NC', { pull: 'down' }),
      pin(SW, 'A'),
      pin(SW, 'B'),
      pin(K, 'IN'),
      pin(K, 'COM'),
      pin(K, 'NO'),
      pin(K, 'NC'),
    ],
  };
})();

/** The teaching MCU's GPIO drives a pulled-down sense net on the board logic domain. */
export const MCU_BOARD: BoardFixture = (() => {
  const topology: TopologyDefinition = {
    pins: [
      { instanceId: 'board', pinName: 'VCC', kind: 'power' },
      { instanceId: 'board', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'board', pinName: 'SENSE', kind: 'signal' },
      { instanceId: U, pinName: 'GPIO', kind: 'signal' },
    ],
    wires: [
      { wireId: 'ground', pins: [signal('board', 'GND')], globalGnd: true },
      { wireId: 'gpio', pins: [signal(U, 'GPIO'), signal('board', 'SENSE')] },
    ],
    connections: [],
  };
  return {
    power: {
      topology,
      devices: [
        {
          instanceId: 'board',
          powerDomains: {
            logic: { supply: 'VCC', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
          },
          pins: { SENSE: { powerDomain: 'logic' } },
        },
      ],
    },
    pinStates: [
      pin('board', 'VCC', { mode: 'analog', outputEnabled: true, voltageIntent: 5 }),
      pin('board', 'GND'),
      pin('board', 'SENSE', { pull: 'down' }),
      pin(U, 'GPIO'),
    ],
  };
})();
