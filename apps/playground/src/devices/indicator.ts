import type { Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins } from './shared';

/**
 * Boolean wire: the canvas examples publish a widget value into `input` and the
 * widget bound to `output` repaints with the latched level.
 *
 * The part mirrors one topic to the other and drives a real pin, so the example
 * works both as a schematic symbol and as the simulation endpoint behind a
 * widget binding.
 */

/** Package device id of the indicator. */
export const INDICATOR_DEVICE = 'lab:indicator';

/** IR device type of the indicator. */
export const INDICATOR_TYPE = 'indicator';

/** Pins block of the device-package description. */
export const INDICATOR_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(['IN'], 'left'),
    ...packagePins(['OUT'], 'right'),
  },
  ports: {
    input: {
      title: '输入电平',
      description: 'widget 发布的布尔值；写入后由 update 同步到 output。',
      direction: 'input',
      type: 'boolean',
    },
    output: {
      title: '输出电平',
      description: '最近一次输入电平，供 LED 等 widget 绑定。',
      direction: 'output',
      type: 'boolean',
    },
  },
  designatorPrefix: 'D',
});

function initialize(api: DeviceBehaviorApi): void {
  api.pin('OUT').configure('push-pull');
  api.pin('OUT').writeDigital(api.builder.const('bool', false));
  api.pin('IN').configure('high-z');
  api.pin('IN').pull('down');

  api.topics.subscribe('input', (handler) => {
    const value = handler.args[0];
    if (value === undefined) return;
    handler.state<'bool'>('level').store(value as Value<'bool'>);
    handler.state<'bool'>('updated').store(handler.builder.const('bool', true));
  });
}

function update(api: DeviceBehaviorApi): void {
  const b = api.builder;
  const level = api.state<'bool'>('level').load();
  const updated = api.state<'bool'>('updated').load();
  // `updated` is set by the input handler above, so one publish per delivered value instead of
  // one per tick. Without it the widget host sees an unchanged payload 30 times a second.
  api.topics.publish('output', [level], updated);
  api.pin('OUT').writeDigital(level);
  api.state<'bool'>('updated').store(b.const('bool', false));
}

/** Unified-IR description of the indicator. */
export function createIndicatorDescription(): DeviceDescription {
  return {
    name: INDICATOR_TYPE,
    pins: {
      IN: { direction: 'input' },
      OUT: { direction: 'output' },
    },
    states: {
      level: { type: 'bool', initial: false },
      updated: { type: 'bool', initial: false },
    },
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      input: { direction: 'input', type: 'boolean', title: '输入电平' },
      output: { direction: 'output', type: 'boolean', title: '输出电平' },
    },
    behaviors: { initialize, update },
  };
}
