import { createIRJIT } from '@mica-js/ir';
import type { IRExecutionContext } from '@mica-js/ir';
import { describe, expect, it } from 'vitest';
import {
  buildAccessor,
  ButtonError,
  createButtonIR,
  createButtonIRDescription,
  BUTTON_IR_TYPE,
  registerButtonLayout,
  resolveButtonConfig,
  unregisterButtonLayout,
  type ButtonIRDevice,
} from './index';

const PIN_MODE_HIGH_Z = 0;
const PIN_MODE_PUSH_PULL = 1;

interface StandaloneButton {
  readonly jit: ReturnType<typeof createIRJIT>;
  readonly context: IRExecutionContext;
  readonly accessor: ReturnType<ButtonIRDevice['buildAccessor']>;
  setInput(pinName: string, level: boolean): void;
  mode(pinName: string): number;
  driven(pinName: string): boolean;
  step(count?: number): void;
}

function createStandalone(device: ButtonIRDevice): StandaloneButton {
  const jit = createIRJIT(device.module, {
    validation: device.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
  const context: IRExecutionContext = Object.freeze({ instanceId: device.id, virtualTime: 0 });
  jit.execute(device.layout.entries.initialize, [], context);
  const step = (count = 1): void => {
    for (let index = 0; index < count; index += 1) {
      jit.execute(device.layout.entries.tick, [], context);
      jit.execute(device.layout.entries.update, [], context);
    }
  };
  const accessor = device.buildAccessor(jit.storage, { step: () => step() });
  const pinOf = (pinName: string) => {
    const pin = device.layout.pins.get(pinName);
    if (pin === undefined) throw new Error(`unknown pin ${pinName}`);
    return pin;
  };
  const setInput = (pinName: string, level: boolean): void => {
    jit.storage.storeArray(device.layout.pinMemory.input, pinOf(pinName).globalPinId, level);
  };
  const mode = (pinName: string): number =>
    Number(jit.storage.loadArray(device.layout.pinMemory.mode, pinOf(pinName).globalPinId));
  const driven = (pinName: string): boolean =>
    jit.storage.loadArray(device.layout.pinMemory.output, pinOf(pinName).globalPinId) === true;
  return { jit, context, accessor, setInput, mode, driven, step };
}

describe('button configuration', () => {
  it('resolves the documented defaults', () => {
    const config = resolveButtonConfig();
    expect(config).toEqual({
      a: 'A',
      b: 'B',
      initialPressed: false,
      debounceTicks: 0,
      activeLow: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('resolves custom terminals, initial position and debounce', () => {
    const config = resolveButtonConfig({
      a: 'SIG',
      b: 'COM',
      initialPressed: true,
      debounceTicks: 3,
      activeLow: true,
    });
    expect(config.a).toBe('SIG');
    expect(config.b).toBe('COM');
    expect(config.initialPressed).toBe(true);
    expect(config.debounceTicks).toBe(3);
    expect(config.activeLow).toBe(true);
  });

  it.each([
    [{ a: '' }, 'a'],
    [{ b: '  ' }, 'b'],
    [{ a: 'X', b: 'X' }, 'differ'],
    [{ initialPressed: 1 }, 'initialPressed'],
    [{ debounceTicks: -1 }, 'debounceTicks'],
    [{ debounceTicks: 1.5 }, 'debounceTicks'],
    [{ debounceTicks: 0x1_0000_0000 }, 'debounceTicks'],
    [{ activeLow: 'yes' }, 'activeLow'],
  ])('rejects invalid config %j', (config, fragment) => {
    expect(() => resolveButtonConfig(config as never)).toThrow(ButtonError);
    expect(() => resolveButtonConfig(config as never)).toThrow(fragment as string);
  });

  it('rejects a non-identifier device id', () => {
    expect(() => createButtonIR('sw-1')).toThrow(ButtonError);
    expect(() => createButtonIR('sw-1')).toThrow(/identifier/);
    expect(() => createButtonIRDescription('1sw')).toThrow(ButtonError);
  });
});

describe('button IR generation', () => {
  it('builds a standalone module with all three phases', () => {
    const button = createButtonIR('sw1');
    expect(button.id).toBe('sw1');
    expect(button.type).toBe(BUTTON_IR_TYPE);
    expect(button.device.type).toBe(BUTTON_IR_TYPE);
    expect(button.layout.deviceId).toBe('sw1');
    expect(button.layout.type).toBe(BUTTON_IR_TYPE);
    expect(button.layout.pinNames).toEqual(['A', 'B']);
    expect(button.layout.pins.get('A')).toMatchObject({ terminal: 'a', globalPinId: 0 });
    expect(button.layout.pins.get('B')).toMatchObject({ terminal: 'b', globalPinId: 1 });
    expect(button.module.functions.map((fn) => fn.name)).toEqual([
      'sw1_ir_initialize',
      'sw1_ir_tick',
      'sw1_ir_update',
    ]);
    expect(button.module.memories.map((memory) => memory.name)).toEqual(
      expect.arrayContaining([
        'sw1_pressed',
        'sw1_closed',
        'sw1_counter',
        'sw1_press_count',
        'sw1_hold_ticks',
        'sw1_line',
        'sw1_reference',
      ]),
    );
    expect(button.validation.supportedInstructions?.length ?? 0).toBeGreaterThan(0);
  });

  it('declares A as a bidirectional terminal and B as an input', () => {
    const button = createButtonIR('sw1');
    expect((button.device.description.pins as Record<string, unknown>).A).toEqual({
      direction: 'bidirectional',
    });
    expect((button.device.description.pins as Record<string, unknown>).B).toEqual({
      direction: 'input',
    });
    const description = createButtonIRDescription('sw1');
    expect(description.name).toBe('button');
    expect(description.kernel).toBeTypeOf('function');
    expect(description.accessor).toBeTypeOf('function');
  });

  it('maps custom terminal names into the standalone pin space', () => {
    const button = createButtonIR('sw1', { a: 'SIG', b: 'COM' });
    expect(button.layout.pinNames).toEqual(['SIG', 'COM']);
    expect(button.layout.pins.get('SIG')?.terminal).toBe('a');
    expect(button.layout.pins.get('COM')?.terminal).toBe('b');
  });
});

describe('button electrical behavior', () => {
  it('starts open with a high-Z switched terminal', () => {
    const device = createButtonIR('sw1');
    const harness = createStandalone(device);
    expect(harness.accessor.isPressed()).toBe(false);
    expect(harness.accessor.isClosed()).toBe(false);
    expect(harness.accessor.isBouncing()).toBe(false);
    expect(harness.accessor.getPressCount()).toBe(0);
    expect(harness.accessor.getHoldTicks()).toBe(0);
    expect(harness.mode('A')).toBe(PIN_MODE_HIGH_Z);
    expect(harness.driven('A')).toBe(false);
  });

  it('drives A high while pressed and returns to high-Z on release', () => {
    const device = createButtonIR('sw1');
    const harness = createStandalone(device);
    harness.accessor.press();
    expect(harness.accessor.isPressed()).toBe(true);
    expect(harness.accessor.isClosed()).toBe(false);
    harness.step();
    expect(harness.accessor.isClosed()).toBe(true);
    expect(harness.accessor.isBouncing()).toBe(false);
    expect(harness.accessor.getPressCount()).toBe(1);
    expect(harness.accessor.getHoldTicks()).toBe(1);
    expect(harness.mode('A')).toBe(PIN_MODE_PUSH_PULL);
    expect(harness.driven('A')).toBe(true);
    expect(harness.accessor.readPin('A')).toBe(true);

    harness.step();
    expect(harness.accessor.getPressCount()).toBe(1);
    expect(harness.accessor.getHoldTicks()).toBe(2);

    harness.accessor.release();
    harness.step();
    expect(harness.accessor.isPressed()).toBe(false);
    expect(harness.accessor.isClosed()).toBe(false);
    expect(harness.accessor.getPressCount()).toBe(1);
    expect(harness.accessor.getHoldTicks()).toBe(0);
    expect(harness.mode('A')).toBe(PIN_MODE_HIGH_Z);
    expect(harness.driven('A')).toBe(false);
  });

  it('debounces the position for the configured number of ticks', () => {
    const device = createButtonIR('sw1', { debounceTicks: 2 });
    const harness = createStandalone(device);
    harness.accessor.press();
    harness.step();
    expect(harness.accessor.isClosed()).toBe(false);
    expect(harness.accessor.isBouncing()).toBe(true);
    expect(harness.accessor.getState('counter')).toBe(1);
    expect(harness.accessor.getPressCount()).toBe(0);
    expect(harness.mode('A')).toBe(PIN_MODE_HIGH_Z);

    harness.step();
    expect(harness.accessor.isClosed()).toBe(true);
    expect(harness.accessor.isBouncing()).toBe(false);
    expect(harness.accessor.getState('counter')).toBe(0);
    expect(harness.accessor.getPressCount()).toBe(1);
  });

  it('debounces release symmetrically without counting a new press', () => {
    const device = createButtonIR('sw1', { debounceTicks: 2 });
    const harness = createStandalone(device);
    harness.accessor.press();
    harness.step(2);
    expect(harness.accessor.isClosed()).toBe(true);

    harness.accessor.release();
    harness.step();
    expect(harness.accessor.isClosed()).toBe(true);
    expect(harness.accessor.isBouncing()).toBe(true);
    harness.step();
    expect(harness.accessor.isClosed()).toBe(false);
    expect(harness.accessor.getPressCount()).toBe(1);
  });

  it('ignores a bounce shorter than the debounce window', () => {
    const device = createButtonIR('sw1', { debounceTicks: 3 });
    const harness = createStandalone(device);
    harness.accessor.press();
    harness.step(2);
    harness.accessor.release();
    harness.step();
    expect(harness.accessor.isClosed()).toBe(false);
    expect(harness.accessor.isBouncing()).toBe(false);
    expect(harness.accessor.getPressCount()).toBe(0);
    expect(harness.accessor.getState('counter')).toBe(0);
  });

  it('pulls A low when activeLow is enabled', () => {
    const device = createButtonIR('sw1', { activeLow: true });
    const harness = createStandalone(device);
    harness.accessor.press();
    harness.step();
    expect(harness.mode('A')).toBe(PIN_MODE_PUSH_PULL);
    expect(harness.driven('A')).toBe(false);
    expect(harness.accessor.readPin('A')).toBe(false);

    harness.accessor.release();
    harness.step();
    expect(harness.mode('A')).toBe(PIN_MODE_HIGH_Z);
    expect(harness.driven('A')).toBe(false);
  });

  it('honours an initial pressed position', () => {
    const device = createButtonIR('sw1', { initialPressed: true });
    const harness = createStandalone(device);
    expect(harness.accessor.isPressed()).toBe(true);
    expect(harness.accessor.isClosed()).toBe(true);
    expect(harness.mode('A')).toBe(PIN_MODE_PUSH_PULL);
    expect(harness.driven('A')).toBe(true);
    harness.step();
    expect(harness.accessor.getPressCount()).toBe(0);
    expect(harness.accessor.getHoldTicks()).toBe(1);
  });

  it('records the solved levels of both terminals', () => {
    const device = createButtonIR('sw1');
    const harness = createStandalone(device);
    harness.setInput('A', true);
    harness.setInput('B', true);
    harness.step();
    expect(harness.accessor.getLineLevel()).toBe(true);
    expect(harness.accessor.getReferenceLevel()).toBe(true);
    expect(harness.accessor.readPinInput('A')).toBe(true);
    expect(harness.accessor.samplePin('B')).toBe(true);

    harness.setInput('A', false);
    harness.setInput('B', false);
    harness.step();
    expect(harness.accessor.getLineLevel()).toBe(false);
    expect(harness.accessor.getReferenceLevel()).toBe(false);
  });

  it('toggles and resets the press counter', () => {
    const device = createButtonIR('sw1');
    const harness = createStandalone(device);
    harness.accessor.toggle();
    harness.step();
    expect(harness.accessor.isClosed()).toBe(true);
    expect(harness.accessor.getPressCount()).toBe(1);
    harness.accessor.toggle();
    harness.step();
    expect(harness.accessor.isClosed()).toBe(false);
    harness.accessor.resetPressCount();
    expect(harness.accessor.getPressCount()).toBe(0);
  });
});

describe('button accessor surface', () => {
  it('exposes the generic accessor surface', () => {
    const device = createButtonIR('sw1', { a: 'SIG', b: 'COM' });
    const harness = createStandalone(device);
    const accessor = harness.accessor;
    expect(accessor.deviceId).toBe('sw1');
    expect(accessor.type).toBe(BUTTON_IR_TYPE);
    expect(accessor.pinNames).toEqual(['SIG', 'COM']);
    expect(accessor.stateNames).toEqual([
      'pressed',
      'closed',
      'counter',
      'pressCount',
      'holdTicks',
      'line',
      'reference',
    ]);
    expect(accessor.pressedState).toBe('pressed');
    expect(accessor.terminalA).toBe('SIG');
    expect(accessor.terminalB).toBe('COM');
    expect(accessor.activeLow).toBe(false);
    expect(accessor.debounceTicks).toBe(0);
  });

  it('reads and writes declared states by name', () => {
    const device = createButtonIR('sw1');
    const harness = createStandalone(device);
    harness.accessor.setState('pressed', true);
    expect(harness.accessor.isPressed()).toBe(true);
    harness.accessor.setState('closed', true);
    expect(harness.accessor.isClosed()).toBe(true);
    harness.accessor.setState('counter', 7);
    harness.accessor.setState('pressCount', 3);
    harness.accessor.setState('holdTicks', 9);
    harness.accessor.setState('line', true);
    harness.accessor.setState('reference', true);
    expect(harness.accessor.getState('counter')).toBe(7);
    expect(harness.accessor.getState('pressCount')).toBe(3);
    expect(harness.accessor.getState('holdTicks')).toBe(9);
    expect(harness.accessor.getState('line')).toBe(true);
    expect(harness.accessor.getState('reference')).toBe(true);
  });

  it('rejects unknown states and bad state values', () => {
    const harness = createStandalone(createButtonIR('sw1'));
    expect(() => harness.accessor.getState('nope')).toThrow(ButtonError);
    expect(() => harness.accessor.getState('nope')).toThrow(/no state/);
    expect(() => harness.accessor.setState('pressed', 1)).toThrow(/boolean/);
    expect(() => harness.accessor.setState('counter', -1)).toThrow(/u32/);
    expect(() => harness.accessor.setState('counter', 1.5)).toThrow(/u32/);
    expect(() => harness.accessor.setPressed('yes' as unknown as boolean)).toThrow(ButtonError);
  });

  it('rejects pin writes and reports the driven level', () => {
    const harness = createStandalone(createButtonIR('sw1'));
    expect(harness.accessor.readPin('B')).toBe(false);
    expect(() => harness.accessor.writePin('A', true)).toThrow(ButtonError);
    expect(() => harness.accessor.writePin('A', true)).toThrow(/press\(\)/);
    expect(() => harness.accessor.readPin('missing')).toThrow(/no pin/);
  });

  it('requires a runner for step', () => {
    const device = createButtonIR('sw1');
    const jit = createIRJIT(device.module, { validation: device.validation });
    const accessor = device.buildAccessor(jit.storage);
    expect(() => accessor.step()).toThrow(/runner/);
    expect(() => accessor.step(-1)).toThrow(/non-negative/);
    expect(() => accessor.step(1.5)).toThrow(/non-negative/);
  });

  it('returns a complete snapshot', () => {
    const device = createButtonIR('sw1');
    const harness = createStandalone(device);
    harness.accessor.press();
    harness.step();
    expect(harness.accessor.snapshot()).toEqual({
      pressed: true,
      closed: true,
      bouncing: false,
      pressCount: 1,
      holdTicks: 1,
      line: false,
      reference: false,
      driven: true,
      highZ: false,
    });
    harness.accessor.release();
    expect(harness.accessor.snapshot()).toMatchObject({
      pressed: false,
      closed: true,
      bouncing: true,
    });
  });

  it('builds accessors through the layout registry', () => {
    unregisterButtonLayout();
    const device = createButtonIR('sw1');
    const jit = createIRJIT(device.module, { validation: device.validation });
    const context: IRExecutionContext = Object.freeze({ instanceId: 'sw1', virtualTime: 0 });
    const runner = {
      step: () => {
        jit.execute(device.layout.entries.tick, [], context);
        jit.execute(device.layout.entries.update, [], context);
      },
    };

    // `createButtonIR` registers the standalone layout, so the two-argument
    // form required by #175 works without passing the layout again.
    const automatic = buildAccessor('sw1', jit.storage, undefined, runner);
    expect(automatic.deviceId).toBe('sw1');
    expect(() => buildAccessor('other', jit.storage)).toThrow(ButtonError);

    unregisterButtonLayout('sw1');
    expect(() => buildAccessor('sw1', jit.storage)).toThrow(/no registered IR layout/);
    registerButtonLayout('sw1', device.layout);
    const accessor = buildAccessor('sw1', jit.storage, undefined, runner);
    expect(accessor.deviceId).toBe('sw1');

    registerButtonLayout('sw2', device.layout);
    unregisterButtonLayout();
    expect(() => buildAccessor('sw2', jit.storage)).toThrow(/no registered IR layout/);
  });

  it('checks the circuit liveness hook before every access', () => {
    const device = createButtonIR('sw1');
    const jit = createIRJIT(device.module, { validation: device.validation });
    let disposed = false;
    const accessor = device.buildAccessor(jit.storage, {
      assertActive: () => {
        if (disposed) throw new Error('disposed');
      },
      step: () => {},
    });
    expect(accessor.isPressed()).toBe(false);
    disposed = true;
    expect(() => accessor.isPressed()).toThrow(/disposed/);
    expect(() => accessor.press()).toThrow(/disposed/);
    expect(() => accessor.snapshot()).toThrow(/disposed/);
  });
});
