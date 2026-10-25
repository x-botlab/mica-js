import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { packagePins } from '../shared';

/**
 * Test point: one high-impedance input that reports the solved voltage of whatever
 * net it sits on.
 *
 * A driven analog pin alone on a net has no reference, so the solver leaves the net
 * at 0 V; measuring only means something once the probe shares the net with the
 * driver. The voltmeter widget binds to this device's `voltage` port.
 */

/** Package device id of the probe. */
export const PROBE_DEVICE = 'lab:probe';

/** IR device type of the probe. */
export const PROBE_TYPE = 'probe';

/** Pins block of the device-package description. */
export const PROBE_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(['TIP'], 'left'),
  },
  ports: {
    voltage: {
      title: '测得电压',
      description: '探针所在网络的解网电压，单位 V。',
      direction: 'output',
      type: 'number',
    },
  },
  properties: {
    label: { type: 'string', title: '名称', default: '电压表', maxLength: 24 },
  },
  designatorPrefix: 'TP',
});

function initialize(api: DeviceBehaviorApi): void {
  api.pin('TIP').configure('high-z');
}

function update(api: DeviceBehaviorApi): void {
  // Number payloads travel as f64; the pin reading is f32.
  api.topics.publish('voltage', [api.builder.convert.float('f64', api.pin('TIP').sampleAnalog())]);
}

/** Unified-IR description of the probe. */
export function createProbeDescription(): DeviceDescription {
  return {
    name: PROBE_TYPE,
    pins: {
      TIP: { direction: 'input' },
    },
    states: {},
    ports: {
      voltage: { direction: 'output', type: 'number', title: '测得电压' },
    },
    behaviors: { initialize, update },
  };
}
