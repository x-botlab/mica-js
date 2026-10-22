/** Rendering tokens of the canvas editor; nothing visible is hard-coded in the renderer. */
export interface CanvasTheme {
  readonly background: string;
  readonly grid: string;
  readonly gridMajor: string;
  readonly selection: string;
  readonly handleFill: string;
  readonly handleStroke: string;
  readonly rotateHandle: string;
  readonly placeholderFill: string;
  readonly placeholderStroke: string;
  /** Grid step in document units; it grows automatically when zoomed far out. */
  readonly gridSize: number;
}

/** Default dark theme, matching the playground palette (`#0a0a0a` / `#fafafa`). */
export const DARK_CANVAS_THEME: CanvasTheme = {
  background: '#0a0a0a',
  grid: 'rgba(250, 250, 250, 0.06)',
  gridMajor: 'rgba(250, 250, 250, 0.12)',
  selection: '#fafafa',
  handleFill: '#0a0a0a',
  handleStroke: '#fafafa',
  rotateHandle: '#e5e5e5',
  placeholderFill: 'rgba(250, 250, 250, 0.04)',
  placeholderStroke: 'rgba(250, 250, 250, 0.28)',
  gridSize: 10,
};

export const LIGHT_CANVAS_THEME: CanvasTheme = {
  background: '#ffffff',
  grid: 'rgba(10, 10, 10, 0.05)',
  gridMajor: 'rgba(10, 10, 10, 0.1)',
  selection: '#0a0a0a',
  handleFill: '#ffffff',
  handleStroke: '#0a0a0a',
  rotateHandle: '#262626',
  placeholderFill: 'rgba(10, 10, 10, 0.03)',
  placeholderStroke: 'rgba(10, 10, 10, 0.3)',
  gridSize: 10,
};

/** Merges overrides onto the dark baseline, so partial themes stay readable. */
export function resolveCanvasTheme(overrides: Partial<CanvasTheme> = {}): CanvasTheme {
  const resolved: CanvasTheme = { ...DARK_CANVAS_THEME };
  for (const key of Object.keys(overrides) as (keyof CanvasTheme)[]) {
    const value = overrides[key];
    if (value !== undefined) {
      Object.assign(resolved, { [key]: value });
    }
  }
  return resolved;
}
