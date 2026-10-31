import { createDeviceRegistry, synthesizeDeviceSymbol } from '@mica-js/core/schematic';
import type { DeviceReference, DeviceSymbolProvider } from '@mica-js/core/schematic';
import type {
  DeviceBehaviorApi,
  DeviceConfig,
  DeviceDescription,
  DeviceInputIo,
  DeviceOutputIo,
} from '../unified-ir/compiler';
import type { SchematicDeviceBinding, SchematicDeviceTopic } from '../unified-ir/runtime';

/**
 * Minimal device package the host tests supply themselves.
 *
 * The simulator ships no built-in models after RFC 0018 moved them out, so the tests describe one
 * caller-owned toggle lamp exactly the way an application would: a reference, a description with
 * step-boundary hooks, and the endpoints those hooks serve.
 */
export const TOGGLE_DEVICE = 'test:toggle';
export const TOGGLE_TYPE = 'toggle-ir';
export const TOGGLE_SYMBOL = '7f6e5d4c-3b2a-4a19-8f70-615243546576';

const TOPICS: readonly SchematicDeviceTopic[] = Object.freeze([
  Object.freeze({
    port: 'lamp',
    direction: 'input' as const,
    type: 'boolean' as const,
    title: 'Lamp',
  }),
  Object.freeze({
    port: 'state',
    direction: 'output' as const,
    type: 'boolean' as const,
    title: 'Lamp state',
  }),
]);

/** Copies the hook-asserted `input` state onto `lamp`, so publishing has an observable effect. */
export function toggleDescription(): DeviceDescription {
  return Object.freeze({
    pins: Object.freeze({ out: Object.freeze({ kind: 'signal' as const }) }),
    factory: () => undefined,
    states: Object.freeze({
      input: Object.freeze({ type: 'bool' as const, initial: false }),
      lamp: Object.freeze({ type: 'bool' as const, initial: false }),
    }),
    behaviors: Object.freeze({
      update: (api: DeviceBehaviorApi) => {
        api.state<'bool'>('lamp').store(api.state<'bool'>('input').load());
      },
    }),
    applyInputs: (io: DeviceInputIo) => {
      const payload = io.takeInput('lamp');
      if (payload === undefined) return;
      if (typeof payload !== 'boolean') throw new TypeError('lamp expects a boolean payload');
      io.writeState('input', payload);
    },
    flushOutputs: (io: DeviceOutputIo) => {
      io.publish('state', io.readState('lamp'));
    },
  });
}

/** One standalone toggle device for a programmatic bench. */
export function toggleDevice(id = 'toggle1'): DeviceConfig {
  return Object.freeze({ id, type: TOGGLE_TYPE, description: toggleDescription() });
}

/** Binding the schematic host resolves `test:toggle` to. */
export function toggleBinding(): SchematicDeviceBinding {
  return Object.freeze({
    type: TOGGLE_TYPE,
    description: toggleDescription(),
    topics: TOPICS,
  });
}

/** Resolver the host tests pass in; unknown references are left to the host to reject. */
export function resolveToggleDevice(
  reference: DeviceReference,
): SchematicDeviceBinding | undefined {
  return reference.raw === TOGGLE_DEVICE ? toggleBinding() : undefined;
}

/** Symbol geometry for `test:toggle`, so the derived topology has one pin per symbol. */
export function createToggleSymbols(): DeviceSymbolProvider {
  return createDeviceRegistry([
    {
      packageId: 'test',
      devices: [
        {
          id: 'toggle',
          displayName: 'Toggle',
          designatorPrefix: 'K',
          symbol: synthesizeDeviceSymbol({
            name: 'Toggle',
            pins: { out: { side: 'right' } },
          }),
        },
      ],
    },
  ]);
}
