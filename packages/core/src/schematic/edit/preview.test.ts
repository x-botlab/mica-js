import { describe, expect, it } from 'vitest';
import type { DeviceSymbolProvider } from '../device/symbol';
import type { SchematicDocument } from '../../format/types';
import { previewSymbolDrag } from './preview';

const devices: DeviceSymbolProvider = {
  getDeviceSymbol: () => ({
    name: 'U',
    pins: { p1: { x: 0, y: 0 }, p2: { x: 20, y: 0 } },
  }),
  getDeviceName: () => 'U',
};

function makeDocument(): SchematicDocument {
  return {
    version: 1,
    sheet: {
      symbols: [
        { id: '00000003-41e6-4a4c-869a-82a4cd304787', device: 'pkg:a', x: 0, y: 0, rotation: 0 },
      ],
      wires: [
        {
          id: '00000005-9cf4-407f-8900-09a16d33a38c',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 20 },
          ],
        },
        {
          id: '00000006-a914-47d5-84d1-8bafbe533ffb',
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 10 },
          ],
        },
      ],
      junctions: [
        {
          id: '00000001-516c-48ac-8128-07f98c98ee13',
          x: 10,
          y: 10,
          wires: ['00000005-9cf4-407f-8900-09a16d33a38c', '00000006-a914-47d5-84d1-8bafbe533ffb'],
        },
      ],
    },
  };
}

describe('previewSymbolDrag', () => {
  it('moves the wire endpoint attached to a moving pin', () => {
    const preview = previewSymbolDrag(
      makeDocument(),
      devices,
      '00000003-41e6-4a4c-869a-82a4cd304787',
      { x: 0, y: -5, rotation: 0 },
    );
    expect(preview?.wires.get('00000005-9cf4-407f-8900-09a16d33a38c')).toEqual([
      { x: 0, y: -5 },
      { x: 10, y: -5 },
      { x: 10, y: 20 },
    ]);
  });

  it('leaves a junction alone while it still lies on the rerouted wire', () => {
    const preview = previewSymbolDrag(
      makeDocument(),
      devices,
      '00000003-41e6-4a4c-869a-82a4cd304787',
      { x: 0, y: -5, rotation: 0 },
    );
    expect(preview?.junctions.has('00000001-516c-48ac-8128-07f98c98ee13')).toBe(false);
  });

  it('projects a detached junction onto the rerouted wire', () => {
    const document = makeDocument();
    const sheet = {
      ...document.sheet,
      wires: [
        {
          id: '00000005-9cf4-407f-8900-09a16d33a38c',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          id: '00000006-a914-47d5-84d1-8bafbe533ffb',
          points: [
            { x: 5, y: 0 },
            { x: 5, y: 10 },
          ],
        },
      ],
      junctions: [
        {
          id: '00000001-516c-48ac-8128-07f98c98ee13',
          x: 5,
          y: 0,
          wires: ['00000005-9cf4-407f-8900-09a16d33a38c', '00000006-a914-47d5-84d1-8bafbe533ffb'],
        },
      ],
    };
    const preview = previewSymbolDrag(
      { ...document, sheet },
      devices,
      '00000003-41e6-4a4c-869a-82a4cd304787',
      {
        x: 0,
        y: -5,
        rotation: 0,
      },
    );
    expect(preview?.junctions.get('00000001-516c-48ac-8128-07f98c98ee13')).toEqual({ x: 5, y: -5 });
  });

  it('carries anchors sitting on a moving pin', () => {
    const document = makeDocument();
    const sheet = {
      ...document.sheet,
      symbols: [
        ...document.sheet.symbols,
        {
          id: '00000002-58c8-4974-8943-b00f84be79fc',
          device: 'builtin:label',
          x: 0,
          y: 0,
          rotation: 0,
        },
      ],
    };
    const preview = previewSymbolDrag(
      { ...document, sheet },
      devices,
      '00000003-41e6-4a4c-869a-82a4cd304787',
      {
        x: 4,
        y: 6,
        rotation: 0,
      },
    );
    expect(preview?.symbols.get('00000002-58c8-4974-8943-b00f84be79fc')).toEqual({ x: 4, y: 6 });
  });

  it('drag the wire end attached to a moving net label', () => {
    const document = makeDocument();
    const sheet = {
      ...document.sheet,
      symbols: [
        {
          id: '00000002-58c8-4974-8943-b00f84be79fc',
          device: 'builtin:label',
          net: 'D0',
          x: 0,
          y: 0,
          rotation: 0,
        },
      ],
      wires: [
        {
          id: '00000005-9cf4-407f-8900-09a16d33a38c',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
      ],
      junctions: [],
    };
    const drag = (to: { x: number; y: number }) =>
      previewSymbolDrag({ ...document, sheet }, devices, '00000002-58c8-4974-8943-b00f84be79fc', {
        ...to,
        rotation: 0,
      })?.wires.get('00000005-9cf4-407f-8900-09a16d33a38c');

    // Along the wire: only the length changes.
    expect(drag({ x: -5, y: 0 })).toEqual([
      { x: -5, y: 0 },
      { x: 10, y: 0 },
    ]);
    // Perpendicular: the original run stays and a new segment is folded in at the label.
    expect(drag({ x: 0, y: -5 })).toEqual([
      { x: 0, y: -5 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    // Diagonal: one elbow connects the label to the original anchor.
    expect(drag({ x: -5, y: -5 })).toEqual([
      { x: -5, y: -5 },
      { x: 0, y: -5 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('leaves wires alone when a text symbol moves', () => {
    const document = makeDocument();
    const sheet = {
      ...document.sheet,
      symbols: [
        {
          id: '00000004-bd69-4fdd-8b46-5dad176ff52d',
          device: 'builtin:text',
          x: 0,
          y: 0,
          rotation: 0,
        },
      ],
      wires: [
        {
          id: '00000005-9cf4-407f-8900-09a16d33a38c',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
      ],
      junctions: [],
    };
    const preview = previewSymbolDrag(
      { ...document, sheet },
      devices,
      '00000004-bd69-4fdd-8b46-5dad176ff52d',
      {
        x: 0,
        y: -5,
        rotation: 0,
      },
    );
    expect(preview?.wires.size).toBe(0);
  });

  it('returns an empty preview when nothing moves', () => {
    const preview = previewSymbolDrag(
      makeDocument(),
      devices,
      '00000003-41e6-4a4c-869a-82a4cd304787',
      { x: 0, y: 0, rotation: 0 },
    );
    expect(preview?.wires.size).toBe(0);
    expect(preview?.junctions.size).toBe(0);
    expect(preview?.symbols.size).toBe(0);
  });

  it('returns undefined for unknown symbols', () => {
    expect(
      previewSymbolDrag(makeDocument(), devices, 'nope', { x: 0, y: 0, rotation: 0 }),
    ).toBeUndefined();
  });
});
