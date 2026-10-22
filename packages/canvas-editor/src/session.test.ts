import { describe, expect, it } from 'vitest';
import { CanvasInteractionSession } from './session';
import { canvasDocument, widget } from './test-helpers';
import { MAX_VIEWPORT_SCALE, MIN_VIEWPORT_SCALE, screenToDocument } from './viewport';

const drawing = canvasDocument(widget('a'), widget('b', { x: 200, y: 0 }));

describe('CanvasInteractionSession', () => {
  describe('selection', () => {
    it('selects the instance under the press and clears on empty space', () => {
      const session = new CanvasInteractionSession();
      const first = session.pointerDown(drawing, { x: 10, y: 10 });
      expect(first.selection).toEqual(['a']);
      expect(first.redraw).toBe(true);
      expect(first.commands).toEqual([]);

      const cleared = session.pointerDown(drawing, { x: 500, y: 500 });
      expect(cleared.selection).toEqual([]);
      expect(cleared.redraw).toBe(true);
    });

    it('adds and removes with Shift or Ctrl', () => {
      const session = new CanvasInteractionSession();
      session.pointerDown(drawing, { x: 10, y: 10 });
      expect(session.pointerDown(drawing, { x: 210, y: 10, shiftKey: true }).selection).toEqual([
        'a',
        'b',
      ]);
      expect(session.pointerDown(drawing, { x: 210, y: 10, ctrlKey: true }).selection).toEqual([
        'a',
      ]);
    });

    it('selects everything with Cmd/Ctrl+A', () => {
      const session = new CanvasInteractionSession();
      const result = session.keyDown(drawing, { key: 'a', ctrlKey: true });
      expect(result.selection).toEqual(['a', 'b']);
      expect(result.commands).toEqual([]);
    });
  });

  describe('dragging', () => {
    it('needs more than three CSS pixels before it becomes a drag', () => {
      const session = new CanvasInteractionSession();
      session.pointerDown(drawing, { x: 50, y: 25 });

      session.pointerMove(drawing, { x: 52, y: 25 });
      expect(session.interaction).toBe('pressed');
      expect(session.previews.size).toBe(0);

      session.pointerMove(drawing, { x: 55, y: 25 });
      expect(session.interaction).toBe('dragging');
      expect(session.previews.get('a')).toEqual({
        x: 5,
        y: 0,
        width: 100,
        height: 50,
        rotation: 0,
      });
    });

    it('emits one set-placement on release and nothing while dragging', () => {
      const session = new CanvasInteractionSession();
      session.pointerDown(drawing, { x: 50, y: 25 });
      expect(session.pointerMove(drawing, { x: 55, y: 25 }).commands).toEqual([]);
      expect(session.pointerMove(drawing, { x: 80, y: 45 }).commands).toEqual([]);
      expect(session.previews.get('a')).toMatchObject({ x: 30, y: 20 });

      const released = session.pointerUp(drawing, { x: 80, y: 45 });
      expect(released.commands).toEqual([
        {
          type: 'set-placement',
          instanceId: 'a',
          placement: { x: 30, y: 20, width: 100, height: 50, rotation: 0 },
        },
      ]);
      expect(released.selection).toEqual(['a']);
      expect(session.previews.size).toBe(0);
      expect(session.interaction).toBe('idle');
    });

    it('moves every selected instance', () => {
      const session = new CanvasInteractionSession({ selection: ['a', 'b'] });
      session.pointerDown(drawing, { x: 10, y: 10 });
      expect(session.selection).toEqual(['a', 'b']);
      session.pointerMove(drawing, { x: 30, y: 10 });
      const released = session.pointerUp(drawing, { x: 30, y: 10 });

      expect(released.commands).toEqual([
        {
          type: 'set-placement',
          instanceId: 'a',
          placement: { x: 20, y: 0, width: 100, height: 50, rotation: 0 },
        },
        {
          type: 'set-placement',
          instanceId: 'b',
          placement: { x: 220, y: 0, width: 100, height: 50, rotation: 0 },
        },
      ]);
    });

    it('emits no command after cancelInteraction', () => {
      const session = new CanvasInteractionSession();
      session.pointerDown(drawing, { x: 50, y: 25 });
      session.pointerMove(drawing, { x: 80, y: 45 });
      expect(session.previews.size).toBe(1);

      session.cancelInteraction();
      expect(session.previews.size).toBe(0);
      expect(session.interaction).toBe('idle');

      const released = session.pointerUp(drawing, { x: 80, y: 45 });
      expect(released.commands).toEqual([]);
    });
  });

  describe('resizing', () => {
    it('scales from the pressed handle and emits one placement on release', () => {
      const session = new CanvasInteractionSession({ selection: ['a'] });
      const pressed = session.pointerDown(drawing, { x: 100, y: 50 });
      expect(session.interaction).toBe('scaling');
      expect(pressed.commands).toEqual([]);

      const moved = session.pointerMove(drawing, { x: 200, y: 100 });
      expect(moved.commands).toEqual([]);
      expect(session.previews.get('a')).toEqual({
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        rotation: 0,
      });

      const released = session.pointerUp(drawing, { x: 200, y: 100 });
      expect(released.commands).toEqual([
        {
          type: 'set-placement',
          instanceId: 'a',
          placement: { x: 0, y: 0, width: 200, height: 100, rotation: 0 },
        },
      ]);
    });

    it('keeps the aspect ratio while Shift is held', () => {
      const session = new CanvasInteractionSession({ selection: ['a'] });
      session.pointerDown(drawing, { x: 100, y: 50 });
      session.pointerMove(drawing, { x: 300, y: 100, shiftKey: true });
      expect(session.previews.get('a')).toEqual({
        x: 0,
        y: 0,
        width: 300,
        height: 150,
        rotation: 0,
      });
    });
  });

  describe('rotating', () => {
    it('turns the instance around its center', () => {
      const session = new CanvasInteractionSession({ selection: ['a'] });
      // The rotation handle sits 20 CSS pixels above the top edge of a 100×50 instance at (0, 0).
      const pressed = session.pointerDown(drawing, { x: 50, y: -20 });
      expect(session.interaction).toBe('rotating');
      expect(pressed.commands).toEqual([]);

      session.pointerMove(drawing, { x: 150, y: 25 });
      const released = session.pointerUp(drawing, { x: 150, y: 25 });
      expect(released.commands).toEqual([
        {
          type: 'set-placement',
          instanceId: 'a',
          placement: { x: 0, y: 0, width: 100, height: 50, rotation: 90 },
        },
      ]);
    });

    it('snaps to 15 degree steps while Shift is held', () => {
      const session = new CanvasInteractionSession({ selection: ['a'] });
      session.pointerDown(drawing, { x: 50, y: -20 });
      const radians = (20 * Math.PI) / 180;
      session.pointerMove(drawing, {
        x: 50 + 100 * Math.cos(radians),
        y: 25 + 100 * Math.sin(radians),
        shiftKey: true,
      });
      expect(session.previews.get('a')?.rotation).toBe(105);
    });
  });

  describe('keyboard', () => {
    it('nudges the selection by 1 unit, or 10 with Shift', () => {
      const session = new CanvasInteractionSession({ selection: ['a'] });
      expect(session.keyDown(drawing, { key: 'ArrowRight' }).commands).toEqual([
        {
          type: 'set-placement',
          instanceId: 'a',
          placement: { x: 1, y: 0, width: 100, height: 50, rotation: 0 },
        },
      ]);
      expect(session.keyDown(drawing, { key: 'ArrowDown', shiftKey: true }).commands).toEqual([
        {
          type: 'set-placement',
          instanceId: 'a',
          placement: { x: 0, y: 10, width: 100, height: 50, rotation: 0 },
        },
      ]);
    });

    it('removes every selected instance with Delete', () => {
      const session = new CanvasInteractionSession({ selection: ['a', 'b'] });
      const result = session.keyDown(drawing, { key: 'Delete' });
      expect(result.commands).toEqual([
        { type: 'remove-instance', instanceId: 'a' },
        { type: 'remove-instance', instanceId: 'b' },
      ]);
      expect(result.selection).toEqual([]);
    });

    it('ignores unhandled keys', () => {
      const session = new CanvasInteractionSession({ selection: ['a'] });
      const result = session.keyDown(drawing, { key: 'Enter' });
      expect(result.commands).toEqual([]);
      expect(result.selection).toEqual(['a']);
    });
  });

  describe('viewport', () => {
    it('zooms around the pointer without producing commands', () => {
      const session = new CanvasInteractionSession();
      const anchor = { x: 120, y: 90 };
      const before = session.viewport;
      const zoomed = session.wheel({ ...anchor, deltaX: 0, deltaY: -200 });

      expect(zoomed.commands).toEqual([]);
      expect(zoomed.redraw).toBe(true);
      expect(session.viewport.scale).toBeGreaterThan(before.scale);
      const beforeAnchor = screenToDocument(before, anchor);
      const afterAnchor = screenToDocument(session.viewport, anchor);
      expect(afterAnchor.x).toBeCloseTo(beforeAnchor.x);
      expect(afterAnchor.y).toBeCloseTo(beforeAnchor.y);
    });

    it('pans horizontally with Shift + wheel', () => {
      const session = new CanvasInteractionSession();
      const panned = session.wheel({ x: 0, y: 0, deltaX: 0, deltaY: 40, shiftKey: true });
      expect(panned.commands).toEqual([]);
      expect(session.viewport).toEqual({ x: -40, y: 0, scale: 1 });
    });

    it('clamps the scale to the supported range', () => {
      const session = new CanvasInteractionSession();
      session.wheel({ x: 0, y: 0, deltaX: 0, deltaY: -100000 });
      expect(session.viewport.scale).toBe(MAX_VIEWPORT_SCALE);
      session.wheel({ x: 0, y: 0, deltaX: 0, deltaY: 100000 });
      expect(session.viewport.scale).toBe(MIN_VIEWPORT_SCALE);
    });

    it('pans with Space + drag or the middle button without touching the document', () => {
      const session = new CanvasInteractionSession();
      const pressed = session.pointerDown(drawing, { x: 10, y: 10, spaceKey: true });
      expect(session.interaction).toBe('panning');
      expect(pressed.selection).toEqual([]);

      const moved = session.pointerMove(drawing, { x: 40, y: 30 });
      expect(moved.commands).toEqual([]);
      expect(moved.viewport).toEqual({ x: 30, y: 20, scale: 1 });

      const released = session.pointerUp(drawing, { x: 40, y: 30 });
      expect(released.commands).toEqual([]);
      expect(released.selection).toEqual([]);

      session.pointerDown(drawing, { x: 0, y: 0, button: 1 });
      expect(session.interaction).toBe('panning');
    });
  });

  describe('run mode', () => {
    const running = canvasDocument(widget('a', { x: 100, y: 50 }));

    it('forwards instance-local pointer coordinates and never emits commands', () => {
      const session = new CanvasInteractionSession({ mode: 'run' });
      const pressed = session.pointerDown(running, { x: 150, y: 75 });

      expect(pressed.commands).toEqual([]);
      expect(pressed.selection).toEqual([]);
      expect(pressed.events).toHaveLength(1);
      expect(pressed.events[0]?.instanceId).toBe('a');
      expect(pressed.events[0]?.event).toMatchObject({
        type: 'pointerdown',
        x: 50,
        y: 25,
      });

      const moved = session.pointerMove(running, { x: 110, y: 60 });
      expect(moved.events[0]?.event).toMatchObject({ type: 'pointermove', x: 10, y: 10 });

      const released = session.pointerUp(running, { x: 110, y: 60 });
      expect(released.events[0]?.event.type).toBe('pointerup');
      expect(session.selection).toEqual([]);
    });

    it('removes the rotation from the forwarded coordinates', () => {
      const rotated = canvasDocument(widget('a', { x: 100, y: 50, rotation: 90 }));
      const session = new CanvasInteractionSession({ mode: 'run' });
      const pressed = session.pointerDown(rotated, { x: 150, y: 50 });

      expect(pressed.events[0]?.event.x).toBeCloseTo(25);
      expect(pressed.events[0]?.event.y).toBeCloseTo(25);
    });

    it('does not forward a pointer that missed every instance', () => {
      const session = new CanvasInteractionSession({ mode: 'run' });
      expect(session.pointerDown(running, { x: 10, y: 10 }).events).toEqual([]);
      expect(session.pointerMove(running, { x: 10, y: 10 }).events).toEqual([]);
    });

    it('forwards keyboard input to the last hit instance only', () => {
      const session = new CanvasInteractionSession({ mode: 'run' });
      expect(session.keyDown(running, { key: 'Enter', code: 'Enter' }).events).toEqual([]);

      session.pointerDown(running, { x: 150, y: 75 });
      const keyed = session.keyDown(running, { key: 'Enter', code: 'Enter' });
      expect(keyed.events[0]).toMatchObject({
        instanceId: 'a',
        event: { type: 'keydown', key: 'Enter', code: 'Enter' },
      });
      expect(session.keyUp(running, { key: 'Enter', code: 'Enter' }).events[0]?.event.type).toBe(
        'keyup',
      );
    });

    it('does not edit the document in run mode', () => {
      const session = new CanvasInteractionSession({ mode: 'run', selection: ['a'] });
      expect(session.keyDown(running, { key: 'Delete' }).commands).toEqual([]);
      expect(session.keyDown(running, { key: 'ArrowRight' }).commands).toEqual([]);
      expect(session.wheel({ x: 0, y: 0, deltaX: 0, deltaY: -100 }).commands).toEqual([]);
      expect(session.viewport.scale).toBe(1);
    });
  });
});
