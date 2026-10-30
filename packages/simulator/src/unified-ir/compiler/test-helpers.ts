import { PIN_MODE } from '../pin-space';
import type {
  CircuitCompilationOptions,
  DeviceBehaviorApi,
  DeviceConfig,
  DeviceDescription,
} from './types';
import { Circuit } from '../runtime/circuit';

/**
 * Test-only device descriptions.
 *
 * The compiler ships no device models, so the suites describe the shapes they
 * need here. Both descriptions carry their own behaviors, exactly like a device
 * package would: nothing resolves through a built-in registry.
 */

/** Driver whose output pins toggle once per tick, like a naive firmware loop. */
export function toggleDriverDescription(pins: readonly string[] = ['PA0']): DeviceDescription {
  const declared: Record<string, { readonly kind: 'signal' }> = {};
  for (const name of pins) declared[name] = Object.freeze({ kind: 'signal' as const });
  return physicalDescription(
    Object.freeze({
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
    }),
    pins,
  );
}

/** Passive sink that lights when its anode senses high and its cathode low. */
export function lampSinkDescription(): DeviceDescription {
  return physicalDescription(
    Object.freeze({
      name: 'lamp-sink',
      pins: Object.freeze({
        anode: Object.freeze({ kind: 'signal' as const }),
        cathode: Object.freeze({ kind: 'signal' as const }),
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
    }),
  );
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

export const TEST_ELECTRICAL = {
  sources: { VCC: { voltage: 5 }, VDD: { voltage: 5 } },
  interpretation: 'two-state',
} as const satisfies CircuitCompilationOptions;

/** Explicit finite-impedance GPIO and threshold inputs for compiler/runtime fixtures. */
export function physicalDescription(
  description: Omit<DeviceDescription, 'factory'> & Partial<Pick<DeviceDescription, 'factory'>>,
  outputs: readonly string[] = [],
): DeviceDescription {
  if (description.factory !== undefined) return description as DeviceDescription;
  const pins =
    description.pins instanceof Map ? description.pins : new Map(Object.entries(description.pins));
  const { behaviors, ...definition } = description;
  return {
    ...definition,
    factory: ({ electrical }) => {
      for (const [name] of pins) {
        const drives = outputs.includes(name);
        electrical.initializePin(name, {
          ...(drives
            ? { drive: { reference: { source: 'VDD' }, highResistance: 50, lowResistance: 50 } }
            : {}),
          input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
        });
      }
      if (outputs.length === 0) return behaviors;
      return {
        ...behaviors,
        initialize: (api) => {
          for (const pin of api.outputs) {
            pin.configure(PIN_MODE.pushPull);
            pin.setOutputEnabled(api.builder.const('bool', true));
          }
          behaviors?.initialize?.(api);
        },
      };
    },
  };
}

export const createTestCircuit: typeof Circuit.create = (input, options) => {
  if (options === null || (options !== undefined && typeof options !== 'object'))
    return Circuit.create(input, options);
  return Circuit.create(input, { electrical: TEST_ELECTRICAL, ...options });
};
