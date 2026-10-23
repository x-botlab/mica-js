import type { CanvasWidgetInstance } from '@mica-js/core/canvas';
import { SchematicError } from '@mica-js/core/canvas';
import type { PortDefinition, PropertyDefinition } from '@mica-js/widget';
import { describe, expect, it } from 'vitest';
import {
  assetRefOf,
  bindingOptions,
  bindingTargetOf,
  commandErrorMessages,
  compatibleTargets,
  isPropertyOverridden,
  parseTargetValue,
  propertyInitialValue,
  targetValue,
} from './panel-model';

const DISPLAY: PortDefinition = { direction: 'input', type: 'string' };
const PRESS: PortDefinition = { direction: 'output', type: 'boolean' };
const NUMBER_IN: PortDefinition = { direction: 'input', type: 'number' };

function instance(overrides: Partial<CanvasWidgetInstance> = {}): CanvasWidgetInstance {
  return {
    id: '1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e50',
    widget: 'demo:segment',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    ...overrides,
  };
}

describe('compatibleTargets', () => {
  it('pairs a widget input with schematic outputs of the same payload type', () => {
    expect(compatibleTargets(DISPLAY)).toEqual([
      { symbol: 'demo-mcu', port: 'display', direction: 'output', type: 'string' },
      { symbol: 'demo-mcu', port: 'display2', direction: 'output', type: 'string' },
    ]);
  });

  it('pairs a widget output with schematic inputs of the same payload type', () => {
    expect(compatibleTargets(PRESS).map((target) => target.port)).toEqual(['key', 'led']);
  });

  it('rejects every candidate when the type or the direction has no partner', () => {
    expect(compatibleTargets(NUMBER_IN)).toEqual([]);
    expect(compatibleTargets({ direction: 'output', type: 'string' })).toEqual([]);
  });
});

describe('bindingOptions', () => {
  it('starts with "unbound" and lists the compatible candidates', () => {
    const options = bindingOptions(instance(), 'value', DISPLAY);
    expect(options[0]).toEqual({ value: '', label: '未绑定', current: false });
    expect(options.map((option) => option.value)).toEqual([
      '',
      'demo-mcu:display',
      'demo-mcu:display2',
    ]);
    expect(options[1]?.label).toBe('demo-mcu.display · output · string');
  });

  it('keeps an unknown current binding selectable instead of rendering it blank', () => {
    const bound = instance({ bindings: { value: { symbol: 'legacy', port: 'bus' } } });
    const options = bindingOptions(bound, 'value', DISPLAY);

    expect(options.map((option) => option.value)).toEqual([
      '',
      'demo-mcu:display',
      'demo-mcu:display2',
      'legacy:bus',
    ]);
    expect(options[3]).toMatchObject({ label: 'legacy.bus · 当前', current: true });
  });

  it('does not repeat a current binding the candidates already offer', () => {
    const bound = instance({ bindings: { value: { symbol: 'demo-mcu', port: 'display' } } });
    const options = bindingOptions(bound, 'value', DISPLAY);
    expect(options.filter((option) => option.value === 'demo-mcu:display')).toHaveLength(1);
    expect(options.every((option) => !option.current)).toBe(true);
  });
});

describe('bindingTargetOf', () => {
  it('reads the binding of one port and ignores unbound instances', () => {
    const bound = instance({ bindings: { value: { symbol: 'demo-mcu', port: 'display' } } });
    expect(bindingTargetOf(bound, 'value')).toEqual({ symbol: 'demo-mcu', port: 'display' });
    expect(bindingTargetOf(bound, 'press')).toBeUndefined();
    expect(bindingTargetOf(instance(), 'value')).toBeUndefined();
    expect(bindingTargetOf(undefined, 'value')).toBeUndefined();
  });
});

describe('target values', () => {
  it('round-trips a target through its select value', () => {
    const target = { symbol: 'demo-mcu', port: 'display' };
    expect(targetValue(target)).toBe('demo-mcu:display');
    expect(parseTargetValue('demo-mcu:display')).toEqual(target);
  });

  it('rejects values without both halves', () => {
    expect(parseTargetValue('')).toBeUndefined();
    expect(parseTargetValue(':display')).toBeUndefined();
    expect(parseTargetValue('demo-mcu:')).toBeUndefined();
    expect(parseTargetValue('demo-mcu')).toBeUndefined();
  });
});

describe('propertyInitialValue', () => {
  const descriptor: PropertyDefinition = { type: 'string', default: 'S1' };

  it('prefers the document override', () => {
    const placed = instance({ properties: { label: 'S2' } });
    expect(propertyInitialValue(placed, 'label', descriptor)).toBe('S2');
  });

  it('falls back to the definition default', () => {
    expect(propertyInitialValue(instance(), 'label', descriptor)).toBe('S1');
    expect(propertyInitialValue(undefined, 'label', descriptor)).toBe('S1');
  });

  it('keeps an explicit undefined override and a null default distinguishable', () => {
    const explicit = instance({ properties: { label: undefined } });
    expect(propertyInitialValue(explicit, 'label', descriptor)).toBeUndefined();
    expect(propertyInitialValue(instance(), 'label', { type: 'image' })).toBeUndefined();
    expect(propertyInitialValue(instance(), 'label', { type: 'string', default: null })).toBeNull();
  });
});

describe('isPropertyOverridden', () => {
  it('is true only when the document sets the key', () => {
    expect(isPropertyOverridden(instance({ properties: { label: 'S1' } }), 'label')).toBe(true);
    // Explicitly equal to the default is still an override.
    expect(isPropertyOverridden(instance({ properties: { label: 'S1' } }), 'label')).toBe(true);
    expect(isPropertyOverridden(instance({ properties: { digits: 8 } }), 'label')).toBe(false);
    expect(isPropertyOverridden(instance(), 'label')).toBe(false);
    expect(isPropertyOverridden(undefined, 'label')).toBe(false);
  });

  it('counts an explicitly undefined value as an override', () => {
    expect(isPropertyOverridden(instance({ properties: { label: undefined } }), 'label')).toBe(
      true,
    );
  });
});

describe('assetRefOf', () => {
  it('accepts a { src, mode } value', () => {
    expect(assetRefOf({ src: 'assets/panel.png', mode: 'file' })).toEqual({
      src: 'assets/panel.png',
      mode: 'file',
    });
  });

  it('rejects anything else', () => {
    expect(assetRefOf('assets/panel.png')).toBeUndefined();
    expect(assetRefOf({ src: 'a.png', mode: 'remote' })).toBeUndefined();
    expect(assetRefOf({ mode: 'file' })).toBeUndefined();
    expect(assetRefOf(null)).toBeUndefined();
  });
});

describe('commandErrorMessages', () => {
  it('lists every error-level diagnostic of a SchematicError', () => {
    const error = new SchematicError([
      { severity: 'error', code: 'canvas/unknown-widget', message: 'Unknown widget "x".' },
      { severity: 'warning', code: 'canvas/unknown-schematic', message: 'Not loaded.' },
      { severity: 'error', code: 'canvas/unknown-port', message: 'No port "p".' },
    ]);
    expect(commandErrorMessages(error)).toEqual(['Unknown widget "x".', 'No port "p".']);
  });

  it('falls back to the message for other errors', () => {
    expect(commandErrorMessages(new Error('boom'))).toEqual(['boom']);
    expect(commandErrorMessages('boom')).toEqual(['boom']);
    expect(commandErrorMessages(new SchematicError([]))).toEqual(['Schematic validation failed.']);
  });
});
