import { describe, expect, it } from 'vitest';
import { clipInsets, clipPathOf, hasArea } from './layout';

const VIEWPORT = { left: 0, top: 0, right: 1000, bottom: 800 };

describe('clipInsets', () => {
  it('keeps a fully visible slot untouched', () => {
    const slot = { left: 20, top: 40, right: 320, bottom: 440 };
    const clip = clipInsets(slot, [VIEWPORT]);
    expect(clip).toEqual({ left: 0, top: 0, right: 0, bottom: 0, visible: true });
    expect(clipPathOf(clip)).toBe('none');
  });

  it('clips the part of a slot that scrolled under its container', () => {
    const slot = { left: 20, top: -50, right: 320, bottom: 350 };
    const scroller = { left: 0, top: 0, right: 340, bottom: 200 };
    const clip = clipInsets(slot, [VIEWPORT, scroller]);
    expect(clip).toEqual({ left: 0, top: 50, right: 0, bottom: 150, visible: true });
    expect(clipPathOf(clip)).toBe('inset(50px 0px 150px 0px)');
  });

  it('clips a slot that overflows the right edge of a narrow container', () => {
    const slot = { left: 20, top: 40, right: 620, bottom: 240 };
    const scroller = { left: 0, top: 0, right: 340, bottom: 200 };
    const clip = clipInsets(slot, [VIEWPORT, scroller]);
    expect(clip).toEqual({ left: 0, top: 0, right: 280, bottom: 40, visible: true });
  });

  it('clips to the viewport when the slot leaves the window', () => {
    const slot = { left: 900, top: 700, right: 1300, bottom: 1100 };
    expect(clipInsets(slot, [VIEWPORT])).toEqual({
      left: 0,
      top: 0,
      right: 300,
      bottom: 300,
      visible: true,
    });
  });

  it('hides a slot that is completely scrolled away', () => {
    const slot = { left: 20, top: -400, right: 320, bottom: -100 };
    const scroller = { left: 0, top: 0, right: 340, bottom: 200 };
    const clip = clipInsets(slot, [VIEWPORT, scroller]);
    expect(clip.visible).toBe(false);
    expect(clipPathOf(clip)).toBe('inset(100%)');
  });

  it('hides a collapsed slot', () => {
    expect(clipInsets({ left: 10, top: 10, right: 10, bottom: 10 }, [VIEWPORT]).visible).toBe(
      false,
    );
  });

  it('recognizes boxes with a positive extent', () => {
    expect(hasArea({ left: 0, top: 0, right: 1, bottom: 1 })).toBe(true);
    expect(hasArea({ left: 0, top: 0, right: 0, bottom: 10 })).toBe(false);
  });
});
