import type { Value } from '@mica-js/ir';
import type { SchematicDeviceBinding } from '../compiler/schematic-compiler';
import type { DeviceDescription } from '../compiler/types';
import { PIN_MODE } from '../pin-space';

/**
 * Unified-IR descriptions of the committed device examples.
 *
 * `packages/device/examples` ships a package description plus device code for
 * every example; the unified compiler cannot mount that code yet (no device
 * bridge, see `docs/UNIFIED_IR_GAPS.md`), so a schematic that binds these
 * examples compiles them as passive devices. The two electrical examples only
 * need a contact and an edge-triggered relay, which the domain lowering already
 * expresses, so the same behaviour is available here as plain IR descriptions:
 *
 * ```ts
 * const executor = createCircuitExecutor({
 *   devices: provider,                 // mica:ideal-button, mica:ideal-relay, …
 *   resolveDevice: resolveExampleDevice,
 * });
 * ```
 *
 * Both descriptions mirror their example byte for byte; keep them in sync until
 * the legacy device bridge compiles the example modules directly.
 */

/** Package device id of the committed push button. */
export const IDEAL_BUTTON_DEVICE = 'mica:ideal-button';

/** Package device id of the committed SPDT relay. */
export const IDEAL_RELAY_DEVICE = 'mica:ideal-relay';

/** Pin names of the committed push button. */
export const IDEAL_BUTTON_PINS = Object.freeze({ a: 'A', b: 'B' });

/** Pin names of the committed SPDT relay. */
export const IDEAL_RELAY_PINS = Object.freeze({
  coil: 'IN',
  common: 'COM',
  normallyOpen: 'NO',
  normallyClosed: 'NC',
});

/**
 * Passive contact between `A` and `B`, driven only by the `pressed` topic.
 *
 * Closing merges the two nets, so the contact conducts in either direction —
 * the electrical behaviour the example declares as `contact: {pins: [A, B]}`.
 */
export function createIdealButtonDescription(): DeviceDescription {
  return {
    name: 'ideal-button',
    pins: {
      [IDEAL_BUTTON_PINS.a]: { direction: 'passive' },
      [IDEAL_BUTTON_PINS.b]: { direction: 'passive' },
    },
    connections: {
      contact: {
        pins: [IDEAL_BUTTON_PINS.a, IDEAL_BUTTON_PINS.b],
        initial: 'open',
      },
    },
    ports: {
      pressed: { direction: 'input', type: 'boolean', title: 'Pressed' },
    },
    behaviors: {
      initialize: (api) => {
        api.connection.apply([{ connection: 'contact', closed: false }]);
        api.topics.subscribe('pressed', (handler) => {
          const pressed = handler.args[0];
          if (pressed === undefined) return;
          handler.connection.apply([{ connection: 'contact', closed: pressed as Value<'bool'> }]);
        });
      },
    },
  };
}

/**
 * SPDT relay: a rising/falling edge on the coil captures the level and switches
 * both poles in one atomic patch, exactly like the committed example.
 */
export function createIdealRelayDescription(
  edges: 'rising' | 'falling' | 'both' = 'both',
): DeviceDescription {
  return {
    name: 'ideal-relay',
    pins: {
      [IDEAL_RELAY_PINS.coil]: { direction: 'input' },
      [IDEAL_RELAY_PINS.common]: { direction: 'passive' },
      [IDEAL_RELAY_PINS.normallyOpen]: { direction: 'passive' },
      [IDEAL_RELAY_PINS.normallyClosed]: { direction: 'passive' },
    },
    connections: {
      normallyOpen: {
        pins: [IDEAL_RELAY_PINS.common, IDEAL_RELAY_PINS.normallyOpen],
        initial: 'open',
      },
      normallyClosed: {
        pins: [IDEAL_RELAY_PINS.common, IDEAL_RELAY_PINS.normallyClosed],
        initial: 'closed',
      },
    },
    observers: {
      control: {
        trigger: IDEAL_RELAY_PINS.coil,
        captures: [IDEAL_RELAY_PINS.coil],
        edges,
      },
    },
    behaviors: {
      initialize: (api) => {
        api.pin(IDEAL_RELAY_PINS.coil).configure(PIN_MODE.highZ);
        api.observe.configure('control', {
          handler: (handler, captured) => {
            const level = captured[0];
            if (level === undefined) return;
            handler.connection.apply([
              { connection: 'normallyOpen', closed: level },
              {
                connection: 'normallyClosed',
                closed: handler.builder.bool.not(level),
              },
            ]);
          },
        });
      },
    },
  };
}

/** Reference shape `resolveDevice` receives from the schematic compiler. */
export interface ExampleDeviceReference {
  /** Device id after the package prefix (`ideal-button`). */
  readonly deviceId: string;
}

/**
 * Binds the committed electrical examples to their IR descriptions.
 *
 * Pass it as `createCircuitExecutor({ resolveDevice: resolveExampleDevice })`.
 * Every other device returns `undefined`, which keeps the compiler's passive
 * description: topic ports still work, only the electrical behaviour is absent.
 */
export function resolveExampleDevice(
  reference: ExampleDeviceReference,
): SchematicDeviceBinding | undefined {
  if (reference.deviceId === 'ideal-button') {
    return {
      type: 'ideal-button',
      description: createIdealButtonDescription(),
    };
  }
  if (reference.deviceId === 'ideal-relay') {
    return {
      type: 'ideal-relay',
      description: createIdealRelayDescription(),
    };
  }
  return undefined;
}
