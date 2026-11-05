import { describe, expect, it, vi } from 'vitest';
import { parseDeviceReference, parseSchematic } from '@mica-js/document/schematic';
import type { DeviceMetadata } from '@mica-js/sdk/metadata';
import { SchematicDevices } from './devices';
import { buildSchematicScene } from './render/scene';
import { LIGHT_SCHEMATIC_THEME as theme } from './render/theme';
import { CanvasSchematicRenderer } from './render/canvas-renderer';
import { IDENTITY_VIEWPORT } from './render/viewport';
import { hitTestSchematic } from './editing/query';
import { DocumentModel } from './model/document-model';
import { buildInspector } from './model/inspector';

const definition: DeviceMetadata = {
  kind: 'device',
  id: 'resistor',
  version: '1.0.0',
  displayName: 'Resistor',
  designatorPrefix: 'R',
  properties: {
    resistance: {
      type: 'number',
      required: false,
      default: 1000,
      unit: 'ohm',
      editor: { kind: 'number', min: 0, max: 10000, step: 1 },
    },
    tolerance: {
      type: 'enum',
      required: false,
      default: 'low',
      enumName: 'Tolerance',
      values: ['low', 'high'],
      editor: { kind: 'select', labels: { low: '1%', high: '5%' } },
    },
    data: { type: 'bytes', required: true },
  },
  pins: { a: { label: 'A' }, b: { label: 'B' } },
  ports: { reading: { direction: 'output', type: 'number', delivery: 'level' } },
  symbol: {
    bounds: { x: -40, y: -20, width: 80, height: 40 },
    graphics: [
      { type: 'line', from: [-40, 0], to: [-20, 0], strokeWidth: 2 },
      {
        type: 'polyline',
        points: [
          [-10, -5],
          [0, 5],
          [10, -5],
        ],
        closed: true,
        fill: 'foreground',
      },
      { type: 'rect', x: -20, y: -8, width: 40, height: 16, fill: 'background' },
      { type: 'circle', center: [0, 0], radius: 3 },
      {
        type: 'arc',
        center: [0, 0],
        radius: 8,
        startAngle: 30,
        sweepAngle: -120,
        fill: 'background',
      },
      { type: 'text', position: [0, 0], text: 'R', align: 'center', fontSize: 8 },
    ],
    pins: {
      a: { position: [-40, 0], direction: 'left', label: { visible: false } },
      b: {
        position: [40, 0],
        direction: 'right',
        label: { visible: true, position: [30, 0], align: 'right' },
      },
    },
    annotations: { designator: { position: [0, -16], align: 'center' } },
  },
};
const symbolId = '00000003-41e6-4a4c-869a-82a4cd304787';
function documentAt(rotation = 0) {
  return parseSchematic({
    version: 1,
    sheet: {
      symbols: [
        { id: symbolId, device: 'demo:resistor', designator: 'R1', x: 100, y: 100, rotation },
      ],
      wires: [],
      junctions: [],
    },
  });
}
async function prepare() {
  const resolve = vi.fn(async () => ({ definition, code: 'throw new Error("must not execute");' }));
  const devices = new SchematicDevices({ resolve });
  await devices.prepare(['demo:resistor']);
  return devices;
}

describe('device metadata integration', () => {
  it('synthesizes omitted symbols and rejects malformed metadata before rendering', async () => {
    const withoutSymbol: DeviceMetadata = {
      kind: 'device',
      id: 'resistor',
      version: '1.0.0',
      displayName: 'Resistor',
      pins: { a: {}, b: {} },
    };
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ definition: { ...definition, extra: true }, code: '' })
      .mockResolvedValueOnce({ definition: withoutSymbol, code: '' });
    const devices = new SchematicDevices({ resolve });
    await expect(devices.prepare(['demo:resistor'])).rejects.toThrow();
    await devices.prepare(['demo:resistor']);
    const symbol = devices.getDeviceSymbol(parseDeviceReference('demo:resistor')!);
    expect(Object.keys(symbol?.pins ?? {})).toEqual(['a', 'b']);
    expect(symbol?.graphics).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('loads metadata, exposes controls and connects at declared anchors', async () => {
    const devices = await prepare();
    const reference = parseDeviceReference('demo:resistor')!;
    expect(devices.getDeviceName(reference)).toBe('Resistor');
    expect(devices.getDeviceDesignatorPrefix(reference)).toBe('R');
    const document = documentAt();
    expect(hitTestSchematic(document, { x: 60, y: 100 }, { devices })).toEqual({
      kind: 'pin',
      symbolId,
      pinId: 'a',
    });
    // A custom symbol's bounding edge does not invent a pin stub through its body.
    expect(hitTestSchematic(document, { x: 70, y: 100 }, { devices })?.kind).toBe('symbol');
    const model = new DocumentModel({ value: document, devices });
    const inspector = buildInspector(document, [{ kind: 'symbol', id: symbolId }], {
      devices,
      topology: () => model.getTopology(),
    });
    expect(inspector?.kind).toBe('symbol');
    if (inspector?.kind !== 'symbol') throw new Error('Missing inspector');
    expect(inspector.properties.find((field) => field.key === 'resistance')).toMatchObject({
      type: 'number',
      defaultValue: 1000,
      min: 0,
      max: 10000,
      step: 1,
    });
    expect(inspector.properties.find((field) => field.key === 'tolerance')?.options).toEqual([
      { value: 'low', label: '1%' },
      { value: 'high', label: '5%' },
    ]);
    expect(inspector.properties.find((field) => field.key === 'data')).toMatchObject({
      type: 'binary',
      required: true,
    });
    model.dispose();
    devices.dispose();
  });

  it('renders all graphics, fill, labels and signed rotated arcs without an automatic body', async () => {
    const devices = await prepare();
    const scene = buildSchematicScene({
      document: documentAt(90),
      devices,
      theme,
      display: { grid: false, labels: true },
    });
    expect(scene.items.find((item) => item.kind === 'line')).toMatchObject({
      from: { x: 100, y: 60 },
      to: { x: 100, y: 80 },
      width: 2,
    });
    expect(scene.items.find((item) => item.kind === 'arc')).toMatchObject({
      center: { x: 100, y: 100 },
      startAngle: 120,
      sweepAngle: -120,
      fill: theme.symbolFill,
    });
    expect(scene.items.filter((item) => item.kind === 'polyline')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ closed: true, fill: theme.symbolStroke }),
        expect.objectContaining({ closed: true, fill: theme.symbolFill }),
      ]),
    );
    const texts = scene.items.filter((item) => item.kind === 'text');
    expect(texts.map((item) => item.text)).toEqual(['R', 'R1', 'B']);
    expect(texts.find((item) => item.text === 'R1')).toMatchObject({
      position: { x: 116, y: 100 },
      align: 'center',
      rotation: 90,
    });
    expect(texts.find((item) => item.text === 'B')).toMatchObject({
      position: { x: 100, y: 130 },
      align: 'right',
    });
    expect(scene.items.some((item) => item.kind === 'rect' && item.fill === theme.symbolFill)).toBe(
      false,
    );
    const hidden = buildSchematicScene({
      document: documentAt(),
      devices,
      theme,
      display: { grid: false, labels: false },
    });
    expect(hidden.items.filter((item) => item.kind === 'text').map((item) => item.text)).toEqual([
      'R',
      'R1',
    ]);
  });

  it.each([
    { rotation: 0, point: { x: 100, y: 84 }, reference: { x: 10, y: -16 } },
    { rotation: 90, point: { x: 116, y: 100 }, reference: { x: 0, y: -26 } },
    { rotation: 180, point: { x: 100, y: 116 }, reference: { x: -10, y: -16 } },
    { rotation: 270, point: { x: 84, y: 100 }, reference: { x: 0, y: -6 } },
  ])(
    'hits, drags and undoes designator anchors at $rotation degrees',
    async ({ rotation, point, reference }) => {
      const devices = await prepare();
      const document = documentAt(rotation);
      expect(hitTestSchematic(document, point, { devices })).toEqual({
        kind: 'reference',
        symbolId,
      });
      const model = new DocumentModel({ value: document, devices });
      model.moveReferenceBy(symbolId, 10, 0);
      expect(model.getValue().sheet.symbols[0]?.reference?.x).toBeCloseTo(reference.x);
      expect(model.getValue().sheet.symbols[0]?.reference?.y).toBeCloseTo(reference.y);
      model.undo();
      expect(model.getValue().sheet.symbols[0]?.reference).toBeUndefined();
      model.dispose();
    },
  );

  it('draws closed fills and clockwise/counterclockwise arc paths on Canvas', async () => {
    const devices = await prepare();
    const context = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fillText: vi.fn(),
    };
    const renderer = new CanvasSchematicRenderer({
      getContext: () => context,
    } as unknown as HTMLCanvasElement);
    renderer.resize(200, 200);
    const scene = buildSchematicScene({
      document: documentAt(),
      devices,
      theme,
      display: { grid: false, labels: true },
    });
    renderer.render(scene, IDENTITY_VIEWPORT);
    expect(context.closePath).toHaveBeenCalledTimes(2);
    expect(context.arc).toHaveBeenCalledWith(100, 100, 8, Math.PI / 6, -Math.PI / 2, true);
    expect(context.fill).toHaveBeenCalledTimes(3);
    renderer.render(
      {
        ...scene,
        items: [
          {
            kind: 'arc',
            center: { x: 1, y: 2 },
            radius: 3,
            startAngle: 0,
            sweepAngle: 90,
            stroke: '#000',
            width: 1,
          },
        ],
      },
      IDENTITY_VIEWPORT,
    );
    expect(context.arc).toHaveBeenLastCalledWith(1, 2, 3, 0, Math.PI / 2, false);
    renderer.destroy();
  });
});
