import {
  createDeviceRegistry,
  nextDesignator,
  parseDeviceReference,
  parseSchematic,
  parseView,
  symbolPinPosition,
  type Placement,
  type Point,
  type SchematicDocument,
  type SchematicViewDocument,
} from '@mica/core/schematic';

const MCU = 'stm32-package:stm32g431rbt6-lqfp64';
const LCD = 'lcd-package:ct117e-m4-tft-lcd-2-4';
const TIMER = 'timer-package:ne555';

/** Symbol geometry the canvas synthesizes from; the editor reads it through `devices`. */
export const devices = createDeviceRegistry([
  {
    packageId: 'stm32-package',
    devices: [
      {
        id: 'stm32g431rbt6-lqfp64',
        displayName: 'STM32G431',
        raw: {
          pins: {
            PC0: { side: 'left' },
            PC1: { side: 'left' },
            PA0: { side: 'left' },
            PA1: { side: 'left' },
            PB6: { side: 'right' },
            PB7: { side: 'right' },
            VDD: { side: 'top' },
            VSS: { side: 'bottom' },
          },
          properties: {
            label: { type: 'string', default: 'MCU' },
            speed: { type: 'number', default: 72 },
            enabled: { type: 'boolean', default: true },
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
        raw: {
          pins: {
            D0: { side: 'left' },
            D1: { side: 'left' },
            D2: { side: 'left' },
            VCC: { side: 'top' },
            GND: { side: 'bottom' },
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
        raw: {
          pins: {
            TRIG: { side: 'left' },
            RESET: { side: 'left' },
            CONT: { side: 'left' },
            THRES: { side: 'left' },
            DISCHG: { side: 'left' },
            OUT: { side: 'right' },
            VCC: { side: 'top' },
            GND: { side: 'bottom' },
          },
        },
      },
    ],
  },
]);

/** Host-owned catalog; the editor only ever receives the device reference. */
export interface DeviceEntry {
  readonly device: string;
  readonly name: string;
  readonly note: string;
  /** Prefix the host hands to `nextDesignator` for this part. */
  readonly prefix: string;
}

export const DEVICE_LIBRARY: readonly DeviceEntry[] = [
  { device: MCU, name: 'STM32G431RB', note: 'stm32-package', prefix: 'U' },
  { device: LCD, name: 'TFT LCD 2.4"', note: 'lcd-package', prefix: 'DS' },
  { device: TIMER, name: 'NE555', note: 'timer-package', prefix: 'U' },
];

/**
 * Reference-designator policy per module: the host knows its own library, so it picks the
 * prefix (`U` for IC modules, `DS` for displays) instead of the editor guessing.
 */
export function createDesignator(device: string, document: SchematicDocument): string {
  const prefix = DEVICE_LIBRARY.find((entry) => entry.device === device)?.prefix ?? 'U';
  return nextDesignator(document, prefix);
}

const placements = {
  mcu: { x: 480, y: 200, rotation: 0 },
  lcd: { x: 136, y: 60, rotation: 0 },
  timer: { x: 300, y: 380, rotation: 0 },
  label: { x: 268, y: 150, rotation: 0 },
  power: { x: 480, y: 120, rotation: 0 },
  ground: { x: 480, y: 300, rotation: 0 },
} as const satisfies Record<string, Placement>;

/** Resolves a placed pin through the synthesized symbol, so wiring never hardcodes geometry. */
function pin(device: string, pinId: string, placement: Placement): Point {
  const reference = parseDeviceReference(device);
  const anchor =
    reference === undefined ? undefined : devices.getDeviceSymbol(reference)?.pins[pinId];
  if (anchor === undefined) {
    throw new Error(`Device ${device} has no pin ${pinId}.`);
  }
  return symbolPinPosition(placement, anchor);
}

function at(placement: Placement): Point {
  return { x: placement.x, y: placement.y };
}

const mcuD0 = pin(MCU, 'PC0', placements.mcu);
const lcdD0 = pin(LCD, 'D0', placements.lcd);
const lcdD1 = pin(LCD, 'D1', placements.lcd);
const mcuVdd = pin(MCU, 'VDD', placements.mcu);
const mcuVss = pin(MCU, 'VSS', placements.mcu);
const timerOut = pin(TIMER, 'OUT', placements.timer);
const trunkX = 250;

const schematicText = JSON.stringify(
  {
    version: 1,
    id: 'ct117e-m4-board',
    sheet: {
      symbols: [
        { id: 's-mcu', device: MCU, ...placements.mcu, properties: { label: 'MCU' } },
        { id: 's-lcd', device: LCD, ...placements.lcd },
        { id: 'u2', device: TIMER, ...placements.timer },
        { id: 'lcd-l-d2', device: 'builtin:label', ...placements.label, net: 'D2' },
        { id: 'p3v3', device: 'builtin:power', ...placements.power, net: '3V3' },
        { id: 'gnd', device: 'builtin:ground', ...placements.ground, net: 'GND' },
      ],
      wires: [
        {
          id: 'w-d0',
          points: [mcuD0, { x: trunkX, y: mcuD0.y }, { x: trunkX, y: lcdD0.y }, lcdD0],
        },
        {
          id: 'w-label',
          points: [
            { x: trunkX, y: placements.label.y },
            { x: placements.label.x, y: placements.label.y },
          ],
        },
        { id: 'w-vcc', points: [mcuVdd, at(placements.power)] },
        { id: 'w-gnd', points: [mcuVss, at(placements.ground)] },
        {
          id: 'w-out',
          points: [
            timerOut,
            { x: 420, y: timerOut.y },
            { x: 420, y: 470 },
            { x: 60, y: 470 },
            { x: 60, y: lcdD1.y },
            lcdD1,
          ],
        },
      ],
      junctions: [{ id: 'j-label', x: trunkX, y: placements.label.y, wires: ['w-d0', 'w-label'] }],
    },
  },
  null,
  2,
);

const viewText = JSON.stringify(
  {
    version: 1,
    id: 'ct117e-m4-board-2d',
    schematic: 'schematic.sch',
    layout: {
      's-mcu': { x: 480, y: 200, rotation: 0 },
      's-lcd': { x: 136, y: 60, rotation: 0 },
    },
  },
  null,
  2,
);

export const schematic: SchematicDocument = parseSchematic(schematicText);
export const view: SchematicViewDocument = parseView(viewText);
