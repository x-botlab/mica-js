import { parseCanvas } from '@mica-js/core/canvas';
import type { CanvasExampleDefinition } from '@/examples/types';

const WIDGET_ANIMATION = '00000205-0000-4000-8000-000000000001';
const WIDGET_TEXT = '00000206-0000-4000-8000-000000000001';

const document = parseCanvas(
  JSON.stringify({
    version: 1,
    widgets: [
      {
        id: WIDGET_ANIMATION,
        widget: 'lab:animation',
        x: 120,
        y: 96,
        width: 220,
        height: 220,
        rotation: 0,
        properties: { speed: 1.2, sides: 6 },
      },
      {
        id: WIDGET_TEXT,
        widget: 'lab:text-display',
        x: 420,
        y: 116,
        width: 300,
        height: 200,
        rotation: 0,
        properties: { placeholder: '点击输入…' },
      },
    ],
  }),
);

/** 自由拖拽、缩放与面板添加实例。 */
export const SIMPLE_CANVAS_EXAMPLE: CanvasExampleDefinition = Object.freeze({
  kind: 'canvas',
  id: 'simple-canvas',
  title: '简单画布',
  capability: '拖动 / 缩放 / 面板添加',
  summary: '拖动、缩放、从组件面板添加实例；运行模式看动画。',
  category: 'editor',
  devices: ['lab:animation', 'lab:text-display'],
  document,
  showPalette: true,
});
