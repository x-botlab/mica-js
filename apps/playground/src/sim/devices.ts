import {
  parseDeviceDescription,
  type DeviceDefinition,
  type IDeviceProvider,
} from '@mica-js/device';
import buttonCode from '../../../../packages/device/examples/ideal-button/ideal-button.js?raw';
import buttonDescription from '../../../../packages/device/examples/ideal-button/ideal-button.json?raw';
import relayCode from '../../../../packages/device/examples/ideal-relay/ideal-relay.js?raw';
import relayDescription from '../../../../packages/device/examples/ideal-relay/ideal-relay.json?raw';
import mcuCode from '../../../../packages/device/examples/teaching-mcu/teaching-mcu.js?raw';
import mcuDescription from '../../../../packages/device/examples/teaching-mcu/teaching-mcu.json?raw';

export const BUTTON_DEVICE = 'mica:ideal-button';
export const RELAY_DEVICE = 'mica:ideal-relay';
export const MCU_DEVICE = 'mica:teaching-mcu';

interface RawExample {
  readonly description: string;
  readonly code: string;
}

/**
 * The committed example pairs from `packages/device/examples`, read verbatim at build time.
 *
 * The bench is the first in-repo consumer of those files, so it loads exactly the bytes the
 * device package ships as its author-facing examples instead of keeping a second copy.
 */
const EXAMPLES: Readonly<Record<string, RawExample>> = Object.freeze({
  [BUTTON_DEVICE]: { description: buttonDescription, code: buttonCode },
  [RELAY_DEVICE]: { description: relayDescription, code: relayCode },
  [MCU_DEVICE]: { description: mcuDescription, code: mcuCode },
});

/** Provider over the committed examples; parsing happens once per device id. */
export function createExampleProvider(): IDeviceProvider {
  const cache = new Map<string, DeviceDefinition>();
  return {
    resolve(deviceId: string): DeviceDefinition | undefined {
      const cached = cache.get(deviceId);
      if (cached !== undefined) {
        return cached;
      }
      const raw = EXAMPLES[deviceId];
      if (raw === undefined) {
        return undefined;
      }
      const definition = parseDeviceDescription(JSON.parse(raw.description) as unknown, {
        name: deviceId,
      });
      const resolved: DeviceDefinition = Object.freeze({ definition, code: raw.code });
      cache.set(deviceId, resolved);
      return resolved;
    },
  };
}
