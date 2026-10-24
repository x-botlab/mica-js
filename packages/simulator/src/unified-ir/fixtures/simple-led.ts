import type { IRModule } from '@mica-js/ir';
import { LED_PIN, type LedDeviceConfig, type LedRuntime, type UnifiedPinMemory } from '../types';

/**
 * Generates the LED device into the unified module.
 *
 * ```text
 * led_update:
 *   let anode   = PIN_INPUT[anode]
 *   let cathode = PIN_INPUT[cathode]
 *   LED_STATE[i] = anode && !cathode
 * ```
 *
 * The device reads the solved input values, never the driver's output, so the
 * net solver stays the only place that decides what a load pin sees.
 */
export function generateLed(
  module: IRModule,
  device: LedDeviceConfig,
  memory: UnifiedPinMemory,
  stateIndex: number,
): LedRuntime {
  const anodePin = device.pinOffset + LED_PIN.anode;
  const cathodePin = device.pinOffset + LED_PIN.cathode;
  const update = module.func(`${device.deviceId}_update`, { params: [], results: [] });
  update.body((b) => {
    const anode = b.array.load(memory.input, b.const('u32', anodePin));
    const cathode = b.array.load(memory.input, b.const('u32', cathodePin));
    const on = b.bool.and(anode, b.bool.not(cathode));
    b.array.store(memory.ledState, b.const('u32', stateIndex), on);
    b.return([]);
  });

  return Object.freeze({ config: device, update, anodePin, cathodePin, stateIndex });
}
