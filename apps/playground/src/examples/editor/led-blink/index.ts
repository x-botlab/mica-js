import { documentOf, pinOf, route, symbol, wire } from '@/examples/builders/schematic';
import type { SchematicExampleDefinition } from '@/examples/types';

const mcu = symbol(1, 'mica:teaching-mcu', 260, 220, { designator: 'U1' });
const led = symbol(2, 'board:led', 620, 200, {
  designator: 'D1',
  properties: { color: '#F97316' },
});
const anode = pinOf(led, 'A');
const cathode = pinOf(led, 'K');
const ground = symbol(3, 'builtin:ground', cathode.x, cathode.y + 130, { net: 'GND' });

/** GPIO 翻转 LED 的最小原理图。 */
export const LED_BLINK_EXAMPLE: SchematicExampleDefinition = Object.freeze({
  kind: 'schematic',
  id: 'led-blink',
  title: 'LED 闪烁',
  capability: 'teaching-mcu GPIO 输出',
  summary: 'teaching-mcu 的 GPIO 驱动 LED：把定时翻转固件换成你自己的。',
  category: 'editor',
  devices: ['mica:teaching-mcu', 'board:led'],
  document: documentOf(
    [mcu, led, ground],
    [wire(9, route(pinOf(mcu, 'GPIO'), anode)), wire(10, [cathode, { x: cathode.x, y: ground.y }])],
  ),
});
