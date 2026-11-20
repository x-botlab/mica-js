import type {
  IFusedDisplayLayout,
  IFusedInstancePresentation,
} from '@mica-js/editor/fused/runtime';

/**
 * Overlay density of the board presentation.
 *
 * The board package is a `physical` device: its geometry is in millimetres (199.27 × 142.47 mm),
 * so the editor default of one overlay pixel per local unit would allocate a 199 × 142 bitmap for
 * a full-size board and stretch it across the canvas. RFC 0022 leaves this precision to the host;
 * the board photo measures 4.33 px/mm (11 px per 0.1" header pitch), and a slightly lower 4 px/mm
 * keeps the digits, LED halos and slider knobs legible while staying cheaper than the 1068 × 768
 * overlay of the former photo-pixel geometry, on every 16 ms dynamic-scan repaint.
 */
export const OVERLAY_PX_PER_MM = 4;

/**
 * Overlay extent of one instance at the board density.
 *
 * Only the extent and the scale change; the presentation always draws in its own local units, so
 * the same hook works for any physical or flexible package in the document.
 */
export function measureOverlay(instance: IFusedInstancePresentation): IFusedDisplayLayout {
  const { bounds } = instance.geometry;
  return {
    width: Math.max(1, Math.round(bounds.width * OVERLAY_PX_PER_MM)),
    height: Math.max(1, Math.round(bounds.height * OVERLAY_PX_PER_MM)),
    scale: OVERLAY_PX_PER_MM,
  };
}
