import type { Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins, pinMap } from './shared';

/**
 * I²C bus master, reduced to the part the electrical model needs (RFC 0002).
 *
 * A real master bit-bangs both lines. What matters for the RFC is that it drives
 * them the same way a slave does: **open-drain with a weak pull-up**, never a
 * push-pull high. This model therefore releases both lines by default and lets
 * the `sda` topic sink SDA on demand, which is enough to show the wired-AND:
 *
 * ```text
 * master sinks SDA (pulls 0) + slave releases (pull-up)  -> node reads 0
 * master releases   (pull-up) + slave releases (pull-up)  -> node reads 1
 * ```
 *
 * It also gives the bus a second pin per wire, which a lone device pin cannot
 * provide: the solver only assigns `pin_voltage` to pins that share a net.
 */

/** Package device id of the master. */
export const I2C_MASTER_DEVICE = 'lab:i2c-master';

/** IR device type of the master. */
export const I2C_MASTER_TYPE = 'i2c-master';

/** Pins block of the device-package description. */
export const I2C_MASTER_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(['SCL', 'SDA'], 'left'),
  },
  pinGroups: {
    bus: { pins: ['SCL', 'SDA'] },
  },
  ports: {
    sda: {
      title: '拉低 SDA',
      description: 'true 时主机把 SDA 拉低（开漏导通）；false 时释放，让弱上拉决定电平。',
      direction: 'input',
      type: 'boolean',
    },
    scl: {
      title: '拉低 SCL',
      description: 'true 时主机把 SCL 拉低；用于观察时钟线也是开漏。',
      direction: 'input',
      type: 'boolean',
    },
  },
  designatorPrefix: 'U',
});

function initialize(api: DeviceBehaviorApi): void {
  const b = api.builder;
  for (const name of ['SCL', 'SDA']) {
    api.pin(name).configure('open-drain');
    api.pin(name).pull('up');
    // `true` releases an open-drain pin; the pull-up then holds the line high.
    api.pin(name).writeDigital(b.const('bool', true));
  }
  api.topics.subscribe('sda', (handler) => {
    const value = handler.args[0];
    handler
      .state<'bool'>('sinkSda')
      .store(value === undefined ? handler.builder.const('bool', true) : (value as Value<'bool'>));
  });
  api.topics.subscribe('scl', (handler) => {
    const value = handler.args[0];
    handler
      .state<'bool'>('sinkScl')
      .store(value === undefined ? handler.builder.const('bool', true) : (value as Value<'bool'>));
  });
}

function tick(api: DeviceBehaviorApi): void {
  const b = api.builder;
  // Sink = drive 0 with the open-drain stage, release = drive 1.
  api.pin('SDA').writeDigital(b.bool.not(api.state<'bool'>('sinkSda').load()));
  api.pin('SCL').writeDigital(b.bool.not(api.state<'bool'>('sinkScl').load()));
}

/** Unified-IR description of the master. */
export function createI2cMasterDescription(): DeviceDescription {
  return {
    name: I2C_MASTER_TYPE,
    pins: {
      ...pinMap(['SCL', 'SDA'], 'bidirectional'),
    },
    states: {
      sinkSda: { type: 'bool', initial: false },
      sinkScl: { type: 'bool', initial: false },
    },
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      sda: { direction: 'input', type: 'boolean', title: '拉低 SDA' },
      scl: { direction: 'input', type: 'boolean', title: '拉低 SCL' },
    },
    behaviors: { initialize, tick },
  };
}
