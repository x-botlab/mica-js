import { parseCanvas } from '@mica-js/core/canvas';
import { documentOf, pinOf, route, symbol, wire } from '@/examples/builders/schematic';
import type { CanvasExampleDefinition } from '@/examples/types';

/**
 * Analog write path: the slider publishes volts into `lab:mcp4725`, the device drives
 * `VOUT`, the solver puts that voltage on the net and the `lab:probe` test point on the
 * same net reports what it settled to.
 */

const SLIDER = '00000302-0000-4000-8000-000000000001';
const METER = '00000303-0000-4000-8000-000000000001';

const dac = symbol(3, 'lab:mcp4725', 520, 220, { designator: 'U1' });
const probe = symbol(4, 'lab:probe', 820, 240, { designator: 'TP1' });
const supply = symbol(1, 'builtin:power', 400, 80, { net: '3V3' });
const ground = symbol(2, 'builtin:ground', 400, 420, { net: 'GND' });

const schematic = documentOf(
  [supply, ground, dac, probe],
  [
    wire(9, route(pinOf(dac, 'VOUT'), pinOf(probe, 'TIP'))),
    wire(10, route(pinOf(supply, 'VDD'), pinOf(dac, 'VDD'))),
    wire(11, route(pinOf(dac, 'GND'), pinOf(ground, 'GND'))),
  ],
);

const document = parseCanvas(
  JSON.stringify({
    version: 1,
    widgets: [
      {
        id: SLIDER,
        widget: 'lab:potentiometer',
        x: 80,
        y: 80,
        width: 150,
        height: 220,
        rotation: 0,
        properties: { label: '设定', initial: 0.5, maxVoltage: 3.3 },
        bindings: { voltage: { symbol: dac.id, port: 'voltage' } },
      },
      {
        id: METER,
        widget: 'lab:voltmeter',
        x: 420,
        y: 100,
        width: 240,
        height: 140,
        rotation: 0,
        properties: { label: 'TP1', maxVoltage: 3.3 },
        bindings: { value: { symbol: probe.id, port: 'voltage' } },
      },
    ],
  }),
);

/** 滑杆 → pin.writeAnalog → 解网 → 测试点 pin.sampleAnalog → 电压表。 */
export const DAC_VOLTMETER_EXAMPLE: CanvasExampleDefinition = Object.freeze({
  kind: 'canvas',
  id: 'dac-voltmeter',
  title: '滑杆 → 电压表',
  capability: 'pin.writeAnalog · 解网回读',
  summary: '滑杆写入设定电压，DAC 驱动 VOUT，测试点把解网后的电压送进电压表。',
  category: 'capability',
  devices: ['lab:mcp4725', 'lab:probe', 'lab:potentiometer', 'lab:voltmeter'],
  document,
  schematic,
});
