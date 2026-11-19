import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_DARK_COLORS,
  WORKBENCH_LIGHT_COLORS,
  WORKBENCH_THEME_CSS_VARIABLES,
} from '../theme';
import {
  DEFAULT_HTML_VIEW_THEME,
  applyHtmlViewTheme,
  htmlViewBackgroundColor,
  htmlViewThemeCss,
  htmlViewThemeEquals,
  normalizeHtmlViewTheme,
} from './theme';

describe('html view theme', () => {
  it('completes a partial theme with the palette of its appearance', () => {
    const theme = normalizeHtmlViewTheme({ appearance: 'light', colors: { accent: '#123456' } });
    expect(theme.appearance).toBe('light');
    expect(theme.colors.accent).toBe('#123456');
    expect(theme.colors['canvas.background']).toBe(WORKBENCH_LIGHT_COLORS['canvas.background']);
    expect(Object.keys(theme.colors).sort()).toEqual(Object.keys(WORKBENCH_DARK_COLORS).sort());
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.colors)).toBe(true);
  });

  it('rejects an unknown appearance, token or color', () => {
    expect(() => normalizeHtmlViewTheme({ appearance: 'sepia' })).toThrow('appearance');
    expect(() => normalizeHtmlViewTheme({ colors: { nope: '#fff' } })).toThrow(
      'Unknown HTML view theme token',
    );
    expect(() => normalizeHtmlViewTheme({ colors: { border: '   ' } })).toThrow(
      'non-empty CSS color',
    );
    // A color that would end the declaration or escape the style element is not a color.
    expect(() => normalizeHtmlViewTheme({ colors: { border: '#fff}body{display:none' } })).toThrow(
      'plain CSS color',
    );
    expect(() => normalizeHtmlViewTheme(null)).toThrow('must be an object');
  });

  it('writes the view background, every token and the color scheme into one block', () => {
    const css = htmlViewThemeCss(DEFAULT_HTML_VIEW_THEME);
    // The author document starts on the view background, so the write itself paints no white.
    expect(
      css.startsWith(`:root{background-color:${WORKBENCH_DARK_COLORS['panel.background']};`),
    ).toBe(true);
    expect(css.endsWith('color-scheme:dark}')).toBe(true);
    for (const variable of Object.values(WORKBENCH_THEME_CSS_VARIABLES))
      expect(css).toContain(`${variable}:`);
    expect(htmlViewThemeCss(normalizeHtmlViewTheme({ appearance: 'light' }))).toContain(
      'color-scheme:light',
    );
  });

  it('paints the panel token as the generic view background', () => {
    expect(htmlViewBackgroundColor(DEFAULT_HTML_VIEW_THEME)).toBe(
      WORKBENCH_DARK_COLORS['panel.background'],
    );
    expect(htmlViewBackgroundColor(normalizeHtmlViewTheme({ appearance: 'light' }))).toBe(
      WORKBENCH_LIGHT_COLORS['panel.background'],
    );
    expect(
      htmlViewBackgroundColor(
        normalizeHtmlViewTheme({ colors: { 'panel.background': 'rgb(18, 52, 86)' } }),
      ),
    ).toBe('rgb(18, 52, 86)');
  });

  it('mirrors a theme onto a document root in place', () => {
    const properties = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
    } as unknown as HTMLElement;
    applyHtmlViewTheme(root, DEFAULT_HTML_VIEW_THEME);
    expect(properties.get('--mica-bg')).toBe(WORKBENCH_DARK_COLORS['workbench.background']);
    expect(properties.get('--mica-accent')).toBe(WORKBENCH_DARK_COLORS.accent);
    expect(properties.get('color-scheme')).toBe('dark');
    expect(properties.get('background-color')).toBe(WORKBENCH_DARK_COLORS['panel.background']);
    expect(properties.size).toBe(Object.keys(WORKBENCH_THEME_CSS_VARIABLES).length + 2);
  });

  it('compares appearances and every token', () => {
    expect(htmlViewThemeEquals(DEFAULT_HTML_VIEW_THEME, normalizeHtmlViewTheme({}))).toBe(true);
    expect(
      htmlViewThemeEquals(DEFAULT_HTML_VIEW_THEME, normalizeHtmlViewTheme({ appearance: 'light' })),
    ).toBe(false);
    const recolored = normalizeHtmlViewTheme({
      colors: { accent: WORKBENCH_LIGHT_COLORS.accent },
    });
    expect(recolored.appearance).toBe('dark');
    expect(htmlViewThemeEquals(DEFAULT_HTML_VIEW_THEME, recolored)).toBe(false);
  });
});
