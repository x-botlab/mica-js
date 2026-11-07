export {
  areaOfRings,
  parseAcrylicContour,
  parseSvgPath,
  validateAcrylicDefinition,
  normalizeAcrylicContour,
  normaliseAcrylicContour,
} from './contour';
export { buildAcrylicMesh, createAcrylicMesh, triangulateAcrylicContour } from './mesh';
export { calculateAcrylicMass, computeAcrylicPhysics, resolveAcrylicMaterial } from './physics';
export type { AcrylicPhysicsOptions, ResolvedAcrylicMaterial } from './physics';
export type {
  AcrylicContour,
  AcrylicContourOptions,
  AcrylicDefinition,
  AcrylicMaterialOverride,
  AcrylicMesh,
  AcrylicPhysics,
  AcrylicRing,
  ParsedAcrylicContour,
  AcrylicLibrary,
  AcrylicPreset,
} from './types';
