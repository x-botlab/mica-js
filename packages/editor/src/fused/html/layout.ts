/**
 * Visible bounds of one environment slot (RFC 0023 container behaviour).
 *
 * The environment owner lives in a fixed layer, so nothing clips it for free: a slot that is
 * partially scrolled out of `.mica-wb-sidebar-content` would otherwise paint over the editor. The
 * manager clips the owner with `clip-path` instead of resizing it, so the page never reflows while
 * the surrounding UI scrolls.
 */

/** One viewport-aligned box, in CSS pixels. */
export interface IClipRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Insets of the visible part of a slot, relative to the slot box. */
export interface ISlotClip {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** `false` when the slot lies completely outside every clipping box. */
  readonly visible: boolean;
}

/**
 * Insets that clip one slot to the intersection of `bounds`.
 *
 * Every value is expressed against the slot box, so `clip-path: inset(...)` keeps the owner exactly
 * over the slot and only hides the parts outside the scrolling ancestors or the viewport.
 */
export function clipInsets(slot: IClipRect, bounds: readonly IClipRect[]): ISlotClip {
  if (!hasArea(slot)) {
    return { left: 0, top: 0, right: 0, bottom: 0, visible: false };
  }
  let left = slot.left;
  let top = slot.top;
  let right = slot.right;
  let bottom = slot.bottom;
  for (const bound of bounds) {
    left = Math.max(left, bound.left);
    top = Math.max(top, bound.top);
    right = Math.min(right, bound.right);
    bottom = Math.min(bottom, bound.bottom);
  }
  if (right <= left || bottom <= top) {
    return { left: 0, top: 0, right: 0, bottom: 0, visible: false };
  }
  return {
    left: left - slot.left,
    top: top - slot.top,
    right: slot.right - right,
    bottom: slot.bottom - bottom,
    visible: true,
  };
}

/** Whether one box has a positive extent. */
export function hasArea(rect: IClipRect): boolean {
  return rect.right > rect.left && rect.bottom > rect.top;
}

/** CSS `clip-path` value of one slot clip; `none` when nothing is cut. */
export function clipPathOf(clip: ISlotClip): string {
  if (!clip.visible) return 'inset(100%)';
  if (clip.left === 0 && clip.top === 0 && clip.right === 0 && clip.bottom === 0) return 'none';
  return `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px)`;
}
