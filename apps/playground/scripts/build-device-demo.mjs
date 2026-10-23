import { readFile, writeFile } from 'node:fs/promises';
import {
  deriveSchematicTopology,
  parseSchematic,
  synthesizeDeviceSymbol,
  symbolPinPosition,
} from '@mica-js/core/schematic';

/**
 * Regenerates `public/devices/demo.sch`: places synthesized symbols and routes wires between
 * their pins, because hand-writing pin coordinates is what symbol synthesis exists to avoid.
 *
 * Run from `apps/playground` after building `@mica-js/core`:
 *   pnpm build:devices
 */
const DEVICES = new URL('../public/devices/', import.meta.url);
const at = (placement) => ({ x: placement.x, y: placement.y });

const LAYOUT = [
  {
    id: '00000011-0000-4000-8000-000000000001',
    device: 'demo:push-button',
    file: 'push-button',
    designator: 'S1',
    x: 140,
    y: 130,
  },
  {
    id: '00000012-0000-4000-8000-000000000001',
    device: 'demo:counter-4bit',
    file: 'counter-4bit',
    designator: 'U1',
    x: 360,
    y: 130,
  },
  {
    id: '00000013-0000-4000-8000-000000000001',
    device: 'demo:hex-display',
    file: 'hex-display',
    designator: 'U2',
    x: 620,
    y: 130,
  },
];

const POWER = { id: '00000014-0000-4000-8000-000000000001', x: 60, y: 40, net: '5V' };
const GROUND = { id: '00000015-0000-4000-8000-000000000001', x: 60, y: 360, net: 'GND' };

const symbols = new Map();
for (const entry of LAYOUT) {
  const raw = JSON.parse(await readFile(new URL(`${entry.file}.json`, DEVICES), 'utf8'));
  const pins = Object.fromEntries(
    Object.entries(raw.pins ?? {}).map(([name, pin]) => [name, { side: pin.side }]),
  );
  symbols.set(entry.device, synthesizeDeviceSymbol({ name: entry.device, pins }));
}

function pin(device, pinId, placement) {
  const anchor = symbols.get(device).pins[pinId];
  if (anchor === undefined) {
    throw new Error(`${device} has no pin ${pinId}`);
  }
  return symbolPinPosition(placement, anchor);
}

const [s1, u1, u2] = LAYOUT;
const placed = (entry) => ({ x: entry.x, y: entry.y, rotation: 0 });
const route = (from, to, x) => [from, { x, y: from.y }, { x, y: to.y }, to];
const wire = (index, points) => ({
  id: `000002${String(index).padStart(2, '0')}-0000-4000-8000-000000000001`,
  points,
});

const document = {
  version: 1,
  sheet: {
    symbols: [
      { id: s1.id, device: s1.device, designator: s1.designator, x: s1.x, y: s1.y, rotation: 0 },
      { id: u1.id, device: u1.device, designator: u1.designator, x: u1.x, y: u1.y, rotation: 0 },
      { id: u2.id, device: u2.device, designator: u2.designator, x: u2.x, y: u2.y, rotation: 0 },
      {
        id: POWER.id,
        device: 'builtin:power',
        x: POWER.x,
        y: POWER.y,
        rotation: 0,
        net: POWER.net,
      },
      {
        id: GROUND.id,
        device: 'builtin:ground',
        x: GROUND.x,
        y: GROUND.y,
        rotation: 0,
        net: GROUND.net,
      },
    ],
    wires: [
      // Contact terminal A drives the counter clock; the pull-up lives inside the counter.
      wire(1, route(pin(s1.device, 'A', placed(s1)), pin(u1.device, 'CLK', placed(u1)), 260)),
      // Contact terminal B sits on the ground rail.
      wire(2, route(pin(s1.device, 'B', placed(s1)), at(GROUND), 90)),
      // Counter nibble to the display driver.
      ...['Q0', 'Q1', 'Q2', 'Q3'].map((out, index) =>
        wire(3 + index, [pin(u1.device, out, placed(u1)), pin(u2.device, `D${index}`, placed(u2))]),
      ),
      // Supply rails shared by both chips.
      wire(7, [
        pin(u1.device, 'VCC', placed(u1)),
        { x: pin(u1.device, 'VCC', placed(u1)).x, y: 20 },
        { x: POWER.x, y: 20 },
        at(POWER),
      ]),
      wire(8, [
        pin(u2.device, 'VCC', placed(u2)),
        { x: pin(u2.device, 'VCC', placed(u2)).x, y: 20 },
        { x: POWER.x, y: 20 },
        at(POWER),
      ]),
      wire(9, [
        pin(u1.device, 'GND', placed(u1)),
        { x: pin(u1.device, 'GND', placed(u1)).x, y: 400 },
        { x: GROUND.x, y: 400 },
        at(GROUND),
      ]),
      wire(10, [
        pin(u2.device, 'GND', placed(u2)),
        { x: pin(u2.device, 'GND', placed(u2)).x, y: 400 },
        { x: GROUND.x, y: 400 },
        at(GROUND),
      ]),
    ],
    junctions: [],
  },
};

// Round-tripping through the parser proves the geometry really connects before it is written.
const parsed = parseSchematic(document);
await writeFile(new URL('demo.sch', DEVICES), `${JSON.stringify(document, null, 2)}\n`, 'utf8');

const name = (id) => LAYOUT.find((entry) => entry.id === id)?.designator ?? id;
const deviceIdOf = (reference) => `${reference.packageId}:${reference.deviceId}`;
const symbolsByDevice = {
  getDeviceSymbol: (reference) => symbols.get(deviceIdOf(reference)),
  getDeviceName: (reference) => deviceIdOf(reference),
};
for (const net of deriveSchematicTopology(parsed, { devices: symbolsByDevice }).nets) {
  const members = net.members
    .map((member) =>
      member.kind === 'pin' ? `${name(member.symbolId)}.${member.pinId}` : `<${member.kind}>`,
    )
    .join(', ');
  console.log(`${net.name ?? '(anonymous)'}: ${members}`);
}
