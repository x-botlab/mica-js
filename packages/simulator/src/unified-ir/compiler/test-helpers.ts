import { PIN_MODE } from '../pin-space';
import type { DeviceBehaviorApi, DeviceConfig, DeviceDescription } from './types';

/**
 * Test-only device descriptions.
 *
 * The compiler ships no device models, so the suites describe the shapes they
 * need here. Both descriptions carry their own behaviors, exactly like a device
 * package would: nothing resolves through a built-in registry.
 */

/** Driver whose output pins toggle once per tick, like a naive firmware loop. */
export function toggleDriverDescription(pins: readonly string[] = ['PA0']): DeviceDescription {
  const declared: Record<string, { readonly direction: 'output' }> = {};
  for (const name of pins) declared[name] = Object.freeze({ direction: 'output' as const });
  return Object.freeze({
    name: 'toggle-driver',
    pins: Object.freeze(declared),
    behaviors: Object.freeze({
      initialize: (api: DeviceBehaviorApi) => {
        for (const pin of api.outputs) pin.configure(PIN_MODE.pushPull);
      },
      tick: (api: DeviceBehaviorApi) => {
        const b = api.builder;
        for (const pin of api.outputs) {
          pin.writeDigital(b.bool.not(pin.readDrivenDigital()));
          pin.configure(PIN_MODE.pushPull);
        }
      },
    }),
  });
}

/** Passive sink that lights when its anode senses high and its cathode low. */
export function lampSinkDescription(): DeviceDescription {
  return Object.freeze({
    name: 'lamp-sink',
    pins: Object.freeze({
      anode: Object.freeze({ direction: 'passive' as const }),
      cathode: Object.freeze({ direction: 'passive' as const }),
    }),
    states: Object.freeze({ lamp: Object.freeze({ type: 'bool' as const, initial: false }) }),
    behaviors: Object.freeze({
      update: (api: DeviceBehaviorApi) => {
        const b = api.builder;
        const anode = api.pin('anode').sampleDigital();
        const cathode = api.pin('cathode').sampleDigital();
        api.state<'bool'>('lamp').store(b.bool.and(anode, b.bool.not(cathode)));
      },
    }),
  });
}

/** One `toggle-driver` device. */
export function driverDevice(
  id = 'drive1',
  pins: readonly string[] = ['PA0'],
  type = 'toggle-driver',
): DeviceConfig {
  return { id, type, description: toggleDriverDescription(pins) };
}

/** One `lamp-sink` device. */
export function sinkDevice(id = 'sink1', type = 'lamp-sink'): DeviceConfig {
  return { id, type, description: lampSinkDescription() };
}
