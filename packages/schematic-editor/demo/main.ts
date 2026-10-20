import {
  createDeviceRegistry,
  deriveSchematicTopology,
  parseSchematic,
  parseView,
  serializeSchematic,
  serializeView,
  type SchematicDocument,
  type SchematicHit,
  type SchematicViewDocument,
} from '@mica/core/schematic';
import { CanvasSchematicRenderer } from '../src/render/canvas-renderer';
import { buildSchematicScene } from '../src/render/scene';
import {
  DARK_SCHEMATIC_THEME,
  LIGHT_SCHEMATIC_THEME,
  resolveSchematicTheme,
  themeToCssVariables,
} from '../src/render/theme';
import { fitBounds, panBy, screenToPage, zoomAt, type ViewportState } from '../src/render/viewport';

const schematicText = `{
  "version": 1,
  "id": "ct117e-m4-board",
  "sheet": {
    "symbols": [
      { "id": "s-mcu", "device": "stm32-package:stm32g431rbt6-lqfp64", "x": 480, "y": 200, "rotation": 0, "properties": { "label": "MCU" } },
      { "id": "s-lcd", "device": "lcd-package:ct117e-m4-tft-lcd-2-4", "x": 136, "y": 55, "rotation": 0 },
      { "id": "u2", "device": "timer-package:ne555", "x": 300, "y": 340, "rotation": 0 },
      { "id": "lcd-l-d0", "device": "builtin:label", "x": 300, "y": 100, "rotation": 0 },
      { "id": "p3v3", "device": "builtin:power", "x": 480, "y": 330, "rotation": 0, "properties": { "label": "3V3" } },
      { "id": "gnd", "device": "builtin:ground", "x": 380, "y": 460, "rotation": 0 }
    ],
    "wires": [
      {
        "id": "w-d0",
        "points": [{ "x": 480, "y": 160 }, { "x": 300, "y": 160 }, { "x": 300, "y": 55 }, { "x": 136, "y": 55 }]
      },
      { "id": "w-label-d0", "points": [{ "x": 300, "y": 124 }, { "x": 300, "y": 100 }] },
      { "id": "w-vcc", "points": [{ "x": 480, "y": 330 }, { "x": 480, "y": 300 }] },
      { "id": "w-gnd", "points": [{ "x": 380, "y": 460 }, { "x": 380, "y": 490 }] }
    ],
    "junctions": [{ "id": "j-d0", "x": 300, "y": 124, "wires": ["w-d0", "w-label-d0"] }]
  }
}`;

const viewText = `{
  "version": 1,
  "id": "ct117e-m4-board-2d",
  "schematic": "schematic.sch",
  "layout": {
    "s-mcu": { "x": 480, "y": 160, "rotation": 0 },
    "s-lcd": { "x": 136, "y": 55, "rotation": 0 }
  }
}`;

const devices = createDeviceRegistry([
  {
    packageId: 'stm32-package',
    devices: [
      {
        id: 'stm32g431rbt6-lqfp64',
        displayName: 'STM32G431RBT6',
        symbol: {
          name: 'STM32G431',
          bounds: { x: -60, y: -50, width: 120, height: 100 },
          pins: {
            PC0: { x: -80, y: -30, side: 'left' },
            PC1: { x: -80, y: -10, side: 'left' },
            PA0: { x: -80, y: 10, side: 'left' },
            PA1: { x: -80, y: 30, side: 'left' },
            PB6: { x: 80, y: -30, side: 'right' },
            PB7: { x: 80, y: -10, side: 'right' },
            VDD: { x: 0, y: -70, side: 'top' },
            VSS: { x: 0, y: 70, side: 'bottom' },
          },
        },
      },
    ],
  },
  {
    packageId: 'lcd-package',
    devices: [
      {
        id: 'ct117e-m4-tft-lcd-2-4',
        displayName: 'TFT LCD 2.4"',
        symbol: {
          name: 'LCD',
          bounds: { x: -55, y: -40, width: 110, height: 80 },
          pins: {
            D0: { x: -75, y: -20, side: 'left' },
            D1: { x: -75, y: 0, side: 'left' },
            D2: { x: -75, y: 20, side: 'left' },
            VCC: { x: 0, y: -60, side: 'top' },
            GND: { x: 0, y: 60, side: 'bottom' },
          },
        },
      },
    ],
  },
  {
    packageId: 'timer-package',
    devices: [
      {
        id: 'ne555',
        displayName: 'NE555',
        symbol: {
          name: 'NE555',
          bounds: { x: -70, y: -60, width: 140, height: 120 },
          pins: {
            TRIG: { x: -95, y: -40, side: 'left' },
            RESET: { x: -95, y: -20, side: 'left' },
            CONT: { x: -95, y: 0, side: 'left' },
            THRES: { x: -95, y: 20, side: 'left' },
            DISCHG: { x: -95, y: 40, side: 'left' },
            OUT: { x: 95, y: 0, side: 'right' },
            VCC: { x: 0, y: -80, side: 'top' },
            GND: { x: 0, y: 80, side: 'bottom' },
          },
        },
      },
    ],
  },
]);

const schematic: SchematicDocument = parseSchematic(schematicText);
const view: SchematicViewDocument = parseView(viewText);

const host = document.querySelector<HTMLElement>('#host');
if (host === null) {
  throw new Error('missing host');
}

const canvas = document.createElement('canvas');
host.append(canvas);

let theme = DARK_SCHEMATIC_THEME;
const renderer = new CanvasSchematicRenderer(canvas, { theme });
let viewport: ViewportState = { scale: 1, offsetX: 0, offsetY: 0 };

function fit(): void {
  const topology = deriveSchematicTopology(schematic, { devices });
  const bounds = topology.bounds ?? { x: 0, y: 0, width: 100, height: 100 };
  viewport = fitBounds(bounds, { width: canvas.clientWidth, height: canvas.clientHeight }, 60);
  draw();
}

function draw(): void {
  const scene = buildSchematicScene({
    document: schematic,
    view,
    devices,
    theme,
    display: { grid: true, labels: true },
  });
  renderer.render(scene, viewport);
}

const hovered: SchematicHit | undefined = undefined;
void hovered;

let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (event) => {
  dragging = true;
  lastX = event.clientX;
  lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragging) {
    return;
  }
  viewport = panBy(viewport, event.clientX - lastX, event.clientY - lastY);
  lastX = event.clientX;
  lastY = event.clientY;
  draw();
});

canvas.addEventListener('pointerup', (event) => {
  dragging = false;
  canvas.releasePointerCapture(event.pointerId);
});

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    viewport = zoomAt(
      viewport,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      factor,
    );
    draw();
  },
  { passive: false },
);

function resize(): void {
  const ratio = window.devicePixelRatio || 1;
  renderer.resize(canvas.clientWidth, canvas.clientHeight, ratio);
  draw();
}

new ResizeObserver(resize).observe(host);
window.addEventListener('resize', resize);

function applyThemeToPage(): void {
  const variables = themeToCssVariables(theme);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = theme === DARK_SCHEMATIC_THEME ? 'dark' : 'light';
}

document.querySelector('#theme')?.addEventListener('click', () => {
  theme = theme === DARK_SCHEMATIC_THEME ? LIGHT_SCHEMATIC_THEME : DARK_SCHEMATIC_THEME;
  renderer.setTheme(theme);
  applyThemeToPage();
  draw();
});

document.querySelector('#fit')?.addEventListener('click', fit);

// Helpful when comparing serialization round-trips in the console.
Object.assign(globalThis, {
  mica: {
    schematic,
    view,
    serializeSchematic,
    serializeView,
    resolveSchematicTheme,
    screenToPage,
  },
});

applyThemeToPage();
resize();
fit();
