import { describe, expect, it } from 'vitest';
import type { SchematicWire } from '../../format/types';
import { stretchWireEndpoint } from './reroute';

function makeWire(points: readonly { x: number; y: number }[]): SchematicWire {
  return { id: 'w1', points };
}

describe('stretchWireEndpoint', () => {
  it('only changes the length when the move follows the segment', () => {
    const wire = makeWire([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ]);
    expect(stretchWireEndpoint(wire, { x: 10, y: 20 }, { x: 10, y: 30 })?.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 30 },
    ]);
  });

  it('folds in one perpendicular segment instead of moving the run', () => {
    const wire = makeWire([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ]);
    expect(stretchWireEndpoint(wire, { x: 10, y: 20 }, { x: 20, y: 20 })?.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 20 },
      { x: 20, y: 20 },
    ]);
  });

  it('adds an elbow for a diagonal move', () => {
    const wire = makeWire([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(stretchWireEndpoint(wire, { x: 10, y: 0 }, { x: 20, y: 5 })?.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 5 },
    ]);
  });

  it('handles a first-point anchor', () => {
    const wire = makeWire([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(stretchWireEndpoint(wire, { x: 0, y: 0 }, { x: 0, y: 5 })?.points).toEqual([
      { x: 0, y: 5 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('follows a vertical segment with a horizontal fold', () => {
    const wire = makeWire([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]);
    expect(stretchWireEndpoint(wire, { x: 0, y: 10 }, { x: 5, y: 10 })?.points).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 5, y: 10 },
    ]);
  });

  it('ignores points that are not endpoints', () => {
    const wire = makeWire([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ]);
    expect(stretchWireEndpoint(wire, { x: 10, y: 0 }, { x: 10, y: 5 })).toBeUndefined();
  });
});
