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

/** Four-sided symbol used by the rotation and pin-label tests. */
function ne555Devices() {
  return createDeviceRegistry([
    {
      packageId: 'pkg',
      devices: [
        {
          id: 'ne555',
          symbol: {
            name: 'NE555',
            bounds: { x: -40, y: -50, width: 80, height: 100 },
            pins: {
              TRIG: { x: -60, y: -20, side: 'left' },
              OUT: { x: 60, y: 0, side: 'right' },
              VCC: { x: 0, y: -70, side: 'top' },
              GND: { x: 0, y: 70, side: 'bottom' },
            },
          },
        },
      ],
    },
  ]);
}

/** Scene of a single NE555 placed at `rotation`. */
function sceneAt(rotation: number) {
  return buildSchematicScene({
    document: parseSchematic({
      version: 1,
      id: `rotated-${rotation}`,
      sheet: {
        symbols: [{ id: 'U1', device: 'pkg:ne555', x: 0, y: 0, rotation }],
        wires: [],
        junctions: [],
      },
    }),
    devices: ne555Devices(),
    theme: DARK_SCHEMATIC_THEME,
  });
}

function textItem(rotation: number, text: string) {
  const item = sceneAt(rotation).items.find(
    (entry) => entry.kind === 'text' && entry.text === text,
  );
  return item?.kind === 'text' ? item : undefined;
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

  it('draws pin stubs and labels according to the declared side', () => {
    const sided = ne555Devices();
    const scene = buildSchematicScene({
      document: parseSchematic({
        version: 1,
        id: 'sided',
        sheet: {
          symbols: [{ id: 'U1', device: 'pkg:ne555', x: 0, y: 0, rotation: 0 }],
          wires: [],
          junctions: [],
        },
      }),
      devices: sided,
      theme: DARK_SCHEMATIC_THEME,
    });

    const lines = scene.items.filter((item) => item.kind === 'line');
    // Left stub: from the body edge (x = -40) to the anchor (x = -60), at the pin's y.
    expect(lines).toContainEqual({
      kind: 'line',
      from: { x: -40, y: -20 },
      to: { x: -60, y: -20 },
      color: DARK_SCHEMATIC_THEME.pin,
      width: 1.2,
    });
    // Right stub.
    expect(lines).toContainEqual({
      kind: 'line',
      from: { x: 40, y: 0 },
      to: { x: 60, y: 0 },
      color: DARK_SCHEMATIC_THEME.pin,
      width: 1.2,
    });
    // Top and bottom stubs are vertical.
    expect(lines).toContainEqual({
      kind: 'line',
      from: { x: 0, y: -50 },
      to: { x: 0, y: -70 },
      color: DARK_SCHEMATIC_THEME.pin,
      width: 1.2,
    });
    expect(lines).toContainEqual({
      kind: 'line',
      from: { x: 0, y: 50 },
      to: { x: 0, y: 70 },
      color: DARK_SCHEMATIC_THEME.pin,
      width: 1.2,
    });

    const rotationOf = (text: string): number | undefined => {
      const item = scene.items.find((entry) => entry.kind === 'text' && entry.text === text);
      return item?.kind === 'text' ? item.rotation : undefined;
    };
    expect(rotationOf('TRIG')).toBe(0);
    expect(rotationOf('VCC')).toBe(-90);
    expect(rotationOf('GND')).toBe(-90);

    const reference = scene.items.find((item) => item.kind === 'text' && item.text === 'U1');
    expect(reference).toMatchObject({ align: 'left', baseline: 'bottom' });
  });

  it('turns the device name with quarter turns and keeps text upright at half turns', () => {
    expect(textItem(90, 'NE555')).toMatchObject({ rotation: 90 });
    expect(textItem(270, 'NE555')).toMatchObject({ rotation: -90 });
    expect(textItem(180, 'NE555')).toMatchObject({
      rotation: 0,
      align: 'center',
      baseline: 'middle',
    });
  });

  it('flips pin names instead of drawing them upside down', () => {
    expect(textItem(0, 'TRIG')).toMatchObject({ rotation: 0, align: 'left' });
    expect(textItem(90, 'TRIG')).toMatchObject({ rotation: 90, align: 'left' });
    expect(textItem(180, 'TRIG')).toMatchObject({ rotation: 0, align: 'right' });
    expect(textItem(270, 'TRIG')).toMatchObject({ rotation: -90, align: 'left' });
    expect(textItem(180, 'VCC')).toMatchObject({ rotation: 90 });
    expect(textItem(180, 'GND')).toMatchObject({ rotation: 90 });
  });

  it('flips the reference designator with the symbol', () => {
    expect(textItem(90, 'U1')).toMatchObject({ rotation: 90, align: 'left', baseline: 'bottom' });
    expect(textItem(180, 'U1')).toMatchObject({ rotation: 0, align: 'right', baseline: 'top' });
    expect(textItem(270, 'U1')).toMatchObject({
      rotation: -90,
      align: 'left',
      baseline: 'bottom',
    });
  });

  it('infers the side when a pin omits it', () => {
    const inferred = createDeviceRegistry([
      {
        packageId: 'pkg',
        devices: [
          {
            id: 'plain',
            symbol: {
              name: 'PLAIN',
              bounds: { x: -20, y: -20, width: 40, height: 40 },
              pins: { P: { x: -40, y: 0 } },
            },
          },
        ],
      },
    ]);
    const scene = buildSchematicScene({
      document: parseSchematic({
        version: 1,
        id: 'inferred',
        sheet: {
          symbols: [{ id: 'U1', device: 'pkg:plain', x: 0, y: 0, rotation: 0 }],
          wires: [],
          junctions: [],
        },
      }),
      devices: inferred,
      theme: DARK_SCHEMATIC_THEME,
    });
    expect(scene.items.filter((item) => item.kind === 'line')).toContainEqual({
      kind: 'line',
      from: { x: -20, y: 0 },
      to: { x: -40, y: 0 },
      color: DARK_SCHEMATIC_THEME.pin,
      width: 1.2,
    });
  });
});
