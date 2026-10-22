import type { WidgetPlacement } from '@mica-js/core/canvas';
import { describe, expect, it } from 'vitest';
import {
  containsPoint,
  handlePoints,
  hitTestHandle,
  hitTestTopmost,
  placementBounds,
  placementCenter,
  resizePlacement,
  rotationFromPointer,
  snapDegrees,
  type Point,
  type ResizeHandle,
} from './geometry';
import { canvasDocument, widget } from './test-helpers';

describe('geometry', () => {
  describe('hit testing', () => {
    const rotated = widget('rotated', { x: 0, y: 0, width: 100, height: 100, rotation: 45 });

    it('tests against the rotated rectangle, not its bounding box', () => {
      expect(containsPoint(rotated, { x: 50, y: 50 })).toBe(true);
      // Inside the axis-aligned box, outside the rotated square.
      expect(containsPoint(rotated, { x: 0, y: 0 })).toBe(false);
      // Outside the unrotated rectangle, inside the rotated one.
      expect(containsPoint(rotated, { x: 110, y: 50 })).toBe(true);
    });

    it('returns the topmost instance when rectangles overlap', () => {
      const document = canvasDocument(
        widget('bottom', { x: 0, y: 0 }),
        widget('top', { x: 0, y: 0 }),
      );
      expect(hitTestTopmost(document.widgets, { x: 10, y: 10 })?.id).toBe('top');
    });

    it('misses points outside every instance', () => {
      const document = canvasDocument(widget('a', { x: 0, y: 0, width: 10, height: 10 }));
      expect(hitTestTopmost(document.widgets, { x: 40, y: 40 })).toBeUndefined();
    });
  });

  describe('bounds and handles', () => {
    it('measures the axis-aligned box of a rotated instance', () => {
      const bounds = placementBounds(
        widget('a', { x: 0, y: 0, width: 100, height: 100, rotation: 45 }),
      );
      expect(bounds.x).toBeCloseTo(-20.71, 2);
      expect(bounds.y).toBeCloseTo(-20.71, 2);
      expect(bounds.width).toBeCloseTo(141.42, 2);
      expect(bounds.height).toBeCloseTo(141.42, 2);
    });

    it('places the eight resize handles and the rotation handle', () => {
      const points = handlePoints(widget('a'), 20);
      expect(points.nw).toEqual({ x: 0, y: 0 });
      expect(points.n).toEqual({ x: 50, y: 0 });
      expect(points.se).toEqual({ x: 100, y: 50 });
      expect(points.w).toEqual({ x: 0, y: 25 });
      expect(points.rotate).toEqual({ x: 50, y: -20 });
    });

    it('prefers the rotation handle and corners over edges', () => {
      const placement = widget('a');
      expect(hitTestHandle(placement, { x: 100, y: 50 }, 8)).toBe('se');
      expect(hitTestHandle(placement, { x: 50, y: -20 }, 8, 20)).toBe('rotate');
      expect(hitTestHandle(placement, { x: 50, y: 0 }, 8, 20)).toBe('n');
      expect(hitTestHandle(placement, { x: 50, y: 25 }, 8, 20)).toBeUndefined();
    });
  });

  describe('resize', () => {
    const start = widget('a', { x: 0, y: 0, width: 100, height: 50 });

    it('keeps the opposite corner or edge fixed for every handle', () => {
      const cases: readonly [ResizeHandle, Point, WidgetPlacement][] = [
        ['nw', { x: -50, y: -25 }, { x: -50, y: -25, width: 150, height: 75, rotation: 0 }],
        ['n', { x: 50, y: -25 }, { x: 0, y: -25, width: 100, height: 75, rotation: 0 }],
        ['ne', { x: 150, y: -25 }, { x: 0, y: -25, width: 150, height: 75, rotation: 0 }],
        ['e', { x: 150, y: 25 }, { x: 0, y: 0, width: 150, height: 50, rotation: 0 }],
        ['se', { x: 150, y: 75 }, { x: 0, y: 0, width: 150, height: 75, rotation: 0 }],
        ['s', { x: 50, y: 75 }, { x: 0, y: 0, width: 100, height: 75, rotation: 0 }],
        ['sw', { x: -50, y: 75 }, { x: -50, y: 0, width: 150, height: 75, rotation: 0 }],
        ['w', { x: -50, y: 25 }, { x: -50, y: 0, width: 150, height: 50, rotation: 0 }],
      ];
      for (const [handle, pointer, expected] of cases) {
        expect(resizePlacement(start, handle, pointer), handle).toEqual(expected);
      }
    });

    it('returns the same placement when the pointer stays on the handle', () => {
      expect(resizePlacement(start, 'se', { x: 100, y: 50 })).toEqual({
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        rotation: 0,
      });
    });

    it('keeps the aspect ratio while Shift is held', () => {
      expect(resizePlacement(start, 'se', { x: 300, y: 100 }, { keepAspect: true })).toEqual({
        x: 0,
        y: 0,
        width: 300,
        height: 150,
        rotation: 0,
      });
      // An edge handle grows symmetrically along the other axis.
      expect(resizePlacement(start, 'e', { x: 300, y: 25 }, { keepAspect: true })).toEqual({
        x: 0,
        y: -50,
        width: 300,
        height: 150,
        rotation: 0,
      });
    });

    it('scales along the instance axes when rotated', () => {
      const rotated = widget('a', { x: 0, y: 0, width: 100, height: 50, rotation: 90 });
      // Rotation 90° points the local +y axis along document -x, so the "s" edge grows that way.
      const result = resizePlacement(rotated, 's', { x: -20, y: 25 });
      expect(result.rotation).toBe(90);
      expect(result.width).toBeCloseTo(100);
      expect(result.height).toBeCloseTo(95);
    });

    it('never shrinks below the minimum size', () => {
      const result = resizePlacement(start, 'se', { x: -500, y: -500 });
      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
    });
  });

  describe('rotation', () => {
    const center = placementCenter(widget('a'));

    it('converts a pointer angle into a clockwise rotation', () => {
      expect(center).toEqual({ x: 50, y: 25 });
      expect(rotationFromPointer(center, { x: 50, y: -75 })).toBeCloseTo(0);
      expect(rotationFromPointer(center, { x: 150, y: 25 })).toBeCloseTo(90);
      expect(rotationFromPointer(center, { x: 50, y: 125 })).toBeCloseTo(180);
    });

    it('applies the grab offset so the handle never jumps', () => {
      expect(rotationFromPointer(center, { x: 150, y: 25 }, { grabOffset: 10 })).toBeCloseTo(100);
    });

    it('snaps to 15 degree steps', () => {
      const radians = (20 * Math.PI) / 180;
      const pointer = { x: 50 + 100 * Math.cos(radians), y: 25 + 100 * Math.sin(radians) };
      expect(rotationFromPointer(center, pointer)).toBeCloseTo(110);
      expect(rotationFromPointer(center, pointer, { snap: true })).toBe(105);
      expect(snapDegrees(-20)).toBe(-15);
    });
  });
});
