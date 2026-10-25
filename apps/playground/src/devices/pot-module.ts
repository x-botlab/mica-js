import type { Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins } from './shared';

/**
 * Single-turn potentiometer: a voltage the host sets, driven onto `WIPER`.
 *
 * A widget cannot reach a pin, so the potentiometer is split in two:
 *
 * ```text
 * potentiometer widget --(topic: voltage)--> pot-module --(pin.writeAnalog)--> AIN0
 * ```
 *
 * The device is what makes the demo electrical: `pin.writeAnalog` stores a
 * voltage intent and switches `WIPER` into the analog drive mode, and the next
 * solve arbitrates that intent against the rails and every other driver on the
 * net. The ADC on the other side of the wire then reads it back with
 * `pin.sampleAnalog`.
 */

/** Package device id of the potentiometer. */
export const POT_MODULE_DEVICE = 'lab:pot-module';

/** IR device type of the potentiometer. */
export const POT_MODULE_TYPE = 'pot-module';

/** Strongest voltage the wiper can source. */
export const POT_MODULE_MAX_VOLTAGE = LOGIC_VOLTAGE;

/** Pins block of the device-package description. */
export const POT_MODULE_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(['VCC', 'GND'], 'left'),
    WIPER: { kind: 'signal', side: 'right' },
  },
  ports: {
    voltage: {
      title: '滑臂电压',
      description: '0–3.3 V；写入后立即驱动到 WIPER。',
      direction: 'input',
      type: 'number',
    },
  },
  designatorPrefix: 'RV',
});

function clamp(api: DeviceBehaviorApi, value: Value<'f32'>): Value<'f32'> {
  const b = api.builder;
  const upper = b.const('f32', POT_MODULE_MAX_VOLTAGE);
  const lower = b.const('f32', 0);
  return b.select(
    b.float.cmp('gt', value, upper),
    upper,
    b.select(b.float.cmp('lt', value, lower), lower, value),
  );
}

/** Unified-IR description of the potentiometer. */
export function createPotModuleDescription(): DeviceDescription {
  return {
    name: POT_MODULE_TYPE,
    pins: {
      VCC: { direction: 'input', kind: 'power' },
      GND: { direction: 'input', kind: 'gnd' },
      WIPER: { direction: 'output' },
    },
    states: {
      voltage: { type: 'f32', initial: 0 },
    },
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      voltage: { direction: 'input', type: 'number', title: '滑臂电压' },
    },
    behaviors: {
      initialize: (api) => {
        api.pin('WIPER').writeAnalog(0);
        api.topics.subscribe('voltage', (handler) => {
          const value = handler.args[0];
          if (value === undefined) return;
          handler
            .state<'f32'>('voltage')
            .store(handler.builder.convert.float('f32', value as Value<'f64'>));
        });
      },
      tick: (api) => {
        // Re-assert the intent every tick: `writeAnalog` is a latch, and the
        // solve may have released the pin when the domain was off.
        api.pin('WIPER').writeAnalog(clamp(api, api.state<'f32'>('voltage').load()));
      },
    },
  };
}
