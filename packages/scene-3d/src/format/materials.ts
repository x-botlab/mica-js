/**
 * A reusable material preset.
 *
 * A preset bundles the physical properties the solver needs with the visual defaults an editor or
 * renderer applies. Entities may override the visual fields without changing the physical ones,
 * and an acrylic definition may override `density` for a custom sheet.
 *
 * Coefficients (`friction`, `restitution`, `opacity`, `metalness`, `roughness`) are unitless and
 * expected to lie in the 0–1 range.
 */
export interface MaterialPreset {
  /** Human-readable name shown in the editor. */
  readonly displayName: string;

  /** Density in g/cm³; the runtime converts it to kg/m³ when computing mass. */
  readonly density: number;

  /** Coulomb friction coefficient in the range 0–1. */
  readonly friction: number;

  /** Coefficient of restitution (bounciness) in the range 0–1. */
  readonly restitution: number;

  /** Default base color as a CSS color string; entities may override it. */
  readonly color?: string;

  /** Default opacity in the range 0–1, where 1 is fully opaque. */
  readonly opacity?: number;

  /** Default metalness in the range 0–1. */
  readonly metalness?: number;

  /** Default roughness in the range 0–1. */
  readonly roughness?: number;
}

/** Scene-level collection of material presets keyed by name. */
export interface MaterialLibrary {
  /** Presets keyed by the name entities use to reference them. */
  readonly presets: Readonly<Record<string, MaterialPreset>>;

  /** Key of the preset used by an acrylic definition that does not name one; defaults to `'acrylic'`. */
  readonly default?: string;
}

/**
 * Material presets shipped with every scene.
 *
 * Densities and coefficients follow the values in `docs/3d-scene-mode-design.md` §2.2. The set is
 * frozen so every document can share it without defensive copies.
 */
export const BUILTIN_MATERIAL_PRESETS = Object.freeze({
  acrylic: Object.freeze({
    displayName: '标准亚克力',
    density: 1.18,
    friction: 0.5,
    restitution: 0.3,
    color: '#ffffff',
    opacity: 0.9,
  }),
  'acrylic-colored': Object.freeze({
    displayName: '彩色亚克力',
    density: 1.18,
    friction: 0.5,
    restitution: 0.3,
    opacity: 0.85,
  }),
  'pc-board': Object.freeze({
    displayName: 'PC板（聚碳酸酯）',
    density: 1.2,
    friction: 0.4,
    restitution: 0.5,
    color: '#f0f0f0',
    opacity: 0.95,
  }),
  wood: Object.freeze({
    displayName: '木板',
    density: 0.65,
    friction: 0.6,
    restitution: 0.2,
    color: '#d2b48c',
  }),
  aluminum: Object.freeze({
    displayName: '铝板',
    density: 2.7,
    friction: 0.3,
    restitution: 0.4,
    color: '#c0c0c0',
    metalness: 0.8,
    roughness: 0.3,
  }),
  steel: Object.freeze({
    displayName: '钢板',
    density: 7.85,
    friction: 0.4,
    restitution: 0.3,
    color: '#808080',
    metalness: 0.9,
    roughness: 0.4,
  }),
  // 3D printing filaments
  pla: Object.freeze({
    displayName: 'PLA（聚乳酸）',
    density: 1.24,
    friction: 0.5,
    restitution: 0.2,
    color: '#e8e4d8',
    opacity: 1,
    metalness: 0,
    roughness: 0.6,
  }),
  abs: Object.freeze({
    displayName: 'ABS',
    density: 1.05,
    friction: 0.4,
    restitution: 0.3,
    color: '#cfd8dc',
    opacity: 1,
    metalness: 0,
    roughness: 0.55,
  }),
  petg: Object.freeze({
    displayName: 'PETG',
    density: 1.27,
    friction: 0.45,
    restitution: 0.25,
    color: '#cfe8f3',
    opacity: 0.85,
    metalness: 0,
    roughness: 0.3,
  }),
  tpu: Object.freeze({
    displayName: 'TPU（柔性材料）',
    density: 1.2,
    friction: 0.7,
    restitution: 0.5,
    color: '#4a4a4a',
    opacity: 1,
    metalness: 0,
    roughness: 0.9,
  }),
  // Common plastics
  pvc: Object.freeze({
    displayName: 'PVC（聚氯乙烯）',
    density: 1.38,
    friction: 0.5,
    restitution: 0.2,
    color: '#ececec',
    opacity: 1,
    metalness: 0,
    roughness: 0.45,
  }),
  pp: Object.freeze({
    displayName: 'PP（聚丙烯）',
    density: 0.9,
    friction: 0.3,
    restitution: 0.4,
    color: '#f5f5f0',
    opacity: 0.95,
    metalness: 0,
    roughness: 0.65,
  }),
  nylon: Object.freeze({
    displayName: 'Nylon（尼龙）',
    density: 1.14,
    friction: 0.25,
    restitution: 0.35,
    color: '#f0ead6',
    opacity: 0.95,
    metalness: 0,
    roughness: 0.7,
  }),
} satisfies Record<string, MaterialPreset>);
