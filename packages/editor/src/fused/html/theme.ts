/**
 * Theme mirroring of the device HTML views (RFC 0023).
 *
 * The editor forwards the computed colors of its workbench tokens over the typed host bridge; the
 * environment injects them into the author document before any author script runs and updates the
 * document root in place afterwards, so a theme change never reloads a frame and never loses author
 * input, model session or document history. An environment without an editor theme keeps a complete
 * dark palette, so the author document always resolves every token.
 */
import {
  WORKBENCH_DARK_COLORS,
  WORKBENCH_LIGHT_COLORS,
  WORKBENCH_THEME_CSS_VARIABLES,
} from '../theme';
import type { WorkbenchColorToken, WorkbenchThemeColors } from '../theme';
import type { IHtmlViewTheme } from './protocol';

/** Theme of an environment whose editor forwarded no colors yet. */
export const DEFAULT_HTML_VIEW_THEME: IHtmlViewTheme = Object.freeze({
  appearance: 'dark',
  colors: WORKBENCH_DARK_COLORS,
});

const TOKENS = Object.keys(WORKBENCH_THEME_CSS_VARIABLES) as readonly WorkbenchColorToken[];

/**
 * Semantic token the generic view background uses.
 *
 * A device view sits inside a workbench panel, so its loading surface is the panel background; the
 * author example paints its own `body` with the same token, which keeps the first paint and the
 * author document seamless.
 */
export const HTML_VIEW_BACKGROUND_TOKEN: WorkbenchColorToken = 'panel.background';

/** Resolved CSS color of the view background of one theme. */
export function htmlViewBackgroundColor(theme: IHtmlViewTheme): string {
  return theme.colors[HTML_VIEW_BACKGROUND_TOKEN];
}

/** Characters that would end the injected declaration or the style element. */
const UNSAFE_COLOR = /[;{}<>\\]/;

/**
 * Validates one theme crossing the bridge and completes missing tokens.
 *
 * @throws {TypeError} when the appearance is unknown, a token is undeclared or a color cannot be
 * placed in a style declaration.
 */
export function normalizeHtmlViewTheme(value: unknown): IHtmlViewTheme {
  if (typeof value !== 'object' || value === null)
    throw new TypeError('An HTML view theme must be an object');
  const record = value as { readonly appearance?: unknown; readonly colors?: unknown };
  const appearance = record.appearance ?? 'dark';
  if (appearance !== 'dark' && appearance !== 'light')
    throw new TypeError(`Unknown HTML view theme appearance: ${String(appearance)}`);
  const colors: Partial<Record<WorkbenchColorToken, string>> = {
    ...(appearance === 'dark' ? WORKBENCH_DARK_COLORS : WORKBENCH_LIGHT_COLORS),
  };
  const source = record.colors;
  if (source !== undefined && source !== null) {
    if (typeof source !== 'object') throw new TypeError('HTML view theme colors must be an object');
    for (const [token, color] of Object.entries(source)) {
      if (!Object.hasOwn(WORKBENCH_THEME_CSS_VARIABLES, token))
        throw new TypeError(`Unknown HTML view theme token: ${token}`);
      colors[token as WorkbenchColorToken] = htmlViewColor(token, color);
    }
  }
  for (const token of TOKENS) colors[token] ??= htmlViewColor(token, WORKBENCH_DARK_COLORS[token]);
  return Object.freeze({
    appearance,
    colors: Object.freeze(colors as WorkbenchThemeColors),
  });
}

function htmlViewColor(token: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`HTML view theme token ${token} must be a non-empty CSS color`);
  if (UNSAFE_COLOR.test(value))
    throw new TypeError(`HTML view theme token ${token} must be a plain CSS color`);
  return value.trim();
}

/** Whether two themes resolve to the same appearance and colors. */
export function htmlViewThemeEquals(left: IHtmlViewTheme, right: IHtmlViewTheme): boolean {
  if (left.appearance !== right.appearance) return false;
  return TOKENS.every((token) => left.colors[token] === right.colors[token]);
}

/** Theme declarations injected into the author document head before any author script. */
export function htmlViewThemeCss(theme: IHtmlViewTheme): string {
  const declarations = TOKENS.map(
    (token) => `${WORKBENCH_THEME_CSS_VARIABLES[token]}:${theme.colors[token]}`,
  );
  declarations.push(`color-scheme:${theme.appearance}`);
  // The canvas behind the author page starts as the view background, so no white frame is ever
  // painted between the document write and the first author stylesheet.
  return `:root{background-color:${htmlViewBackgroundColor(theme)};${declarations.join(';')}}`;
}

/** Mirrors every theme token onto the root element of one document, in place. */
export function applyHtmlViewTheme(root: HTMLElement, theme: IHtmlViewTheme): void {
  const style = root.style;
  for (const token of TOKENS)
    style.setProperty(WORKBENCH_THEME_CSS_VARIABLES[token], theme.colors[token]);
  style.setProperty('color-scheme', theme.appearance);
  style.setProperty('background-color', htmlViewBackgroundColor(theme));
}
