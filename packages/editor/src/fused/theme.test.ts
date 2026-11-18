import { describe, expect, it } from 'vitest';
import { normalizeTheme, resolveTheme, themeStyle } from './theme';

describe('workbench themes', () => {
  it('defaults to dark and only follows the OS when explicitly requested', () => {
    expect(resolveTheme(normalizeTheme(), false).appearance).toBe('dark');
    expect(resolveTheme(normalizeTheme('system'), false).appearance).toBe('light');
    expect(resolveTheme(normalizeTheme('system'), true).appearance).toBe('dark');
  });
  it('retains host token overrides across system appearance changes without sharing host storage', () => {
    const colors = { accent: '#a855f7', 'canvas.background': '#102030' };
    const theme = normalizeTheme({ appearance: 'system', colors });
    colors.accent = '#ff0000';
    for (const systemDark of [true, false]) {
      const resolved = resolveTheme(theme, systemDark);
      expect(resolved.colors.accent).toBe('#a855f7');
      expect(themeStyle(resolved)['--mica-canvas-background']).toBe('#102030');
    }
  });
  it('reports unknown and empty tokens rather than silently ignoring host configuration', () => {
    const invalid = { colors: { accent: '#123456', 'canvas.backgound': '#000' } };
    expect(() => normalizeTheme(invalid)).toThrow('Unknown workbench color token');
    expect(() => normalizeTheme({ colors: { accent: '' } })).toThrow('non-empty CSS color');
  });
});
