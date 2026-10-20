/** Any CSS color string; Canvas and CSS parse it. */
export type ThemeColor = string;

/**
 * Rendering and chrome tokens. The renderer never hard-codes colors: every visible
 * value comes from a theme.
 */
export interface SchematicTheme {
  background: ThemeColor;
  grid: ThemeColor;
  gridMajor: ThemeColor;

  wire: ThemeColor;
  wireSelected: ThemeColor;
  junction: ThemeColor;
  junctionSelected: ThemeColor;
  pendingWire: ThemeColor;

  symbolFill: ThemeColor;
  symbolStroke: ThemeColor;
  symbolText: ThemeColor;
  symbolPlaceholder: ThemeColor;
  pin: ThemeColor;
  pinText: ThemeColor;
  pinOpen: ThemeColor;

  labelAnchor: ThemeColor;
  labelText: ThemeColor;

  selection: ThemeColor;
  hover: ThemeColor;

  uiBackground: ThemeColor;
  uiSurface: ThemeColor;
  uiBorder: ThemeColor;
  uiText: ThemeColor;
  uiMutedText: ThemeColor;
  uiAccent: ThemeColor;
  uiAccentText: ThemeColor;
  focusRing: ThemeColor;

  fontFamily: string;
  fontSize: number;
  /** Pin name text; smaller than `fontSize` so labels stay inside the body. */
  pinFontSize: number;
  /** Device name drawn in the symbol centre. */
  symbolFontSize: number;
  gridSize: number;
}

/**
 * Default dark theme: neutral greys on near-black, matching the reference palette
 * (background `#0a0a0a`, foreground `#fafafa`, muted `#a1a1a1`, ring `#737373`).
 */
export const DARK_SCHEMATIC_THEME: SchematicTheme = {
  background: '#0a0a0a',
  grid: 'rgba(250, 250, 250, 0.06)',
  gridMajor: 'rgba(250, 250, 250, 0.12)',

  wire: '#a1a1a1',
  wireSelected: '#fafafa',
  junction: '#e5e5e5',
  junctionSelected: '#fafafa',
  pendingWire: '#fafafa',

  symbolFill: '#171717',
  symbolStroke: '#737373',
  symbolText: '#fafafa',
  symbolPlaceholder: 'rgba(250, 250, 250, 0.28)',
  pin: '#737373',
  pinText: '#a1a1a1',
  pinOpen: '#e5e5e5',

  labelAnchor: '#737373',
  labelText: '#fafafa',

  selection: '#fafafa',
  hover: '#a1a1a1',

  uiBackground: '#0a0a0a',
  uiSurface: '#171717',
  uiBorder: 'rgba(250, 250, 250, 0.1)',
  uiText: '#fafafa',
  uiMutedText: '#a1a1a1',
  uiAccent: '#e5e5e5',
  uiAccentText: '#171717',
  focusRing: '#737373',

  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 9,
  pinFontSize: 7,
  symbolFontSize: 9,
  gridSize: 10,
};

export const LIGHT_SCHEMATIC_THEME: SchematicTheme = {
  background: '#ffffff',
  grid: 'rgba(10, 10, 10, 0.05)',
  gridMajor: 'rgba(10, 10, 10, 0.1)',

  wire: '#525252',
  wireSelected: '#0a0a0a',
  junction: '#262626',
  junctionSelected: '#0a0a0a',
  pendingWire: '#0a0a0a',

  symbolFill: '#fafafa',
  symbolStroke: '#a1a1a1',
  symbolText: '#0a0a0a',
  symbolPlaceholder: 'rgba(10, 10, 10, 0.3)',
  pin: '#a1a1a1',
  pinText: '#525252',
  pinOpen: '#262626',

  labelAnchor: '#a1a1a1',
  labelText: '#0a0a0a',

  selection: '#0a0a0a',
  hover: '#525252',

  uiBackground: '#ffffff',
  uiSurface: '#f5f5f5',
  uiBorder: 'rgba(10, 10, 10, 0.1)',
  uiText: '#0a0a0a',
  uiMutedText: '#525252',
  uiAccent: '#171717',
  uiAccentText: '#fafafa',
  focusRing: '#a1a1a1',

  fontFamily: DARK_SCHEMATIC_THEME.fontFamily,
  fontSize: DARK_SCHEMATIC_THEME.fontSize,
  pinFontSize: DARK_SCHEMATIC_THEME.pinFontSize,
  symbolFontSize: DARK_SCHEMATIC_THEME.symbolFontSize,
  gridSize: DARK_SCHEMATIC_THEME.gridSize,
};

/** Merges overrides onto the dark baseline, so partial themes stay readable. */
export function resolveSchematicTheme(overrides: Partial<SchematicTheme> = {}): SchematicTheme {
  const resolved: SchematicTheme = { ...DARK_SCHEMATIC_THEME };
  for (const key of Object.keys(overrides) as (keyof SchematicTheme)[]) {
    const value = overrides[key];
    if (value !== undefined) {
      Object.assign(resolved, { [key]: value });
    }
  }
  return resolved;
}

/** Maps the theme onto `--mica-schematic-*` CSS variables for light-DOM chrome. */
export function themeToCssVariables(theme: SchematicTheme): Readonly<Record<string, string>> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    variables[`--mica-schematic-${kebabCase(key)}`] = String(value);
  }
  return variables;
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
