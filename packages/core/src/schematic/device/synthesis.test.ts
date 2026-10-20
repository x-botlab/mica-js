import { describe, expect, it } from 'vitest';
import { synthesizeDeviceSymbol } from './synthesis';

describe('synthesizeDeviceSymbol', () => {
  it('places pins on their declared side', () => {
    const symbol = synthesizeDeviceSymbol({
      name: 'LDO',
      pins: {
        VIN: { side: 'top' },
        GND: { side: 'bottom' },
        EN: { side: 'left' },
        OUT: { side: 'right' },
      },
    });

    expect(symbol.pins['VIN']?.side).toBe('top');
    expect(symbol.pins['GND']?.side).toBe('bottom');
    expect(symbol.pins['EN']?.side).toBe('left');
    expect(symbol.pins['OUT']?.side).toBe('right');
  });

  it('draws pins without a side on the left', () => {
    const symbol = synthesizeDeviceSymbol({ name: 'X', pins: { A: {}, B: {} } });
    expect(symbol.pins['A']?.side).toBe('left');
    expect(symbol.pins['B']?.side).toBe('left');
  });

  it('keeps declaration order within a side and spaces pins by pitch', () => {
    const symbol = synthesizeDeviceSymbol(
      { name: 'MCU', pins: { A: { side: 'left' }, B: { side: 'left' } } },
      { pinPitch: 10 },
    );
    expect(symbol.pins['A']!.y).toBe(-5);
    expect(symbol.pins['B']!.y).toBe(5);
    expect(symbol.pins['B']!.x - symbol.pins['A']!.x).toBe(0);
  });

  it('stacks top and bottom pins horizontally in declaration order', () => {
    const symbol = synthesizeDeviceSymbol({
      name: 'BUS',
      pins: { T0: { side: 'top' }, T1: { side: 'top' }, B0: { side: 'bottom' } },
    });
    expect(symbol.pins['T0']!.x).toBeLessThan(symbol.pins['T1']!.x);
    expect(symbol.pins['T0']!.y).toBe(symbol.pins['T1']!.y);
    expect(symbol.pins['B0']!.y).toBeGreaterThan(symbol.pins['T0']!.y);
  });

  it('wraps the pins in a body that contains every anchor', () => {
    const symbol = synthesizeDeviceSymbol({
      name: 'NE555',
      pins: {
        GND: { side: 'bottom' },
        TRIG: { side: 'left' },
        OUT: { side: 'right' },
        VCC: { side: 'top' },
      },
    });
    const bounds = symbol.bounds!;
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    for (const pin of Object.values(symbol.pins)) {
      const outsideX = pin.x < bounds.x || pin.x > bounds.x + bounds.width;
      const outsideY = pin.y < bounds.y || pin.y > bounds.y + bounds.height;
      // Stubs always sit outside the body on the axis they leave from.
      expect(outsideX || outsideY).toBe(true);
    }
    expect(symbol.name).toBe('NE555');
  });

  it('is deterministic', () => {
    const declaration = {
      VCC: { side: 'top' },
      IN: { side: 'left' },
      OUT: { side: 'right' },
    } as const;
    expect(synthesizeDeviceSymbol({ name: 'X', pins: declaration })).toEqual(
      synthesizeDeviceSymbol({ name: 'X', pins: declaration }),
    );
  });

  it('accepts layout overrides', () => {
    const symbol = synthesizeDeviceSymbol(
      { name: 'X', pins: { A: { side: 'left' } } },
      { pinPitch: 20, stubLength: 30, minWidth: 120, minHeight: 80 },
    );
    expect(symbol.bounds).toEqual({ x: -60, y: -40, width: 120, height: 80 });
    expect(symbol.pins['A']).toEqual({ x: -90, y: 0, side: 'left' });
  });
});
