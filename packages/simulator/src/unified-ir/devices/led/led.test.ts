import { createIRJIT } from '@mica-js/ir';
import type { IRExecutionContext } from '@mica-js/ir';
import { describe, expect, it } from 'vitest';
import {
  buildAccessor,
  createLedIR,
  createLedIRDescription,
  LED_COLORS,
  LED_IR_TYPE,
  LedError,
  registerLedLayout,
  resolveLedConfig,
  unregisterLedLayout,
  type LedIRDevice,
} from './index';

const PIN_MODE_HIGH_Z = 0;

interface StandaloneLed {
  readonly jit: ReturnType<typeof createIRJIT>;
  readonly context: IRExecutionContext;
  readonly accessor: ReturnType<LedIRDevice['buildAccessor']>;
  setInput(pinName: string, level: boolean): void;
}

function createStandalone(device: LedIRDevice): StandaloneLed {
  const jit = createIRJIT(device.module, {
    validation: device.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
  const context: IRExecutionContext = Object.freeze({ instanceId: device.id, virtualTime: 0 });
  jit.execute(device.layout.entries.initialize, [], context);
  const runUpdate = (): void => {
    jit.execute(device.layout.entries.update, [], context);
  };
  const accessor = device.buildAccessor(jit.storage, { update: runUpdate, step: runUpdate });
  const setInput = (pinName: string, level: boolean): void => {
    const pin = device.layout.pins.get(pinName);
    if (pin === undefined) throw new Error(`unknown pin ${pinName}`);
    jit.storage.storeArray(device.layout.pinMemory.input, pin.globalPinId, level);
  };
  return { jit, context, accessor, setInput };
}

function inputLevel(harness: StandaloneLed, device: LedIRDevice, pinName: string): boolean {
  const pin = device.layout.pins.get(pinName);
  if (pin === undefined) throw new Error(`unknown pin ${pinName}`);
  return harness.jit.storage.loadArray(device.layout.pinMemory.input, pin.globalPinId) === true;
}

describe('LED configuration', () => {
  it('resolves the documented defaults', () => {
    const config = resolveLedConfig();
    expect(config).toEqual({
      anode: 'anode',
      cathode: 'cathode',
      color: 'red',
      forwardVoltage: 2,
      activeLow: false,
      maxBrightness: 255,
      initialBrightness: 255,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('resolves custom terminals, colour and intensity', () => {
    const config = resolveLedConfig({
      anode: 'A',
      cathode: 'K',
      color: 'green',
      forwardVoltage: 3.2,
      activeLow: true,
      maxBrightness: 100,
      initialBrightness: 40,
    });
    expect(config.anode).toBe('A');
    expect(config.cathode).toBe('K');
    expect(config.color).toBe('green');
    expect(config.forwardVoltage).toBe(3.2);
    expect(config.activeLow).toBe(true);
    expect(config.maxBrightness).toBe(100);
    expect(config.initialBrightness).toBe(40);
  });

  it('accepts every documented colour', () => {
    for (const color of LED_COLORS) {
      expect(resolveLedConfig({ color }).color).toBe(color);
    }
  });

  it.each([
    [{ anode: '' }, 'anode'],
    [{ cathode: '  ' }, 'cathode'],
    [{ anode: 'p', cathode: 'p' }, 'differ'],
    [{ color: 'purple' }, 'color'],
    [{ forwardVoltage: -1 }, 'forwardVoltage'],
    [{ forwardVoltage: 13 }, 'forwardVoltage'],
    [{ forwardVoltage: Number.NaN }, 'forwardVoltage'],
    [{ activeLow: 'yes' }, 'activeLow'],
    [{ maxBrightness: 0 }, 'maxBrightness'],
    [{ maxBrightness: 256 }, 'maxBrightness'],
    [{ maxBrightness: 1.5 }, 'maxBrightness'],
    [{ initialBrightness: 256 }, 'initialBrightness'],
    [{ maxBrightness: 10, initialBrightness: 11 }, 'initialBrightness'],
    [{ initialBrightness: -1 }, 'initialBrightness'],
  ])('rejects invalid config %j', (config, fragment) => {
    expect(() => resolveLedConfig(config as never)).toThrow(LedError);
    expect(() => resolveLedConfig(config as never)).toThrow(fragment as string);
  });

  it('rejects a non-identifier device id', () => {
    expect(() => createLedIR('led-1')).toThrow(LedError);
    expect(() => createLedIR('led-1')).toThrow(/identifier/);
    expect(() => createLedIRDescription('1led')).toThrow(LedError);
  });
});

describe('LED IR generation', () => {
  it('builds a standalone module with initialize and update entries', () => {
    const led = createLedIR('led1');
    expect(led.id).toBe('led1');
    expect(led.type).toBe(LED_IR_TYPE);
    expect(led.device.type).toBe(LED_IR_TYPE);
    expect(led.layout.pinNames).toEqual(['anode', 'cathode']);
    expect(led.layout.pins.get('anode')?.globalPinId).toBe(0);
    expect(led.layout.pins.get('cathode')?.globalPinId).toBe(1);
    expect(led.layout.deviceId).toBe('led1');
    expect(led.layout.type).toBe(LED_IR_TYPE);
    expect(led.module.functions.map((fn) => fn.name)).toEqual([
      'led1_ir_initialize',
      'led1_ir_update',
    ]);
    expect(led.module.memories.map((memory) => memory.name)).toEqual(
      expect.arrayContaining(['led1_pin_mode', 'led1_pin_output', 'led1_pin_input']),
    );
    expect(led.module.memories.map((memory) => memory.name)).toEqual(
      expect.arrayContaining(['led1_lamp', 'led1_level', 'led1_brightness']),
    );
    expect(led.validation.supportedInstructions?.length ?? 0).toBeGreaterThan(0);
  });

  it('maps custom terminal names into the standalone pin space', () => {
    const led = createLedIR('led1', { anode: 'A', cathode: 'K' });
    expect(led.layout.pinNames).toEqual(['A', 'K']);
    expect(led.layout.pins.get('A')).toMatchObject({ terminal: 'anode', globalPinId: 0 });
    expect(led.layout.pins.get('K')).toMatchObject({ terminal: 'cathode', globalPinId: 1 });
    expect((led.device.description.pins as Record<string, unknown>).A).toEqual({
      direction: 'passive',
    });
    expect((led.device.description.pins as Record<string, unknown>).K).toEqual({
      direction: 'passive',
    });
  });

  it('exposes the standalone layout through the description kernel', () => {
    const holder: { layout: import('./index').LedLayout | undefined } = { layout: undefined };
    const description = createLedIRDescription('led1', { color: 'blue' }, holder);
    expect(description.name).toBe('led');
    expect(description.kernel).toBeTypeOf('function');
    expect(description.accessor).toBeTypeOf('function');
  });
});

describe('LED electrical behavior', () => {
  it('lights when the anode is high and the cathode low', () => {
    const device = createLedIR('led1');
    const harness = createStandalone(device);
    expect(harness.accessor.isOn()).toBe(false);
    expect(harness.accessor.getBrightness()).toBe(0);

    harness.setInput('anode', true);
    harness.accessor.refresh();
    expect(harness.accessor.isOn()).toBe(true);
    expect(harness.accessor.isForwardBiased()).toBe(true);
    expect(harness.accessor.getBrightness()).toBe(255);
    expect(harness.accessor.getLevel()).toBe(255);

    harness.setInput('cathode', true);
    harness.accessor.refresh();
    expect(harness.accessor.isOn()).toBe(false);
    expect(harness.accessor.getBrightness()).toBe(0);
  });

  it('honours activeLow (reverse-mounted) wiring', () => {
    const device = createLedIR('led1', { activeLow: true });
    const harness = createStandalone(device);
    harness.setInput('anode', true);
    harness.setInput('cathode', false);
    harness.accessor.refresh();
    expect(harness.accessor.isOn()).toBe(false);

    harness.setInput('anode', false);
    harness.setInput('cathode', true);
    harness.accessor.refresh();
    expect(harness.accessor.isOn()).toBe(true);
  });

  it('starts dark when the initial intensity cap is zero', () => {
    const device = createLedIR('led1', { initialBrightness: 0 });
    const harness = createStandalone(device);
    harness.setInput('anode', true);
    harness.accessor.refresh();
    expect(harness.accessor.isForwardBiased()).toBe(true);
    expect(harness.accessor.isOn()).toBe(false);
    expect(harness.accessor.getBrightness()).toBe(0);
    expect(harness.accessor.getLevel()).toBe(0);
  });

  it('applies setBrightness to the derived state immediately', () => {
    const device = createLedIR('led1', { maxBrightness: 200 });
    const harness = createStandalone(device);
    harness.setInput('anode', true);
    harness.accessor.refresh();
    expect(harness.accessor.getBrightness()).toBe(200);

    harness.accessor.setBrightness(128);
    expect(harness.accessor.getLevel()).toBe(128);
    expect(harness.accessor.getBrightness()).toBe(128);
    expect(harness.accessor.isOn()).toBe(true);

    harness.accessor.setBrightness(0);
    expect(harness.accessor.isOn()).toBe(false);
    expect(harness.accessor.getBrightness()).toBe(0);

    harness.accessor.setBrightness(64);
    expect(harness.accessor.isOn()).toBe(true);
    expect(harness.accessor.getBrightness()).toBe(64);
  });

  it.each([-1, 256, 1.5, Number.NaN])('rejects invalid brightness %s', (value) => {
    const harness = createStandalone(createLedIR('led1'));
    expect(() => harness.accessor.setBrightness(value)).toThrow(LedError);
    expect(() => harness.accessor.setBrightness(value)).toThrow(/brightness/);
  });

  it('reports the solved terminal levels and a snapshot', () => {
    const device = createLedIR('led1');
    const harness = createStandalone(device);
    harness.setInput('anode', true);
    harness.setInput('cathode', false);
    harness.accessor.refresh();
    expect(harness.accessor.readAnode()).toBe(true);
    expect(harness.accessor.readCathode()).toBe(false);
    expect(harness.accessor.readPinInput('anode')).toBe(true);
    expect(harness.accessor.samplePin('cathode')).toBe(false);
    expect(inputLevel(harness, device, 'anode')).toBe(true);
    expect(harness.accessor.snapshot()).toEqual({
      lamp: true,
      level: 255,
      brightness: 255,
      anode: true,
      cathode: false,
      forwardBiased: true,
    });
  });

  it('initializes the load pins into high-Z with no drive', () => {
    const device = createLedIR('led1');
    const harness = createStandalone(device);
    for (const pin of device.layout.pins.values()) {
      expect(harness.jit.storage.loadArray(device.layout.pinMemory.mode, pin.globalPinId)).toBe(
        PIN_MODE_HIGH_Z,
      );
      expect(harness.jit.storage.loadArray(device.layout.pinMemory.output, pin.globalPinId)).toBe(
        false,
      );
    }
  });
});

describe('LED accessor surface', () => {
  it('exposes the generic accessor surface', () => {
    const device = createLedIR('led1', { color: 'amber', forwardVoltage: 1.8 });
    const harness = createStandalone(device);
    const accessor = harness.accessor;
    expect(accessor.deviceId).toBe('led1');
    expect(accessor.type).toBe(LED_IR_TYPE);
    expect(accessor.pinNames).toEqual(['anode', 'cathode']);
    expect(accessor.stateNames).toEqual(['lamp', 'level', 'brightness']);
    expect(accessor.lampState).toBe('lamp');
    expect(accessor.color).toBe('amber');
    expect(accessor.forwardVoltage).toBe(1.8);
    expect(accessor.activeLow).toBe(false);
    expect(accessor.maxBrightness).toBe(255);
    expect(accessor.anodePin).toBe('anode');
    expect(accessor.cathodePin).toBe('cathode');
  });

  it('reads and writes declared states by name', () => {
    const device = createLedIR('led1');
    const harness = createStandalone(device);
    expect(harness.accessor.getState('lamp')).toBe(false);
    expect(harness.accessor.getState('level')).toBe(255);
    expect(harness.accessor.getState('brightness')).toBe(0);

    harness.accessor.setState('level', 64);
    expect(harness.accessor.getLevel()).toBe(64);
    harness.accessor.setState('lamp', true);
    expect(harness.accessor.isOn()).toBe(true);
    harness.accessor.setState('brightness', 32);
    expect(harness.accessor.getBrightness()).toBe(32);
  });

  it('rejects unknown states and bad state values', () => {
    const harness = createStandalone(createLedIR('led1'));
    expect(() => harness.accessor.getState('nope')).toThrow(LedError);
    expect(() => harness.accessor.getState('nope')).toThrow(/no state/);
    expect(() => harness.accessor.setState('lamp', 1)).toThrow(/boolean/);
    expect(() => harness.accessor.setState('level', 'high')).toThrow(/number/);
    expect(() => harness.accessor.setState('brightness', 300)).toThrow(/integer/);
  });

  it('rejects pin writes and reports the driven level', () => {
    const device = createLedIR('led1');
    const harness = createStandalone(device);
    expect(harness.accessor.readPin('anode')).toBe(false);
    expect(() => harness.accessor.writePin('anode', true)).toThrow(LedError);
    expect(() => harness.accessor.writePin('anode', true)).toThrow(/load terminal/);
    expect(() => harness.accessor.readPin('missing')).toThrow(/no pin/);
  });

  it('requires a runner for step/refresh', () => {
    const device = createLedIR('led1');
    const jit = createIRJIT(device.module, { validation: device.validation });
    const accessor = device.buildAccessor(jit.storage);
    expect(() => accessor.step()).toThrow(/runner/);
    expect(() => accessor.refresh()).toThrow(/runner/);
    expect(() => accessor.step(-1)).toThrow(/non-negative/);
  });

  it('runs the update phase through step', () => {
    const device = createLedIR('led1');
    const harness = createStandalone(device);
    harness.setInput('anode', true);
    harness.accessor.step();
    expect(harness.accessor.isOn()).toBe(true);
    harness.accessor.step(0);
    expect(harness.accessor.isOn()).toBe(true);
    harness.accessor.run(1);
    expect(harness.accessor.isOn()).toBe(true);
  });

  it('builds accessors through the layout registry', () => {
    unregisterLedLayout();
    const device = createLedIR('led1');
    const jit = createIRJIT(device.module, { validation: device.validation });
    const context: IRExecutionContext = Object.freeze({ instanceId: 'led1', virtualTime: 0 });
    const update = {
      update: () => jit.execute(device.layout.entries.update, [], context),
    };

    // `createLedIR` registers the standalone layout, so the two-argument form
    // required by #175 works without passing the layout again.
    const automatic = buildAccessor('led1', jit.storage, undefined, update);
    expect(automatic.deviceId).toBe('led1');
    expect(() => buildAccessor('other', jit.storage)).toThrow(LedError);

    unregisterLedLayout('led1');
    expect(() => buildAccessor('led1', jit.storage)).toThrow(/no registered IR layout/);
    registerLedLayout('led1', device.layout);
    const accessor = buildAccessor('led1', jit.storage, undefined, update);
    expect(accessor.deviceId).toBe('led1');

    registerLedLayout('led2', device.layout);
    unregisterLedLayout();
    expect(() => buildAccessor('led2', jit.storage)).toThrow(/no registered IR layout/);
  });

  it('checks the circuit liveness hook before every access', () => {
    const device = createLedIR('led1');
    const jit = createIRJIT(device.module, { validation: device.validation });
    const context: IRExecutionContext = Object.freeze({ instanceId: 'led1', virtualTime: 0 });
    let disposed = false;
    const accessor = device.buildAccessor(jit.storage, {
      assertActive: () => {
        if (disposed) throw new Error('disposed');
      },
      update: () => jit.execute(device.layout.entries.update, [], context),
    });
    expect(accessor.isOn()).toBe(false);
    disposed = true;
    expect(() => accessor.isOn()).toThrow(/disposed/);
    expect(() => accessor.setBrightness(1)).toThrow(/disposed/);
    expect(() => accessor.snapshot()).toThrow(/disposed/);
  });
});
