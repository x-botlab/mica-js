import { describe, expect, it } from 'vitest';
import { createDeviceRegistry, parseSchematic, type SchematicDocument } from '@mica/core/schematic';
import { buildSchematicScene, type SceneItem } from './scene';
import { DARK_SCHEMATIC_THEME, LIGHT_SCHEMATIC_THEME } from './theme';

const devices = createDeviceRegistry([
  {
    packageId: 'pkg',
    devices: [
      {
        id: 'mcu',
        displayName: 'STM32',
        symbol: {
          name: 'MCU',
          pins: { PC0: { x: 0, y: 0 }, PC1: { x: 0, y: -10 } },
          bounds: { x: -20, y: -20, width: 40, height: 40 },
        },
      },
    ],
  },
]);

const document: SchematicDocument = parseSchematic({
  version: 1,
  id: 'scene',
  sheet: {
    symbols: [
      { id: 'u1', device: 'pkg:mcu', x: 100, y: 100, rotation: 0 },
      { id: 'L1', device: 'builtin:label', x: 200, y: 100, rotation: 0 },
      { id: 'P1', device: 'builtin:power', x: 0, y: 0, rotation: 0, properties: { label: '3V3' } },
      { id: 'G1', device: 'builtin:ground', x: 0, y: 60, rotation: 0 },
    ],
    wires: [
      {
        id: 'w1',
        points: [
          { x: 100, y: 100 },
          { x: 200, y: 100 },
        ],
      },
      {
        id: 'w2',
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 40 },
        ],
      },
      {
        id: 'w3',
        points: [
          { x: 0, y: 60 },
          { x: 0, y: 80 },
        ],
      },
    ],
    junctions: [],
  },
});

function texts(items: readonly SceneItem[]): string[] {
  return items.filter((item) => item.kind === 'text').map((item) => item.text);
}

describe('buildSchematicScene', () => {
  it('draws wires, symbols and builtin glyphs', () => {
    const scene = buildSchematicScene({ document, devices, theme: DARK_SCHEMATIC_THEME });
    const polylines = scene.items.filter((item) => item.kind === 'polyline');
    expect(polylines).toHaveLength(3);
    expect(scene.items.some((item) => item.kind === 'rect')).toBe(true);
    expect(texts(scene.items)).toContain('MCU');
    expect(texts(scene.items)).toContain('L1');
    expect(texts(scene.items)).toContain('3V3');
    expect(texts(scene.items)).toContain('GND');
  });

  it('centers the device name on the symbol', () => {
    const scene = buildSchematicScene({ document, devices, theme: DARK_SCHEMATIC_THEME });
    const label = scene.items.find((item) => item.kind === 'text' && item.text === 'MCU');
    expect(label).toMatchObject({
      align: 'center',
      baseline: 'middle',
      position: { x: 100, y: 100 },
    });
  });

  it('uses theme colors for every element', () => {
    const dark = buildSchematicScene({ document, devices, theme: DARK_SCHEMATIC_THEME });
    const light = buildSchematicScene({ document, devices, theme: LIGHT_SCHEMATIC_THEME });
    const darkWire = dark.items.find((item) => item.kind === 'polyline');
    const lightWire = light.items.find((item) => item.kind === 'polyline');
    expect(darkWire).toMatchObject({ color: DARK_SCHEMATIC_THEME.wire });
    expect(lightWire).toMatchObject({ color: LIGHT_SCHEMATIC_THEME.wire });
    expect(dark.background).toBe(DARK_SCHEMATIC_THEME.background);
    expect(light.background).toBe(LIGHT_SCHEMATIC_THEME.background);
  });

  it('applies selection and hover colors', () => {
    const scene = buildSchematicScene({
      document,
      devices,
      theme: DARK_SCHEMATIC_THEME,
      selection: { wires: new Set(['w1']), symbols: new Set(['u1']) },
      hover: { kind: 'wire', id: 'w2', segment: 0 },
    });
    const selected = scene.items.find(
      (item) => item.kind === 'polyline' && item.color === DARK_SCHEMATIC_THEME.wireSelected,
    );
    const hovered = scene.items.find(
      (item) => item.kind === 'polyline' && item.color === DARK_SCHEMATIC_THEME.hover,
    );
    expect(selected).toBeDefined();
    expect(hovered).toBeDefined();
  });

  it('draws the pending wire only in wire mode', () => {
    const pendingWire = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    const wireScene = buildSchematicScene({
      document,
      devices,
      theme: DARK_SCHEMATIC_THEME,
      tool: 'wire',
      pendingWire,
    });
    const selectScene = buildSchematicScene({
      document,
      devices,
      theme: DARK_SCHEMATIC_THEME,
      tool: 'select',
      pendingWire,
    });
    expect(
      wireScene.items.some((item) => item.kind === 'polyline' && item.dash !== undefined),
    ).toBe(true);
    expect(
      selectScene.items.some((item) => item.kind === 'polyline' && item.dash !== undefined),
    ).toBe(false);
  });

  it('uses a placeholder for symbols without geometry', () => {
    const scene = buildSchematicScene({
      document: {
        ...document,
        sheet: {
          ...document.sheet,
          symbols: [{ id: 'x1', device: 'unknown:device', x: 5, y: 5, rotation: 0 }],
        },
      } as SchematicDocument,
      devices,
      theme: DARK_SCHEMATIC_THEME,
    });
    const rect = scene.items.find((item) => item.kind === 'rect');
    expect(rect).toMatchObject({ stroke: DARK_SCHEMATIC_THEME.symbolPlaceholder, dash: [4, 3] });
  });

  it('draws net names on wires when labels are enabled', () => {
    const scene = buildSchematicScene({ document, devices, theme: DARK_SCHEMATIC_THEME });
    expect(texts(scene.items)).toContain('L1');
  });

  it('exposes the grid from the theme', () => {
    const scene = buildSchematicScene({ document, devices, theme: DARK_SCHEMATIC_THEME });
    expect(scene.grid).toEqual({
      size: DARK_SCHEMATIC_THEME.gridSize,
      minor: DARK_SCHEMATIC_THEME.grid,
      major: DARK_SCHEMATIC_THEME.gridMajor,
    });
    const hidden = buildSchematicScene({
      document,
      devices,
      theme: DARK_SCHEMATIC_THEME,
      display: { grid: false, labels: false },
    });
    expect(hidden.grid).toBeUndefined();
  });

  it('renders without a device provider', () => {
    const scene = buildSchematicScene({ document, theme: DARK_SCHEMATIC_THEME });
    expect(scene.items.length).toBeGreaterThan(0);
  });
});
