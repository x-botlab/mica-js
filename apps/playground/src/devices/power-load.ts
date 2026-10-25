import type { Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins, pinMap } from './shared';

/**
 * Gated buffer with a declared power domain (RFC 0007).
 *
 * The part exists to make the power demo observable:
 *
 * - `powerDomains: [{ name: 'vdd', voltage: 3.3 }]` gives the host a domain it
 *   can switch with `Circuit.turnOff('U3', 'vdd')`. The compiled circuit then
 *   releases every driver of the device, forces its samples to a determinate
 *   `0` and skips its phases, while the *configuration and output latches stay*.
 * - The `enable` topic is the interactive path a widget can drive: it gates the
 *   buffer inside the powered device, which is what the bench can show without
 *   an executor-level power API.
 *
 * `OUT` mirrors `IN` while the device is powered **and** enabled, so a reader
 * can tell the two gates apart: turning `enable` off keeps the device running,
 * turning the domain off stops it entirely.
 */

/** Package device id of the gated buffer. */
export const POWER_LOAD_DEVICE = 'lab:power-load';

/** IR device type of the gated buffer. */
export const POWER_LOAD_TYPE = 'power-load';

/** Pins block of the device-package description. */
export const POWER_LOAD_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(['IN'], 'left'),
    ...packagePins(['OUT'], 'right'),
  },
  ports: {
    enable: {
      title: '使能',
      description: 'true 时 OUT 跟随 IN；false 时 OUT 输出低电平。',
      direction: 'input',
      type: 'boolean',
    },
    state: {
      title: '输出状态',
      description: 'OUT 当前驱动的电平。',
      direction: 'output',
      type: 'boolean',
    },
  },
  designatorPrefix: 'U',
});

function tick(api: DeviceBehaviorApi): void {
  const b = api.builder;
  const input = api.pin('IN').sampleDigital();
  const enabled = api.state<'bool'>('enable').load();
  const level = b.bool.and(enabled, input);
  api.pin('OUT').writeDigital(level);
  api.state<'bool'>('level').store(level);
}

function update(api: DeviceBehaviorApi): void {
  api.topics.publish('state', [api.state<'bool'>('level').load()]);
}

/** Unified-IR description of the gated buffer. */
export function createPowerLoadDescription(): DeviceDescription {
  return {
    name: POWER_LOAD_TYPE,
    pins: {
      ...pinMap(['IN'], 'input'),
      ...pinMap(['OUT'], 'output'),
    },
    states: {
      enable: { type: 'bool', initial: true },
      level: { type: 'bool', initial: false },
    },
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      enable: { direction: 'input', type: 'boolean', title: '使能' },
      state: { direction: 'output', type: 'boolean', title: '输出状态' },
    },
    behaviors: {
      initialize: (api) => {
        api.pin('IN').configure('high-z');
        api.pin('IN').pull('down');
        api.pin('OUT').configure('push-pull');
        api.pin('OUT').writeDigital(api.builder.const('bool', false));
        api.topics.subscribe('enable', (handler) => {
          const value = handler.args[0];
          handler
            .state<'bool'>('enable')
            .store(
              value === undefined ? handler.builder.const('bool', true) : (value as Value<'bool'>),
            );
        });
      },
      tick,
      update,
    },
  };
}
