import { createHash } from 'node:crypto';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceRegistry, FusedDocument, PackageFiles } from '@mica-js/document/fused';
import type { HeadlessRuntimeOptions } from '@mica-js/sdk/fused';

export const buttonSource = `device Button() {
  pin a1;
  pin a2 = [resistor(to: a1, resistance: 0.001)];
  pin b1;
  pin b2 = [resistor(to: b1, resistance: 0.001)];
  input channel pressed: bool(capacity: 8, overflow: Overflow.drop_oldest);
  process start {
    loop {
      const value = await pressed.receive();
      if value {
        a1.intent <- [resistor(to: b1, resistance: 1)];
      } else {
        a1.intent <- [];
      }
    }
  }
}`;
export const ledSource = `device Led() {
  pin anode = [resistor(to: cathode, resistance: 1000)];
  pin cathode;
  output channel brightness: number(capacity: 64);
  fn report() {
    const a = anode.sample.voltage;
    const k = cathode.sample.voltage;
    if a != none && k != none {
      brightness.send(max(0, min(1, (a - k) / 5)));
    } else {
      brightness.send(0);
    }
  }
  process start { report(); }
  reaction anodeChanged on anode.sample.voltage as (previous, next) { report(); }
  reaction cathodeChanged on cathode.sample.voltage as (previous, next) { report(); }
}`;

const hash = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function packageFiles(
  name: string,
  pins: readonly string[],
  methods: object,
  events: object,
): Promise<PackageFiles> {
  const manifest = {
    publisher: 'test',
    name,
    version: '1.0.0',
    displayName: name,
    engines: { mica: '^1.0.0' },
    pins: Object.fromEntries(pins.map((pin) => [pin, {}])),
    model: { entry: 'model.js', methods, events },
    view2d: {
      geometry: {
        sizing: 'physical',
        bounds: { x: 0, y: 0, width: Math.max(2, pins.length), height: 2 },
        bodyBounds: { x: 0, y: 0, width: Math.max(2, pins.length), height: 2 },
        pins: Object.fromEntries(
          pins.map((pin, index) => [
            pin,
            {
              position: { x: index, y: 1 },
              outward: { x: index ? 1 : -1, y: 0 },
            },
          ]),
        ),
      },
    },
  };
  const encoder = new TextEncoder();
  const bytes = new Map([
    ['package.json', encoder.encode(JSON.stringify(manifest))],
    ['model.js', encoder.encode('export const testFixture = true;')],
  ]);
  const files = Object.fromEntries(
    [...bytes].map(([path, data]) => [path, { size: data.length, integrity: hash(data) }]),
  );
  const release = { id: `test:${name}`, version: '1.0.0', files };
  return {
    lock: {
      id: release.id,
      version: release.version,
      integrity: hash(encoder.encode(canonical(release))),
    },
    files,
    async read(path) {
      const data = bytes.get(path);
      if (!data) throw new Error(`Missing fixture file ${path}`);
      return data.slice();
    },
  };
}

export async function buttonLedCircuit(): Promise<Omit<HeadlessRuntimeOptions, 'step'>> {
  const [button, led, buttonIR, ledIR] = await Promise.all([
    packageFiles(
      'button',
      ['a1', 'a2', 'b1', 'b2'],
      { press: { params: { type: 'boolean' }, returns: { type: 'null' } } },
      {},
    ),
    packageFiles(
      'led',
      ['anode', 'cathode'],
      { getBrightness: { params: { type: 'null' }, returns: { type: 'number' } } },
      { onDidBrightnessChange: { type: 'number' } },
    ),
    compileDDL(buttonSource),
    compileDDL(ledSource),
  ]);
  const packages = new Map([
    [button.lock.id, button],
    [led.lock.id, led],
  ]);
  const registry: DeviceRegistry = {
    async open(lock) {
      const files = packages.get(lock.id);
      if (!files || files.lock.integrity !== lock.integrity)
        throw new Error(`Unknown fixture release ${lock.id}`);
      return files;
    },
  };
  const buttonId = '11111111-1111-4111-8111-111111111111';
  const ledId = '22222222-2222-4222-8222-222222222222';
  const document: FusedDocument = {
    version: 2,
    dependencies: Object.fromEntries(
      [...packages].map(([id, files]) => [
        id,
        { version: files.lock.version, integrity: files.lock.integrity },
      ]),
    ),
    instances: [
      {
        id: buttonId,
        device: button.lock.id,
        designator: 'S1',
        placement: { x: 0, y: 0, rotation: 0 },
      },
      { id: ledId, device: led.lock.id, designator: 'D1', placement: { x: 4, y: 0, rotation: 0 } },
    ],
    nodes: [],
    wires: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        from: { kind: 'pin', instance: buttonId, pin: 'b1' },
        to: { kind: 'pin', instance: ledId, pin: 'anode' },
        bends: [],
      },
    ],
    labels: [],
    references: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        target: { kind: 'pin', instance: buttonId, pin: 'a1' },
        voltage: 5,
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        target: { kind: 'pin', instance: ledId, pin: 'cathode' },
        voltage: 0,
      },
    ],
  };
  return {
    document,
    registry,
    async loadModule(files, path) {
      if (path !== 'model.js') throw new Error(`Unknown fixture module ${path}`);
      if (files.lock.id === button.lock.id) {
        return {
          model: buttonIR,
          create: (context: { inputs: { pressed: { send(value: boolean): void } } }) => ({
            methods: {
              press(value: boolean) {
                context.inputs.pressed.send(value);
                return null;
              },
            },
            sync() {},
            dispose() {},
          }),
        };
      }
      if (files.lock.id === led.lock.id) {
        return {
          model: ledIR,
          create(context: { events: { onDidBrightnessChange: { fire(value: number): void } } }) {
            let brightness = 0;
            context.events.onDidBrightnessChange.fire(brightness);
            return {
              methods: { getBrightness: () => brightness },
              sync(batch: { outputs: Readonly<Record<string, readonly { value: unknown }[]>> }) {
                for (const message of batch.outputs.brightness ?? []) {
                  if (typeof message.value !== 'number')
                    throw new TypeError('Invalid brightness output');
                  brightness = message.value;
                  context.events.onDidBrightnessChange.fire(brightness);
                }
              },
              dispose() {},
            };
          },
        };
      }
      throw new Error(`Unknown fixture module ${files.lock.id}`);
    },
  };
}
