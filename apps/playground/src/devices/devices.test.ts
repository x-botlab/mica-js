import { describe, expect, it } from 'vitest';
import { Circuit, type DeviceConfig, type DeviceDescription } from '@mica-js/simulator';
import { createAdcModuleDescription } from './adc-module';
import { createDacModuleDescription } from './dac-module';
import { createI2cEepromDescription } from './i2c-eeprom';
import { createI2cMasterDescription } from './i2c-master';
import { createLedMatrixDescription } from './led-matrix';
import { createPotModuleDescription } from './pot-module';
import { createPowerLoadDescription } from './power-load';
import { createSerialConsoleDescription } from './serial-console';
import { createShiftRegisterDescription } from './shift-register';
import { PLAYGROUND_DEVICES, createPlaygroundDefinition, resolvePlaygroundDevice } from './index';

interface PublishRecord {
  readonly symbol: string;
  readonly port: string;
  readonly payload: unknown;
}

function device(id: string, type: string, description: DeviceConfig['description']): DeviceConfig {
  return { id, type, description };
}

/** Runs one tick and returns the publishes it produced. */
function tickOnce(
  circuit: { step(): unknown },
  published: PublishRecord[],
): readonly PublishRecord[] {
  const before = published.length;
  circuit.step();
  return published.slice(before);
}

describe('playground device catalogue', () => {
  it('parses every package description and binds it to an IR description', () => {
    for (const entry of PLAYGROUND_DEVICES) {
      const definition = createPlaygroundDefinition(entry.id);
      expect(definition, entry.id).toBeDefined();
      expect(definition?.definition.pins.size).toBeGreaterThan(0);
      expect(definition?.definition.ports.size).toBeGreaterThan(0);

      const binding = resolvePlaygroundDevice({ deviceId: entry.deviceId });
      expect(binding?.type).toBe(entry.deviceId);
      expect(binding?.description?.ports).toBeDefined();
    }
  });

  it('declares the RFC 0004 groups on the parts that use them', () => {
    const matrix = createPlaygroundDefinition('lab:led-matrix');
    expect([...(matrix?.definition.pinGroups.keys() ?? [])]).toEqual(['data', 'rows']);
    const shifter = createPlaygroundDefinition('lab:shift-register');
    expect([...(shifter?.definition.pinGroups.keys() ?? [])]).toEqual(['serial', 'outputs']);
  });
});

describe('adc + pot (RFC 0002 analog)', () => {
  async function build() {
    const published: PublishRecord[] = [];
    const circuit = await Circuit.create(
      {
        devices: [
          device('RV1', 'pot-module', createPotModuleDescription()),
          device('U1', 'adc-module', createAdcModuleDescription()),
        ],
        connections: [{ from: 'RV1.WIPER', to: 'U1.AIN0' }],
      },
      { validateIR: true },
    );
    circuit.onPublish((publish) => {
      published.push({
        symbol: publish.target.symbol,
        port: publish.target.port,
        payload: publish.payload,
      });
    });
    return { circuit, published };
  }

  it('samples the driven wiper voltage through the electrical net', async () => {
    const { circuit, published } = await build();
    circuit.deliverTopic('RV1', 'voltage', 2);
    circuit.step();
    circuit.step();
    circuit.deliverTopic('U1', 'read', true);
    circuit.step();

    const channels = published.filter((entry) => entry.symbol === 'U1' && entry.port === 'ch0');
    expect(channels.length).toBeGreaterThan(0);
    expect(channels.at(-1)?.payload).toBeCloseTo(2, 3);
    // The other inputs are floating loads: a determinate 0 V.
    expect(circuit.samplePinVoltage('U1', 'AIN0')).toBeCloseTo(2, 3);
    expect(circuit.samplePinVoltage('U1', 'AIN1')).toBeCloseTo(0, 3);
    circuit.dispose();
  });

  it('clamps the wiper to its 3.3 V supply', async () => {
    const { circuit, published } = await build();
    circuit.deliverTopic('RV1', 'voltage', 9);
    circuit.step();
    circuit.step();
    circuit.deliverTopic('U1', 'read', true);
    circuit.step();
    const channels = published.filter((entry) => entry.symbol === 'U1' && entry.port === 'ch0');
    expect(channels.at(-1)?.payload).toBeCloseTo(3.3, 3);
    circuit.dispose();
  });
});

describe('dac (RFC 0002 writeAnalog)', () => {
  it('drives VOUT0 onto the wire and the ADC reads the same volts back', async () => {
    const published: PublishRecord[] = [];
    const circuit = await Circuit.create({
      devices: [
        device('U1', 'dac-module', createDacModuleDescription()),
        device('U2', 'adc-module', createAdcModuleDescription()),
      ],
      connections: [{ from: 'U1.VOUT0', to: 'U2.AIN0' }],
    });
    circuit.onPublish((publish) => {
      published.push({
        symbol: publish.target.symbol,
        port: publish.target.port,
        payload: publish.payload,
      });
    });

    circuit.deliverTopic('U1', 'vout0', 1.25);
    circuit.step();
    circuit.deliverTopic('U2', 'read', true);
    circuit.step();

    const ch0 = published.filter((entry) => entry.symbol === 'U2' && entry.port === 'ch0');
    expect(ch0.at(-1)?.payload).toBeCloseTo(1.25, 3);
    // The second channel was never written, so its intent stays at 0 V.
    const ch1 = published.filter((entry) => entry.symbol === 'U2' && entry.port === 'ch1');
    expect(ch1.at(-1)?.payload).toBeCloseTo(0, 3);
    circuit.dispose();
  });
});

describe('led matrix (RFC 0004 pin groups)', () => {
  it('latches one row per tick from the row and data buses', async () => {
    const published: PublishRecord[] = [];
    const circuit = await Circuit.create({
      devices: [device('DS1', 'led-matrix', createLedMatrixDescription())],
      connections: [],
    });
    circuit.onPublish((publish) => {
      published.push({
        symbol: publish.target.symbol,
        port: publish.target.port,
        payload: publish.payload,
      });
    });

    circuit.setPin('DS1.ROW0', true);
    circuit.setPin('DS1.D0', true);
    circuit.setPin('DS1.D2', true);
    tickOnce(circuit, published);
    circuit.step();

    const rows = published.filter((entry) => entry.port === 'row');
    const data = published.filter((entry) => entry.port === 'data');
    expect(rows.at(-1)?.payload).toBe(0);
    expect(data.at(-1)?.payload).toBe(0b101);
    circuit.dispose();
  });
});

describe('shift register (RFC 0004 pin groups)', () => {
  it('writes the byte to Q0–Q7 and reads the solved levels back', async () => {
    const published: PublishRecord[] = [];
    const circuit = await Circuit.create({
      devices: [
        device('U1', 'shift-register', createShiftRegisterDescription()),
        device('DS1', 'led-matrix', createLedMatrixDescription()),
      ],
      // The eight outputs feed the matrix data bus, so every `Q` pin is a real
      // net member and `readDigital()` has a solved level to fold.
      connections: Array.from({ length: 8 }, (_, bit) => ({
        from: `U1.Q${bit}`,
        to: `DS1.D${bit}`,
      })),
    });
    circuit.onPublish((publish) => {
      published.push({
        symbol: publish.target.symbol,
        port: publish.target.port,
        payload: publish.payload,
      });
    });

    circuit.deliverTopic('U1', 'data', 0xa5);
    circuit.step();
    circuit.step();

    expect(circuit.samplePin('U1', 'Q0')).toEqual({ value: 1, ready: true });
    expect(circuit.samplePin('U1', 'Q1')).toEqual({ value: 0, ready: true });
    expect(circuit.samplePin('U1', 'Q2')).toEqual({ value: 1, ready: true });
    expect(circuit.samplePin('U1', 'Q7')).toEqual({ value: 1, ready: true });
    expect(published.filter((entry) => entry.port === 'latch').at(-1)?.payload).toBe(0xa5);
    expect(published.filter((entry) => entry.port === 'outputs').at(-1)?.payload).toBe(0xa5);
    circuit.dispose();
  });
});

describe('i2c eeprom (RFC 0002 open-drain + weak pull-up)', () => {
  it('stores and reads back a byte through the topic endpoints', async () => {
    const published: PublishRecord[] = [];
    const circuit = await Circuit.create({
      devices: [device('U1', 'i2c-eeprom', createI2cEepromDescription())],
      connections: [],
    });
    circuit.onPublish((publish) => {
      published.push({
        symbol: publish.target.symbol,
        port: publish.target.port,
        payload: publish.payload,
      });
    });

    circuit.deliverTopic('U1', 'address', 16);
    circuit.step();
    circuit.deliverTopic('U1', 'data', 0x42);
    circuit.step();
    circuit.deliverTopic('U1', 'address', 16);
    circuit.step();
    circuit.deliverTopic('U1', 'read', true);
    circuit.step();

    const values = published.filter((entry) => entry.port === 'value');
    expect(values.at(-1)?.payload).toBe(0x42);
    circuit.dispose();
  });
});

describe('open-drain + weak pull-up (RFC 0002)', () => {
  /** A line that either releases (pull-up wins) or sinks it. */
  function openDrainLine(sink: boolean): DeviceDescription {
    return {
      name: 'open-drain-line',
      pins: { LINE: { direction: 'bidirectional' } },
      behaviors: {
        initialize: (api) => {
          api.pin('LINE').configure('open-drain');
          api.pin('LINE').pull('up');
          api.pin('LINE').writeDigital(api.builder.const('bool', !sink));
        },
      },
    };
  }

  it('wired-ANDs a released line with a sinking one', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          device('U1', 'open-drain-line', openDrainLine(false)),
          device('U2', 'open-drain-line', openDrainLine(true)),
        ],
        connections: [{ from: 'U1.LINE', to: 'U2.LINE' }],
      },
      { electrical: { allowMultiDriver: true } },
    );
    circuit.step();
    expect(circuit.samplePin('U1', 'LINE')).toEqual({ value: 0, ready: true });
    circuit.dispose();
  });

  it('reads high when every driver releases the pulled-up line', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          device('U1', 'open-drain-line', openDrainLine(false)),
          device('U2', 'open-drain-line', openDrainLine(false)),
        ],
        connections: [{ from: 'U1.LINE', to: 'U2.LINE' }],
      },
      { electrical: { allowMultiDriver: true } },
    );
    circuit.step();
    expect(circuit.samplePin('U1', 'LINE')).toEqual({ value: 1, ready: true });
    circuit.dispose();
  });

  it('lets an i2c master sink a line the EEPROM is only pulling up', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          device('U1', 'i2c-master', createI2cMasterDescription()),
          device('U2', 'i2c-eeprom', createI2cEepromDescription()),
        ],
        connections: [
          { from: 'U1.SCL', to: 'U2.SCL' },
          { from: 'U1.SDA', to: 'U2.SDA' },
        ],
      },
      { electrical: { allowMultiDriver: true } },
    );
    circuit.step();
    // Both sides release: the weak pull-ups hold the bus high.
    expect(circuit.samplePin('U2', 'SDA')).toEqual({ value: 1, ready: true });
    expect(circuit.samplePin('U2', 'SCL')).toEqual({ value: 1, ready: true });

    // Wired-AND: one open-drain stage sinking is enough to pull the net low.
    circuit.deliverTopic('U1', 'sda', true);
    circuit.step();
    expect(circuit.samplePin('U2', 'SDA')).toEqual({ value: 0, ready: true });
    expect(circuit.samplePin('U2', 'SCL')).toEqual({ value: 1, ready: true });

    circuit.deliverTopic('U1', 'sda', false);
    circuit.step();
    expect(circuit.samplePin('U2', 'SDA')).toEqual({ value: 1, ready: true });
    circuit.dispose();
  });
});

describe('serial console (RFC 0015 widget bridge)', () => {
  it('echoes a string payload back on tx and republishes the picture index', async () => {
    const published: PublishRecord[] = [];
    const circuit = await Circuit.create({
      devices: [device('U2', 'serial-console', createSerialConsoleDescription())],
      connections: [],
    });
    circuit.onPublish((publish) => {
      published.push({
        symbol: publish.target.symbol,
        port: publish.target.port,
        payload: publish.payload,
      });
    });

    circuit.deliverTopic('U2', 'rx', '你好 Mica');
    circuit.deliverTopic('U2', 'image', 1);
    circuit.step();

    expect(published.filter((entry) => entry.port === 'tx').at(-1)?.payload).toBe('你好 Mica');
    expect(published.filter((entry) => entry.port === 'picture').at(-1)?.payload).toBe(1);
    circuit.dispose();
  });
});

describe('power domains (RFC 0007)', () => {
  it('releases drivers and stops sampling when the domain is off', async () => {
    const published: PublishRecord[] = [];
    const circuit = await Circuit.create({
      devices: [device('U1', 'power-load', createPowerLoadDescription())],
      connections: [],
    });
    circuit.onPublish((publish) => {
      published.push({
        symbol: publish.target.symbol,
        port: publish.target.port,
        payload: publish.payload,
      });
    });
    circuit.setPin('U1.IN', true);
    circuit.step();
    expect(published.filter((entry) => entry.port === 'state').at(-1)?.payload).toBe(true);
    expect(circuit.samplePin('U1', 'OUT')).toEqual({ value: 1, ready: true });

    expect(circuit.isPowered('U1', 'vdd')).toBe(true);
    circuit.turnOff('U1', 'vdd');
    circuit.step();
    expect(circuit.isPowered('U1', 'vdd')).toBe(false);
    // Gated logic: the phase is skipped, so the last output latch is released.
    expect(circuit.samplePin('U1', 'OUT')).toEqual({ value: 0, ready: true });

    circuit.turnOn('U1', 'vdd');
    circuit.setPin('U1.IN', true);
    circuit.step();
    expect(circuit.isPowered('U1', 'vdd')).toBe(true);
    expect(circuit.samplePin('U1', 'OUT')).toEqual({ value: 1, ready: true });
    circuit.dispose();
  });
});
