import { PIN_MODE } from '@mica-js/simulator';
import type {
  DeviceBehaviorApi,
  DeviceBehaviors,
  DeviceDescription,
  DevicePinDescription,
  DeviceStateDescription,
} from '@mica-js/simulator';
import type { DeviceLibraryEntry } from './device-library';

/**
 * Unified-IR models of every demo device.
 *
 * The simulator ships no device models, so the Playground owns all of them: each function below
 * turns one contract into a plain `DeviceDescription` — pins, states and behavior hooks the compiler
 * inlines into the shared IR module. Nothing here implements a `DeviceAccessor`; hosts read and write
 * every topic through the generic accessor state surface, named by the contract's `topic.state`.
 *
 * The pins follow the contract's declared directions, because this engine drives a net from exactly
 * one pin per net:
 *
 * - a sensor (`ideal-led`) only samples its nets;
 * - a contact is a *sensed* supply terminal plus a *driving* load terminal, so pressing or
 *   energizing the device re-drives the load net from the sensed level;
 * - a changeover contact senses its pole (`COM`) and drives the selected throw;
 * - the `teaching-mcu` drives its GPIO pins.
 *
 * The matching drawings live in `public/devices`; the pin directions there and here must agree.
 */

/** Types this package models itself; every type a device host can compile is listed here. */
export const MODEL_DEVICE_TYPES: readonly string[] = Object.freeze([
  'ideal-led',
  'teaching-mcu',
  'button-ir',
  'relay-ir',
]);

/** Required pins of one modeled type, with the electrical role the model relies on. */
const LED_PINS = Object.freeze({ anode: 'anode', cathode: 'cathode' });
const BUTTON_PINS = Object.freeze({ supply: 'A', contact: 'B' });
const RELAY_PINS = Object.freeze({
  coil: 'IN',
  pole: 'COM',
  normallyOpen: 'NO',
  normallyClosed: 'NC',
});

/**
 * Lamp model of `ideal-led`.
 *
 * ```text
 * <id>_update:                   // after the nets solve
 *   LAMP = PIN_INPUT[anode] && !PIN_INPUT[cathode]
 * ```
 *
 * Both terminals are passive: the LED only reads the solved net levels, so whatever drives the
 * anode side stays the single driver of that net.
 */
export function createLedDescription(entry: DeviceLibraryEntry): DeviceDescription {
  const anode = requiredPin(entry, LED_PINS.anode);
  const cathode = requiredPin(entry, LED_PINS.cathode);
  if (anode.direction === 'output' || cathode.direction === 'output') {
    throw new Error(
      `Device contract ${entry.reference}: pins ${LED_PINS.anode}/${LED_PINS.cathode} sense their nets, they must not drive them`,
    );
  }
  return Object.freeze({
    name: entry.type,
    pins: describePins(entry),
    states: Object.freeze({ lamp: boolState(false) }),
    behaviors: ledBehaviors(),
  });
}

/**
 * Clock model of `teaching-mcu`.
 *
 * ```text
 * <id>_initialize:
 *   PIN_MODE[p]   = PUSH_PULL     // for every driver pin
 * <id>_tick:
 *   PIN_OUTPUT[p] = !PIN_OUTPUT[p]
 * ```
 *
 * The prototype MCU only has to move its GPIO pins, so one toggle per tick owns the whole model; a
 * real instruction set would replace `description.behaviors` with a kernel factory.
 */
export function createMcuDescription(entry: DeviceLibraryEntry): DeviceDescription {
  const outputs = Object.values(entry.pins).filter((pin) => pin.direction === 'output');
  if (outputs.length === 0) {
    throw new Error(
      `Device contract ${entry.reference}: teaching-mcu must declare at least one output pin to toggle`,
    );
  }
  return Object.freeze({
    name: entry.type,
    pins: describePins(entry),
    behaviors: mcuBehaviors(),
  });
}

/**
 * Contact model of `button-ir`.
 *
 * ```text
 * <id>_tick:                     // before the nets solve
 *   PIN_OUTPUT[B] = closed
 * <id>_update:                   // after the nets solve
 *   pressed     = PRESSED[topic]
 *   differing   = pressed != settled
 *   counter     = differing ? counter + 1 : 0
 *   adopt       = differing && counter >= debounceTicks
 *   settled     = adopt ? pressed : settled
 *   pressCount += settled && !settledBefore     // a rising contact is one press
 *   closed      = settled && PIN_INPUT[A]       // the contact only conducts with a supply
 * ```
 *
 * `closed` is what the schematic sees and what the contract publishes; `pressed` is the widget
 * input, so the debounce and the press counter belong to the model, not to the widget.
 */
export function createButtonDescription(entry: DeviceLibraryEntry): DeviceDescription {
  const supply = requiredPin(entry, BUTTON_PINS.supply);
  const contact = requiredPin(entry, BUTTON_PINS.contact);
  if (supply.direction === 'output') {
    throw new Error(
      `Device contract ${entry.reference}: pin ${BUTTON_PINS.supply} must sense the supply side, not drive it`,
    );
  }
  if (contact.direction !== 'output') {
    throw new Error(
      `Device contract ${entry.reference}: pin ${BUTTON_PINS.contact} must drive the load net (direction "output")`,
    );
  }
  const debounceTicks = debounceTicksOf(entry);
  return Object.freeze({
    name: entry.type,
    pins: describePins(entry),
    states: Object.freeze({
      pressed: boolState(false),
      settled: boolState(false),
      /** Consecutive updates in which `pressed` disagreed with `settled`. */
      debounce: uintState(0),
      closed: boolState(false),
      pressCount: uintState(0),
    }),
    behaviors: buttonBehaviors(debounceTicks),
  });
}

/**
 * Changeover model of `relay-ir`.
 *
 * ```text
 * <id>_tick:
 *   PIN_OUTPUT[NO] = energized && PIN_INPUT[COM]
 *   PIN_OUTPUT[NC] = !energized && PIN_INPUT[COM]
 * <id>_update:
 *   energized = PIN_INPUT[IN]
 * ```
 *
 * The coil is sensed rather than driven: whatever drives `IN` owns the coil net. The contact copies
 * the pole level onto the selected throw, which is the ideal-switch abstraction this engine solves.
 */
export function createRelayDescription(entry: DeviceLibraryEntry): DeviceDescription {
  const coil = requiredPin(entry, RELAY_PINS.coil);
  const pole = requiredPin(entry, RELAY_PINS.pole);
  const normallyOpen = requiredPin(entry, RELAY_PINS.normallyOpen);
  const normallyClosed = requiredPin(entry, RELAY_PINS.normallyClosed);
  if (coil.direction === 'output' || pole.direction === 'output') {
    throw new Error(
      `Device contract ${entry.reference}: pins ${RELAY_PINS.coil}/${RELAY_PINS.pole} sense the coil and pole nets, they must not drive them`,
    );
  }
  if (normallyOpen.direction !== 'output' || normallyClosed.direction !== 'output') {
    throw new Error(
      `Device contract ${entry.reference}: pins ${RELAY_PINS.normallyOpen}/${RELAY_PINS.normallyClosed} must drive their load nets (direction "output")`,
    );
  }
  return Object.freeze({
    name: entry.type,
    pins: describePins(entry),
    states: Object.freeze({ energized: boolState(false) }),
    behaviors: relayBehaviors(),
  });
}

function ledBehaviors(): DeviceBehaviors {
  return Object.freeze({
    // The anode side is driven by another device, so the LED only reports the solved levels.
    update: (api: DeviceBehaviorApi) => {
      const b = api.builder;
      const anode = api.pin(LED_PINS.anode).sampleDigital();
      const cathode = api.pin(LED_PINS.cathode).sampleDigital();
      api.state<'bool'>('lamp').store(b.bool.and(anode, b.bool.not(cathode)));
    },
  });
}

function mcuBehaviors(): DeviceBehaviors {
  return Object.freeze({
    initialize: (api: DeviceBehaviorApi) => {
      for (const pin of api.outputs) pin.configure(PIN_MODE.pushPull);
    },
    tick: (api: DeviceBehaviorApi) => {
      const b = api.builder;
      for (const pin of api.outputs) {
        const current = pin.readDrivenDigital();
        pin.writeDigital(b.bool.not(current));
        pin.configure(PIN_MODE.pushPull);
      }
    },
  });
}

function buttonBehaviors(debounceTicks: number): DeviceBehaviors {
  return Object.freeze({
    // Drivers publish before the nets solve, so a load on the contact sees it in the same step.
    tick: (api: DeviceBehaviorApi) => {
      api.pin(BUTTON_PINS.contact).writeDigital(api.state<'bool'>('closed').load());
    },
    update: (api: DeviceBehaviorApi) => {
      const b = api.builder;
      const pressed = api.state<'bool'>('pressed').load();
      const settled = api.state<'bool'>('settled').load();
      const counter = api.state<'u32'>('debounce').load();
      const differing = b.bool.xor(pressed, settled);
      const nextCounter = b.select(
        differing,
        b.int.add(counter, b.const('u32', 1)),
        b.const('u32', 0),
      );
      const adopt = b.bool.and(
        differing,
        b.int.cmp('ge', nextCounter, b.const('u32', debounceTicks)),
      );
      const nextSettled = b.select(adopt, pressed, settled);
      const closing = b.bool.and(b.bool.not(settled), nextSettled);
      const count = api.state<'u32'>('pressCount');
      count.store(b.int.add(count.load(), b.select(closing, b.const('u32', 1), b.const('u32', 0))));
      api.state<'bool'>('settled').store(nextSettled);
      api.state<'u32'>('debounce').store(b.select(adopt, b.const('u32', 0), nextCounter));
      api
        .state<'bool'>('closed')
        .store(b.bool.and(nextSettled, api.pin(BUTTON_PINS.supply).sampleDigital()));
    },
  });
}

function relayBehaviors(): DeviceBehaviors {
  return Object.freeze({
    tick: (api: DeviceBehaviorApi) => {
      const b = api.builder;
      const energized = api.state<'bool'>('energized').load();
      const pole = api.pin(RELAY_PINS.pole).sampleDigital();
      api.pin(RELAY_PINS.normallyOpen).writeDigital(b.bool.and(energized, pole));
      api.pin(RELAY_PINS.normallyClosed).writeDigital(b.bool.and(b.bool.not(energized), pole));
    },
    update: (api: DeviceBehaviorApi) => {
      api.state<'bool'>('energized').store(api.pin(RELAY_PINS.coil).sampleDigital());
    },
  });
}

function describePins(entry: DeviceLibraryEntry): Readonly<Record<string, DevicePinDescription>> {
  const pins: Record<string, DevicePinDescription> = {};
  for (const [name, pin] of Object.entries(entry.pins)) {
    pins[name] = Object.freeze({
      direction: pin.direction,
      ...(pin.kind === undefined ? {} : { kind: pin.kind }),
    });
  }
  return Object.freeze(pins);
}

function requiredPin(entry: DeviceLibraryEntry, name: string): DeviceLibraryEntry['pins'][string] {
  const pin = entry.pins[name];
  if (pin === undefined) {
    throw new Error(
      `Device contract ${entry.reference} (${entry.type}) declares no pin ${JSON.stringify(name)}; pins: ${Object.keys(entry.pins).join(', ')}`,
    );
  }
  return pin;
}

/** `config.debounceTicks`: consecutive updates a new level must hold before the contact follows. */
function debounceTicksOf(entry: DeviceLibraryEntry): number {
  const raw = entry.config['debounceTicks'];
  if (raw === undefined) {
    return 0;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `Device contract ${entry.reference}: config.debounceTicks must be a non-negative integer`,
    );
  }
  return raw;
}

function boolState(initial: boolean): DeviceStateDescription {
  return Object.freeze({ type: 'bool', initial });
}

function uintState(initial: number): DeviceStateDescription {
  return Object.freeze({ type: 'u32', initial });
}
