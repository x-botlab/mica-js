export const WORKBENCH_THEME_CSS_VARIABLES = Object.freeze({
  'workbench.background': '--mica-bg',
  'workbench.foreground': '--mica-text',
  'workbench.mutedForeground': '--mica-muted',
  'panel.background': '--mica-panel',
  border: '--mica-border',
  accent: '--mica-accent',
  'accent.foreground': '--mica-accent-foreground',
  'selection.background': '--mica-active',
  'focus.border': '--mica-focus',
  'canvas.background': '--mica-canvas-background',
  'canvas.grid': '--mica-canvas-grid',
  'canvas.foreground': '--mica-canvas-foreground',
  'canvas.wire': '--mica-canvas-wire',
  'canvas.pin': '--mica-canvas-pin',
  'canvas.selection': '--mica-canvas-selection',
  'error.foreground': '--mica-error',
  shadow: '--mica-shadow',
} as const);

export type WorkbenchColorToken = keyof typeof WORKBENCH_THEME_CSS_VARIABLES;
export type WorkbenchThemeColors = Readonly<Record<WorkbenchColorToken, string>>;
export type WorkbenchThemeAppearance = 'dark' | 'light' | 'system';
export type WorkbenchTheme = WorkbenchThemeAppearance | IWorkbenchTheme;

export interface IWorkbenchTheme {
  readonly appearance?: WorkbenchThemeAppearance;
  readonly colors?: Partial<WorkbenchThemeColors>;
}

export interface IResolvedWorkbenchTheme {
  readonly appearance: 'dark' | 'light';
  readonly colors: WorkbenchThemeColors;
}

export const WORKBENCH_DARK_COLORS: WorkbenchThemeColors = Object.freeze({
  'workbench.background': '#1c1c1c',
  'workbench.foreground': '#e5e5e5',
  'workbench.mutedForeground': '#a3a3a3',
  'panel.background': '#242424',
  border: '#383838',
  accent: '#d4d4d4',
  'accent.foreground': '#171717',
  'selection.background': '#353535',
  'focus.border': '#b8b8b8',
  'canvas.background': '#151515',
  'canvas.grid': '#303030',
  'canvas.foreground': '#d4d4d4',
  'canvas.wire': '#a3a3a3',
  'canvas.pin': '#c4c4c4',
  'canvas.selection': '#eeeeee',
  'error.foreground': '#f28b82',
  shadow: '#00000055',
});

export const WORKBENCH_LIGHT_COLORS: WorkbenchThemeColors = Object.freeze({
  'workbench.background': '#ffffff',
  'workbench.foreground': '#263247',
  'workbench.mutedForeground': '#748098',
  'panel.background': '#fafbfe',
  border: '#e2e6ed',
  accent: '#336df0',
  'accent.foreground': '#ffffff',
  'selection.background': '#e8efff',
  'focus.border': '#336df0',
  'canvas.background': '#f6f7fa',
  'canvas.grid': '#cdd3de',
  'canvas.foreground': '#354058',
  'canvas.wire': '#508d79',
  'canvas.pin': '#4285ff',
  'canvas.selection': '#4285ff',
  'error.foreground': '#b43b35',
  shadow: '#00000022',
});

function isToken(value: string): value is WorkbenchColorToken {
  return Object.hasOwn(WORKBENCH_THEME_CSS_VARIABLES, value);
}

export function normalizeTheme(theme: WorkbenchTheme = 'dark'): IWorkbenchTheme {
  const appearance = typeof theme === 'string' ? theme : (theme.appearance ?? 'dark');
  if (!['dark', 'light', 'system'].includes(appearance))
    throw new Error(`Unknown workbench theme appearance: ${appearance}`);
  const colors: Partial<Record<WorkbenchColorToken, string>> = {};
  if (typeof theme !== 'string') {
    for (const [token, value] of Object.entries(theme.colors ?? {})) {
      if (!isToken(token)) throw new Error(`Unknown workbench color token: ${token}`);
      if (typeof value !== 'string' || value.trim() === '')
        throw new Error(`Workbench color token ${token} must be a non-empty CSS color`);
      colors[token] = value;
    }
  }
  return Object.freeze({ appearance, colors: Object.freeze(colors) });
}

export function resolveTheme(theme: IWorkbenchTheme, systemDark: boolean): IResolvedWorkbenchTheme {
  const appearance =
    theme.appearance === 'system' ? (systemDark ? 'dark' : 'light') : (theme.appearance ?? 'dark');
  return Object.freeze({
    appearance,
    colors: Object.freeze({
      ...(appearance === 'dark' ? WORKBENCH_DARK_COLORS : WORKBENCH_LIGHT_COLORS),
      ...theme.colors,
    }),
  });
}

export function themeStyle(theme: IResolvedWorkbenchTheme): Record<`--mica-${string}`, string> {
  const result: Record<`--mica-${string}`, string> = {};
  for (const [token, variable] of Object.entries(WORKBENCH_THEME_CSS_VARIABLES))
    if (isToken(token)) result[variable] = theme.colors[token];
  return result;
}

export function readCanvasTheme(element: HTMLElement): WorkbenchThemeColors {
  const style = getComputedStyle(element);
  const colors = { ...WORKBENCH_DARK_COLORS };
  for (const [token, variable] of Object.entries(WORKBENCH_THEME_CSS_VARIABLES)) {
    if (!isToken(token)) continue;
    const value = style.getPropertyValue(variable).trim();
    if (value === '' || !CSS.supports('color', value))
      throw new Error(`Workbench token ${token} did not resolve to a CSS color`);
    colors[token] = value;
  }
  return colors;
}
