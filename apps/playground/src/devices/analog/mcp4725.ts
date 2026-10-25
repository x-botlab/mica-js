import type { Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins } from '../shared';

/**
 * 12-bit I²C DAC driven by a widget instead of a bus write, so the contract that
 * matters here is the analog pin: `voltage` moves the intent and the solver puts it
 * on the net. A `lab:probe` on the same net reports what the net actually settled to.
 */

/** Package device id of the DAC. */
export const MCP4725_DEVICE = 'lab:mcp4725';

/** IR device type of the DAC. */
export const MCP4725_TYPE = 'mcp4725';

/** Pins block of the device-package description. */
export const MCP4725_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(['VDD'], 'top'),
    ...packagePins(['GND'], 'bottom'),
    VOUT: { kind: 'signal', side: 'right' },
  },
  ports: {
    voltage: {
      title: '设定电压',
      description: '0–VDD，单位 V；写入后驱动 VOUT。',
      direction: 'input',
      type: 'number',
    },
  },
  properties: {
    label: { type: 'string', title: '名称', default: 'DAC', maxLength: 24 },
    address: { type: 'enum', title: '地址', default: '0x60', options: ['0x60', '0x61'] },
  },
  designatorPrefix: 'U',
});

function clamp(api: DeviceBehaviorApi, value: Value<'f32'>): Value<'f32'> {
  const b = api.builder;
  const upper = b.const('f32', LOGIC_VOLTAGE);
  const lower = b.const('f32', 0);
  return b.select(
    b.float.cmp('gt', value, upper),
    upper,
    b.select(b.float.cmp('lt', value, lower), lower, value),
  );
}

function initialize(api: DeviceBehaviorApi): void {
  api.pin('VOUT').writeAnalog(0);

  api.topics.subscribe('voltage', (handler) => {
    const value = handler.args[0];
    if (value === undefined) {
      return;
    }
    // Payloads arrive as f64; the state and the pin intent are f32.
    const volts = handler.builder.convert.float('f32', value as Value<'f64'>);
    handler.state<'f32'>('voltage').store(volts);
  });
}

function tick(api: DeviceBehaviorApi): void {
  // `writeAnalog` is a latch the solver reads, so the intent is re-asserted every tick.
  api.pin('VOUT').writeAnalog(clamp(api, api.state<'f32'>('voltage').load()));
}

/** Unified-IR description of the DAC. */
export function createMcp4725Description(): DeviceDescription {
  return {
    name: MCP4725_TYPE,
    pins: {
      VDD: { direction: 'input', kind: 'power' },
      GND: { direction: 'input', kind: 'gnd' },
      VOUT: { direction: 'output' },
    },
    states: {
      voltage: { type: 'f32', initial: 0 },
    },
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      voltage: { direction: 'input', type: 'number', title: '设定电压' },
    },
    behaviors: { initialize, tick },
  };
}
