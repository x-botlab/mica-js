import { describe, expect, it } from 'vitest';
import type { CanvasDocument, WidgetPlacement } from '../format/types';
import {
  ID_A,
  ID_B,
  ID_C,
  ID_D,
  applyCommand,
  makeDocument,
  makeInstance,
  rejectionCodes,
  widgetAt,
} from './test-helpers';

function ids(document: CanvasDocument): readonly string[] {
  return document.widgets.map((widget) => widget.id);
}

const PLACEMENT: WidgetPlacement = { x: 50, y: 60, width: 70, height: 80, rotation: 180 };

describe('add-instance', () => {
  it('inserts at the bottom, in the middle and on top', () => {
    const document = makeDocument();
    expect(
      ids(applyCommand(document, { type: 'add-instance', instance: makeInstance(), z: 0 })),
    ).toEqual([ID_D, ID_A, ID_B, ID_C]);
    expect(
      ids(applyCommand(document, { type: 'add-instance', instance: makeInstance(), z: 1 })),
    ).toEqual([ID_A, ID_D, ID_B, ID_C]);
    expect(
      ids(applyCommand(document, { type: 'add-instance', instance: makeInstance(), z: 3 })),
    ).toEqual([ID_A, ID_B, ID_C, ID_D]);
  });

  it('validates the instance like a parsed widget', () => {
    const document = makeDocument();
    const codesOfInstance = (overrides: Parameters<typeof makeInstance>[0]): readonly string[] =>
      rejectionCodes(document, { type: 'add-instance', instance: makeInstance(overrides), z: 0 });

    expect(codesOfInstance({ width: 0 })).toEqual(['schema/invalid-value']);
    expect(codesOfInstance({ height: -5 })).toEqual(['schema/invalid-value']);
    expect(codesOfInstance({ x: Number.NaN })).toEqual(['schema/invalid-value']);
    expect(codesOfInstance({ rotation: Number.POSITIVE_INFINITY })).toEqual([
      'schema/invalid-value',
    ]);
    expect(codesOfInstance({ widget: 'Image' })).toEqual(['schema/invalid-value']);
    expect(codesOfInstance({ id: 'not-a-uuid' })).toEqual(['schema/invalid-value']);
  });

  it('rejects a duplicate id', () => {
    expect(
      rejectionCodes(makeDocument(), {
        type: 'add-instance',
        instance: makeInstance({ id: ID_A }),
        z: 0,
      }),
    ).toEqual(['id/duplicate']);
  });

  it('rejects an out-of-range insertion index', () => {
    const document = makeDocument();
    for (const z of [-1, 4, 1.5, Number.NaN]) {
      expect(
        rejectionCodes(document, { type: 'add-instance', instance: makeInstance(), z }),
      ).toEqual(['edit/invalid-command']);
    }
  });

  it('reports the index and the instance problems in one error', () => {
    expect(
      rejectionCodes(makeDocument(), {
        type: 'add-instance',
        instance: makeInstance({ width: -1 }),
        z: 9,
      }),
    ).toEqual(['edit/invalid-command', 'schema/invalid-value']);
  });

  it('copies nested property maps instead of aliasing the command payload', () => {
    const instance = makeInstance({ properties: { text: 'hello' } });
    const result = applyCommand(makeDocument(), { type: 'add-instance', instance, z: 0 });
    expect(widgetAt(result, 0).properties).toEqual({ text: 'hello' });
    expect(widgetAt(result, 0).properties).not.toBe(instance.properties);
  });
});

describe('remove-instance', () => {
  it('removes the instance and keeps the drawing order of the rest', () => {
    const result = applyCommand(makeDocument(), { type: 'remove-instance', instanceId: ID_B });
    expect(ids(result)).toEqual([ID_A, ID_C]);
  });

  it('rejects an unknown instance', () => {
    expect(rejectionCodes(makeDocument(), { type: 'remove-instance', instanceId: ID_D })).toEqual([
      'edit/unknown-entity',
    ]);
  });
});

describe('set-placement', () => {
  it('replaces the geometry and keeps identity, widget, properties and bindings', () => {
    const document = makeDocument();
    const before = widgetAt(document, 0);
    const after = widgetAt(
      applyCommand(document, { type: 'set-placement', instanceId: ID_A, placement: PLACEMENT }),
      0,
    );
    expect(after).toEqual({ ...before, ...PLACEMENT });
    expect(after.properties).toBe(before.properties);
    expect(after.bindings).toBe(before.bindings);
  });

  it('rejects invalid geometry', () => {
    const document = makeDocument();
    const codesOfPlacement = (placement: WidgetPlacement): readonly string[] =>
      rejectionCodes(document, { type: 'set-placement', instanceId: ID_A, placement });

    expect(codesOfPlacement({ ...PLACEMENT, width: 0 })).toEqual(['schema/invalid-value']);
    expect(codesOfPlacement({ ...PLACEMENT, height: 0 })).toEqual(['schema/invalid-value']);
    expect(codesOfPlacement({ ...PLACEMENT, x: Number.NaN })).toEqual(['schema/invalid-value']);
    expect(codesOfPlacement({ ...PLACEMENT, rotation: Number.NEGATIVE_INFINITY })).toEqual([
      'schema/invalid-value',
    ]);
  });

  it('rejects an unknown instance', () => {
    expect(
      rejectionCodes(makeDocument(), {
        type: 'set-placement',
        instanceId: ID_D,
        placement: PLACEMENT,
      }),
    ).toEqual(['edit/unknown-entity']);
  });
});

describe('set-z', () => {
  it('moves an instance toward the front and the back', () => {
    const document = makeDocument();
    expect(ids(applyCommand(document, { type: 'set-z', instanceId: ID_A, z: 2 }))).toEqual([
      ID_B,
      ID_C,
      ID_A,
    ]);
    expect(ids(applyCommand(document, { type: 'set-z', instanceId: ID_C, z: 0 }))).toEqual([
      ID_C,
      ID_A,
      ID_B,
    ]);
    expect(ids(applyCommand(document, { type: 'set-z', instanceId: ID_A, z: 1 }))).toEqual([
      ID_B,
      ID_A,
      ID_C,
    ]);
  });

  it('accepts the first, the last and the current position', () => {
    const document = makeDocument();
    expect(ids(applyCommand(document, { type: 'set-z', instanceId: ID_B, z: 0 }))).toEqual([
      ID_B,
      ID_A,
      ID_C,
    ]);
    expect(ids(applyCommand(document, { type: 'set-z', instanceId: ID_B, z: 2 }))).toEqual([
      ID_A,
      ID_C,
      ID_B,
    ]);
    expect(ids(applyCommand(document, { type: 'set-z', instanceId: ID_B, z: 1 }))).toEqual([
      ID_A,
      ID_B,
      ID_C,
    ]);
  });

  it('rejects an out-of-range index', () => {
    const document = makeDocument();
    for (const z of [-1, 3, 0.5]) {
      expect(rejectionCodes(document, { type: 'set-z', instanceId: ID_A, z })).toEqual([
        'edit/invalid-command',
      ]);
    }
  });

  it('rejects an unknown instance', () => {
    expect(rejectionCodes(makeDocument(), { type: 'set-z', instanceId: ID_D, z: 0 })).toEqual([
      'edit/unknown-entity',
    ]);
  });
});
