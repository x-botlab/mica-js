import { describe, expect, it } from 'vitest';
import {
  DARK_SCHEMATIC_THEME,
  LIGHT_SCHEMATIC_THEME,
  resolveSchematicTheme,
  themeToCssVariables,
  type SchematicTheme,
} from './theme';

describe('theme', () => {
  it('defaults to a dark, neutral palette', () => {
    expect(DARK_SCHEMATIC_THEME.background).toBe('#0a0a0a');
    expect(DARK_SCHEMATIC_THEME.symbolText).toBe('#fafafa');
    expect(DARK_SCHEMATIC_THEME.pinText).toBe('#a1a1a1');
    expect(DARK_SCHEMATIC_THEME.symbolStroke).toBe(DARK_SCHEMATIC_THEME.wire);
  });

  it('resolves partial overrides onto the dark baseline', () => {
    const theme = resolveSchematicTheme({ wire: '#ff0000', gridSize: 20 });
    expect(theme.wire).toBe('#ff0000');
    expect(theme.gridSize).toBe(20);
    expect(theme.background).toBe(DARK_SCHEMATIC_THEME.background);
    expect(theme.fontFamily).toBe(DARK_SCHEMATIC_THEME.fontFamily);
  });

  it('does not let explicit undefined override defaults', () => {
    const theme = resolveSchematicTheme({ wire: undefined } as unknown as Partial<SchematicTheme>);
    expect(theme.wire).toBe(DARK_SCHEMATIC_THEME.wire);
  });

  it('exposes the same token set in both themes', () => {
    expect(Object.keys(LIGHT_SCHEMATIC_THEME).sort()).toEqual(
      Object.keys(DARK_SCHEMATIC_THEME).sort(),
    );
  });

  it('maps tokens to kebab-case CSS variables', () => {
    const variables = themeToCssVariables(DARK_SCHEMATIC_THEME);
    expect(variables['--mica-schematic-background']).toBe('#0a0a0a');
    expect(variables['--mica-schematic-ui-muted-text']).toBe('#a1a1a1');
    expect(variables['--mica-schematic-grid-size']).toBe('10');
    expect(variables['--mica-schematic-font-size']).toBe('9');
    expect(variables['--mica-schematic-pin-font-size']).toBe('7');
  });

  it('draws the device name at the label font size', () => {
    expect(DARK_SCHEMATIC_THEME.symbolFontSize).toBe(DARK_SCHEMATIC_THEME.fontSize);
  });

  it('keeps pin labels smaller than symbol text', () => {
    expect(DARK_SCHEMATIC_THEME.pinFontSize).toBeLessThan(DARK_SCHEMATIC_THEME.fontSize);
  });
});
