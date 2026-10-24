import type { IRModule } from '@mica-js/ir';
import {
  MCU_PIN,
  PIN_MODE,
  type McuDeviceConfig,
  type McuRuntime,
  type UnifiedPinMemory,
} from '../types';

/**
 * Generates the MCU device into the unified module.
 *
 * ```text
 * mcu_tick:
 *   let current = PIN_OUTPUT[PA0]
 *   PIN_OUTPUT[PA0] = !current
 *   PIN_MODE[PA0]   = PUSH_PULL
 * ```
 *
 * The mode store repeats every tick because the prototype MCU has no separate
 * configure phase; a real device would write it once when the pin is enabled.
 */
export function generateMcu(
  module: IRModule,
  device: McuDeviceConfig,
  memory: UnifiedPinMemory,
): McuRuntime {
  const outputPin = device.pinOffset + MCU_PIN.PA0;
  const tick = module.func(`${device.deviceId}_tick`, { params: [], results: [] });
  tick.body((b) => {
    const index = b.const('u32', outputPin);
    const current = b.array.load(memory.output, index);
    b.array.store(memory.output, index, b.bool.not(current));
    b.array.store(memory.mode, index, b.const('u8', PIN_MODE.pushPull));
    b.return([]);
  });

  return Object.freeze({ config: device, tick, outputPin });
}
