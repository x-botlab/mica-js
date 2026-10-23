import { readFile } from 'node:fs/promises';
import {
  createPowerRuntime,
  createScheduler,
  type ElectricalPinInput,
  type PowerDefinition,
  type PowerRuntime,
  type Scheduler,
  type TopologyConnectionPatch,
  type TopologyDefinition,
  type TopologyPinRef,
  type TopologyRuntime,
} from '@mica-js/core';
import {
  createDeviceInstance,
  loadDeviceModule,
  parseDeviceDescription,
  type DeviceDefinition,
  type DeviceInstance,
  type IDeviceProvider,
} from '../index';

/**
 * End-to-end rig shared by the #58 scenarios: committed example modules are read back from
 * their real sibling `.json` / `.js` files, loaded through the public provider + loader path,
 * and installed on the real scheduler, IR kernel, power runtime and topology.
 */
const EXAMPLES = new URL('../../examples/', import.meta.url);

const EXAMPLE_FILES: Readonly<Record<string, string>> = Object.freeze({
  'mica:ideal-button': 'ideal-button',
  'mica:ideal-relay': 'ideal-relay',
});

export const BUTTON_DEVICE_ID = 'mica:ideal-button';
export const RELAY_DEVICE_ID = 'mica:ideal-relay';

export interface FixtureOverride {
  /** Replacement description object for a negative scenario. */
  readonly description?: Readonly<Record<string, unknown>>;
  /** Replacement implementation source for a negative scenario. */
  readonly code?: string;
}

/** File-backed provider; each call resolves the committed example pair or a test override. */
export function exampleProvider(
  overrides: Readonly<Record<string, FixtureOverride>> = {},
): IDeviceProvider {
  return {
    async resolve(deviceId: string): Promise<DeviceDefinition | undefined> {
      const base = EXAMPLE_FILES[deviceId];
      if (base === undefined) {
        return undefined;
      }
      const override = overrides[deviceId];
      const raw =
        override?.description === undefined
          ? (JSON.parse(
              await readFile(new URL(`${base}/${base}.json`, EXAMPLES), 'utf8'),
            ) as Record<string, unknown>)
          : override.description;
      const definition = parseDeviceDescription(raw, { name: deviceId });
      const code =
        override?.code ?? (await readFile(new URL(`${base}/${base}.js`, EXAMPLES), 'utf8'));
      return { definition, code };
    },
  };
}

/** Reads back the committed description object of one example before it is parsed. */
export async function readExampleDescription(
  deviceId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const base = EXAMPLE_FILES[deviceId];
  if (base === undefined) {
    throw new Error(`Unknown example ${deviceId}`);
  }
  return JSON.parse(await readFile(new URL(`${base}/${base}.json`, EXAMPLES), 'utf8')) as Record<
    string,
    unknown
  >;
}

export const MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
});

export function pinState(
  instanceId: string,
  pinName: string,
  overrides: Partial<ElectricalPinInput> = {},
): ElectricalPinInput {
  return {
    instanceId,
    pinName,
    powerReady: true,
    mode: 'high-z',
    outputEnabled: false,
    pull: 'none',
    model: MODEL,
    ...overrides,
  };
}

interface Channel {
  readonly button: string;
  readonly relay: string;
  readonly suffix: string;
}

const CHANNELS: readonly Channel[] = Object.freeze([
  Object.freeze({ button: 'sw1', relay: 'k1', suffix: '1' }),
  Object.freeze({ button: 'sw2', relay: 'k2', suffix: '2' }),
]);

function signal(instanceId: string, pinName: string): TopologyPinRef {
  return { instanceId, pinName };
}

export interface CircuitOptions {
  /** Drives channel 1's coil high from t0 so initialize-time sampling can be observed. */
  readonly initialCoilHigh?: boolean;
}

/**
 * Two independent button/relay channels sharing one board. `VCC` powers the button/coil side
 * and the board logic domain; `LOAD` is the separate contact-side rail, which keeps the relay's
 * switched network electrically independent of its control side. The board owns the supplies,
 * the coil/sense pull-downs and the sense pins, so every voltage reading passes through the real
 * electrical network rather than a host-recorded value.
 */
export function circuit(options: CircuitOptions = {}): {
  readonly topology: TopologyDefinition;
  readonly power: PowerDefinition;
  readonly pinStates: readonly ElectricalPinInput[];
} {
  const pins = [
    { instanceId: 'board', pinName: 'VCC', kind: 'power' as const },
    { instanceId: 'board', pinName: 'LOAD', kind: 'power' as const },
    { instanceId: 'board', pinName: 'GND', kind: 'gnd' as const },
    ...CHANNELS.flatMap((channel) => [
      { instanceId: 'board', pinName: `COIL${channel.suffix}`, kind: 'signal' as const },
      { instanceId: 'board', pinName: `NO${channel.suffix}`, kind: 'signal' as const },
      { instanceId: 'board', pinName: `NC${channel.suffix}`, kind: 'signal' as const },
      { instanceId: channel.button, pinName: 'A', kind: 'signal' as const },
      { instanceId: channel.button, pinName: 'B', kind: 'signal' as const },
      { instanceId: channel.relay, pinName: 'IN', kind: 'signal' as const },
      { instanceId: channel.relay, pinName: 'COM', kind: 'signal' as const },
      { instanceId: channel.relay, pinName: 'NO', kind: 'signal' as const },
      { instanceId: channel.relay, pinName: 'NC', kind: 'signal' as const },
    ]),
  ];
  const wires = CHANNELS.flatMap((channel) => {
    const suffix = channel.suffix;
    return [
      { wireId: `a${suffix}`, pins: [signal(channel.button, 'A'), signal('board', 'VCC')] },
      {
        wireId: `coil${suffix}`,
        pins: [
          signal(channel.button, 'B'),
          signal(channel.relay, 'IN'),
          signal('board', `COIL${suffix}`),
        ],
      },
      { wireId: `com${suffix}`, pins: [signal(channel.relay, 'COM'), signal('board', 'LOAD')] },
      {
        wireId: `no${suffix}`,
        pins: [signal(channel.relay, 'NO'), signal('board', `NO${suffix}`)],
      },
      {
        wireId: `nc${suffix}`,
        pins: [signal(channel.relay, 'NC'), signal('board', `NC${suffix}`)],
      },
    ];
  });
  const connections = CHANNELS.flatMap((channel) => [
    {
      instanceId: channel.button,
      connectionId: 'contact',
      pins: ['A', 'B'] as const,
      initial: 'open' as const,
    },
    {
      instanceId: channel.relay,
      connectionId: 'normallyOpen',
      pins: ['COM', 'NO'] as const,
      initial: 'open' as const,
    },
    {
      instanceId: channel.relay,
      connectionId: 'normallyClosed',
      pins: ['COM', 'NC'] as const,
      initial: 'closed' as const,
    },
  ]);
  const topology: TopologyDefinition = {
    pins,
    wires: [{ wireId: 'ground', pins: [signal('board', 'GND')], globalGnd: true }, ...wires],
    connections,
  };
  const pinStates = [
    pinState('board', 'VCC', { mode: 'analog', outputEnabled: true, voltageIntent: 5 }),
    pinState('board', 'LOAD', { mode: 'analog', outputEnabled: true, voltageIntent: 5 }),
    pinState('board', 'GND'),
    ...CHANNELS.flatMap((channel) => {
      const suffix = channel.suffix;
      const coil =
        options.initialCoilHigh === true && suffix === '1'
          ? pinState('board', `COIL${suffix}`, {
              mode: 'push-pull',
              outputEnabled: true,
              digitalIntent: true,
            })
          : pinState('board', `COIL${suffix}`, { pull: 'down' });
      return [
        coil,
        pinState('board', `NO${suffix}`, { pull: 'down' }),
        pinState('board', `NC${suffix}`, { pull: 'down' }),
        pinState(channel.button, 'A'),
        pinState(channel.button, 'B'),
        pinState(channel.relay, 'IN'),
        pinState(channel.relay, 'COM'),
        pinState(channel.relay, 'NO'),
        pinState(channel.relay, 'NC'),
      ];
    }),
  ];
  return {
    topology,
    power: {
      topology,
      devices: [
        {
          instanceId: 'board',
          powerDomains: {
            board: { supply: 'VCC', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
          },
          pins: Object.fromEntries(
            CHANNELS.flatMap((channel) => {
              const suffix = channel.suffix;
              return [
                [`NO${suffix}`, { powerDomain: 'board' }],
                [`NC${suffix}`, { powerDomain: 'board' }],
              ];
            }),
          ),
        },
      ],
    },
    pinStates,
  };
}

/** `TopologyRuntime` facade that records every accepted patch request in commit order. */
export function recordingTopology(
  runtime: TopologyRuntime,
  patches: TopologyConnectionPatch[],
): TopologyRuntime {
  return {
    instance: runtime.instance,
    submit(patch: TopologyConnectionPatch): void {
      // Record only accepted requests: a patch the runtime rejects was never committed.
      runtime.submit(patch);
      patches.push(patch);
    },
    updatePinStates: (states) => runtime.updatePinStates(states),
    refresh: (pins) => runtime.refresh(pins),
    connectionState: (instanceId, connectionId) =>
      runtime.connectionState(instanceId, connectionId),
    networks: () => runtime.networks(),
    networkOf: (pin) => runtime.networkOf(pin),
    floatingInput: (pin) => runtime.floatingInput(pin),
    destroy: () => runtime.destroy(),
  };
}

export interface Rig {
  readonly scheduler: Scheduler;
  readonly power: PowerRuntime;
  readonly topology: TopologyRuntime;
  /** Every `connection.apply` patch accepted by the bound topology, in commit order. */
  readonly patches: readonly TopologyConnectionPatch[];
  readonly buttons: ReadonlyMap<string, DeviceInstance>;
  readonly relays: ReadonlyMap<string, DeviceInstance>;
  press(buttonId: string, pressed: boolean): void;
  settle(): void;
  connection(instanceId: string, connectionId: string): 'open' | 'closed';
  voltage(pin: TopologyPinRef): number | null;
  /** Replaces the board supply intent through the real power control phase. */
  setSupply(voltage: number): void;
  /** Replaces one host-owned pin intent, for example a driven short or an unpowered rail. */
  setPin(state: ElectricalPinInput): void;
  destroy(): void;
}

/** Installs both example modules on one scheduler plus the shared board circuit. */
export async function createRig(options: CircuitOptions = {}): Promise<Rig> {
  const layout = circuit(options);
  const scheduler = createScheduler();
  const power = createPowerRuntime(scheduler, layout.power, {
    instanceId: 'power',
    pinStates: layout.pinStates,
    floating: { seed: 58 },
  });
  const patches: TopologyConnectionPatch[] = [];
  const topology = recordingTopology(power, patches);
  const provider = exampleProvider();
  const [buttonModule, relayModule] = await Promise.all([
    loadDeviceModule(BUTTON_DEVICE_ID, provider),
    loadDeviceModule(RELAY_DEVICE_ID, provider),
  ]);
  const buttons = new Map<string, DeviceInstance>();
  const relays = new Map<string, DeviceInstance>();
  for (const channel of CHANNELS) {
    buttons.set(
      channel.button,
      createDeviceInstance(buttonModule, scheduler, {
        instanceId: channel.button,
        pinHost: power,
        connections: { topology },
      }),
    );
    relays.set(
      channel.relay,
      createDeviceInstance(relayModule, scheduler, {
        instanceId: channel.relay,
        pinHost: power,
        connections: { topology },
      }),
    );
  }

  const voltage = (pin: TopologyPinRef): number | null => {
    const sample = power.sampleVoltage(pin);
    return sample.ready ? sample.voltage : null;
  };

  return {
    scheduler,
    power,
    topology,
    patches,
    buttons,
    relays,
    press(buttonId: string, pressed: boolean): void {
      const button = buttons.get(buttonId);
      if (button === undefined) {
        throw new Error(`Unknown button ${buttonId}`);
      }
      button.deliver('pressed', pressed, { simTime: scheduler.now });
    },
    settle(): void {
      scheduler.start();
      if (scheduler.state === 'faulted') {
        throw scheduler.error ?? new Error('Scheduler faulted without an error');
      }
    },
    connection(instanceId: string, connectionId: string): 'open' | 'closed' {
      return topology.connectionState(instanceId, connectionId);
    },
    voltage,
    setSupply(voltage: number): void {
      power.updatePinStates([
        pinState('board', 'VCC', { mode: 'analog', outputEnabled: true, voltageIntent: voltage }),
      ]);
    },
    setPin(state: ElectricalPinInput): void {
      power.updatePinStates([state]);
    },
    destroy(): void {
      for (const instance of [...buttons.values(), ...relays.values()]) {
        instance.destroy();
      }
      power.destroy();
    },
  };
}

/** Runs one scenario against a fresh rig and always releases the kernel instances. */
export async function withRig<T>(run: (rig: Rig) => T, options: CircuitOptions = {}): Promise<T> {
  const rig = await createRig(options);
  try {
    return run(rig);
  } finally {
    rig.destroy();
  }
}
