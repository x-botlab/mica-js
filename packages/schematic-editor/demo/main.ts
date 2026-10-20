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
      { "id": "s-mcu", "device": "stm32-package:stm32g431rbt6-lqfp64", "x": 480, "y": 160, "rotation": 0, "properties": { "label": "MCU" } },
      { "id": "s-lcd", "device": "lcd-package:ct117e-m4-tft-lcd-2-4", "x": 136, "y": 55, "rotation": 0 },
      { "id": "lcd-l-d0", "device": "builtin:label", "x": 300, "y": 100, "rotation": 0 },
      { "id": "p3v3", "device": "builtin:power", "x": 480, "y": 260, "rotation": 0, "properties": { "label": "3V3" } },
      { "id": "gnd", "device": "builtin:ground", "x": 380, "y": 300, "rotation": 0 }
    ],
    "wires": [
      {
        "id": "w-d0",
        "points": [{ "x": 480, "y": 160 }, { "x": 300, "y": 160 }, { "x": 300, "y": 55 }, { "x": 136, "y": 55 }]
      },
      { "id": "w-label-d0", "points": [{ "x": 300, "y": 124 }, { "x": 300, "y": 100 }] },
      { "id": "w-vcc", "points": [{ "x": 480, "y": 260 }, { "x": 480, "y": 220 }] },
      { "id": "w-gnd", "points": [{ "x": 380, "y": 300 }, { "x": 380, "y": 330 }] }
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
          name: 'MCU',
          bounds: { x: -30, y: -30, width: 60, height: 60 },
          pins: {
            PC0: { x: -30, y: 0 },
            PC1: { x: -30, y: 10 },
            PA0: { x: 30, y: 0 },
            VDD: { x: 0, y: 30 },
            VSS: { x: 0, y: -30 },
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
          bounds: { x: -50, y: -35, width: 100, height: 70 },
          pins: {
            D0: { x: 50, y: 0 },
            D1: { x: 50, y: 10 },
            VCC: { x: 0, y: 35 },
            GND: { x: 0, y: -35 },
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
