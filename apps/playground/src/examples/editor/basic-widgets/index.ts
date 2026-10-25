import { parseCanvas } from '@mica-js/core/canvas';
import { parseSchematic } from '@mica-js/core/schematic';
import type { CanvasExampleDefinition } from '@/examples/types';

const WIDGET_BUTTON = '00000201-0000-4000-8000-000000000001';
const WIDGET_SWITCH = '00000202-0000-4000-8000-000000000001';
const WIDGET_LED_KEY = '00000203-0000-4000-8000-000000000001';
const WIDGET_LED_POWER = '00000204-0000-4000-8000-000000000001';

const INDICATOR_KEY = '00000101-0000-4000-8000-000000000001';
const INDICATOR_POWER = '00000102-0000-4000-8000-000000000001';

/**
 * Two indicators stand in for the board: the button and the switch each publish
 * a boolean into `input`, and the LED widgets bind to the matching `output`.
 */
const schematic = parseSchematic(
  JSON.stringify({
    version: 1,
    sheet: {
      symbols: [
        {
          id: INDICATOR_KEY,
          device: 'lab:indicator',
          designator: 'D1',
          x: 860,
          y: 120,
          rotation: 0,
        },
        {
          id: INDICATOR_POWER,
          device: 'lab:indicator',
          designator: 'D2',
          x: 860,
          y: 300,
          rotation: 0,
        },
        {
          id: '00000103-0000-4000-8000-000000000001',
          device: 'builtin:power',
          x: 740,
          y: 40,
          rotation: 0,
          net: '3V3',
        },
        {
          id: '00000104-0000-4000-8000-000000000001',
          device: 'builtin:ground',
          x: 740,
          y: 440,
          rotation: 0,
          net: 'GND',
        },
      ],
      wires: [],
      junctions: [],
    },
  }),
);

const document = parseCanvas(
  JSON.stringify({
    version: 1,
    widgets: [
      {
        id: WIDGET_BUTTON,
        widget: 'demo:button',
        x: 80,
        y: 80,
        width: 84,
        height: 68,
        rotation: 0,
        properties: { label: '按键', radius: 8 },
        bindings: { press: { symbol: INDICATOR_KEY, port: 'input' } },
      },
      {
        id: WIDGET_SWITCH,
        widget: 'lab:power-switch',
        x: 80,
        y: 250,
        width: 150,
        height: 96,
        rotation: 0,
        properties: { label: '电源', on: true },
        bindings: { power: { symbol: INDICATOR_POWER, port: 'input' } },
      },
      {
        id: WIDGET_LED_KEY,
        widget: 'lab:led',
        x: 520,
        y: 76,
        width: 96,
        height: 116,
        rotation: 0,
        properties: { label: '按键灯', onColor: '#F97316' },
        bindings: { on: { symbol: INDICATOR_KEY, port: 'output' } },
      },
      {
        id: WIDGET_LED_POWER,
        widget: 'lab:led',
        x: 520,
        y: 246,
        width: 96,
        height: 116,
        rotation: 0,
        properties: { label: '电源灯', onColor: '#22C55E' },
        bindings: { on: { symbol: INDICATOR_POWER, port: 'output' } },
      },
    ],
  }),
);

/** 按钮 / 开关 / LED 通过布尔指示器互通。 */
export const BASIC_WIDGETS_EXAMPLE: CanvasExampleDefinition = Object.freeze({
  kind: 'canvas',
  id: 'basic-widgets',
  title: '基础 Widget',
  capability: 'widget ↔ 器件端口绑定',
  summary: '按钮、开关与 LED：widget 通过 lab:indicator 的布尔端口互通。',
  category: 'editor',
  devices: ['lab:indicator', 'demo:button', 'lab:power-switch', 'lab:led'],
  document,
  schematic,
});
