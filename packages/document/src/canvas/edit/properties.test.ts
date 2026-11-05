import { describe, expect, it } from 'vitest';
import {
  ID_A,
  ID_B,
  ID_D,
  applyCommand,
  makeDocument,
  rejectionCodes,
  widgetAt,
} from './test-helpers';

describe('set-property', () => {
  it('adds a property without touching the original map', () => {
    const document = makeDocument();
    const before = widgetAt(document, 0);
    const result = applyCommand(document, {
      type: 'set-property',
      instanceId: ID_A,
      key: 'label',
      value: 'hello',
    });
    expect(widgetAt(result, 0).properties).toEqual({ image: 'board.webp', label: 'hello' });
    expect(widgetAt(result, 0).properties).not.toBe(before.properties);
    expect(before.properties).toEqual({ image: 'board.webp' });
  });

  it('overwrites an existing property', () => {
    const result = applyCommand(makeDocument(), {
      type: 'set-property',
      instanceId: ID_A,
      key: 'image',
      value: 'other.webp',
    });
    expect(widgetAt(result, 0).properties).toEqual({ image: 'other.webp' });
  });

  it('accepts null values', () => {
    const result = applyCommand(makeDocument(), {
      type: 'set-property',
      instanceId: ID_A,
      key: 'label',
      value: null,
    });
    expect(widgetAt(result, 0).properties).toEqual({ image: 'board.webp', label: null });
  });

  it('creates the property map on an instance without one', () => {
    const result = applyCommand(makeDocument(), {
      type: 'set-property',
      instanceId: ID_B,
      key: 'brightness',
      value: 3,
    });
    expect(widgetAt(result, 1).properties).toEqual({ brightness: 3 });
  });

  it('copies object values so later mutation of the argument cannot change the document', () => {
    const value = { nested: { a: 1 } };
    const result = applyCommand(makeDocument(), {
      type: 'set-property',
      instanceId: ID_A,
      key: 'layout',
      value,
    });
    expect(widgetAt(result, 0).properties).toEqual({ image: 'board.webp', layout: value });
    expect(widgetAt(result, 0).properties?.['layout']).not.toBe(value);

    value.nested.a = 999;
    expect(widgetAt(result, 0).properties).toEqual({
      image: 'board.webp',
      layout: { nested: { a: 1 } },
    });
  });

  it('copies array values so later mutation of the argument cannot change the document', () => {
    const value = [{ b: 2 }, 3];
    const result = applyCommand(makeDocument(), {
      type: 'set-property',
      instanceId: ID_B,
      key: 'items',
      value,
    });
    expect(widgetAt(result, 1).properties).toEqual({ items: [{ b: 2 }, 3] });
    expect(widgetAt(result, 1).properties?.['items']).not.toBe(value);

    value[0] = { b: 999 };
    value.push(4);
    expect(widgetAt(result, 1).properties).toEqual({ items: [{ b: 2 }, 3] });
  });

  it('stores primitive values as-is', () => {
    const document = makeDocument();
    const cases: readonly (readonly [string, unknown])[] = [
      ['number', 42],
      ['string', 'hello'],
      ['boolean', false],
      ['null', null],
    ];
    let result = document;
    for (const [key, value] of cases) {
      result = applyCommand(result, {
        type: 'set-property',
        instanceId: ID_B,
        key,
        value,
      });
    }
    expect(widgetAt(result, 1).properties).toEqual({
      number: 42,
      string: 'hello',
      boolean: false,
      null: null,
    });
  });

  it('leaves the other instances untouched', () => {
    const document = makeDocument();
    const result = applyCommand(document, {
      type: 'set-property',
      instanceId: ID_A,
      key: 'label',
      value: 'hello',
    });
    expect(widgetAt(result, 1)).toBe(widgetAt(document, 1));
    expect(widgetAt(result, 2)).toBe(widgetAt(document, 2));
  });

  it('rejects an unknown instance', () => {
    expect(
      rejectionCodes(makeDocument(), {
        type: 'set-property',
        instanceId: ID_D,
        key: 'label',
        value: 1,
      }),
    ).toEqual(['edit/unknown-entity']);
  });

  it('rejects an empty key', () => {
    expect(
      rejectionCodes(makeDocument(), {
        type: 'set-property',
        instanceId: ID_A,
        key: '',
        value: 1,
      }),
    ).toEqual(['schema/invalid-value']);
  });
});

describe('unset-property', () => {
  it('removes the property key', () => {
    const document = makeDocument();
    const result = applyCommand(document, {
      type: 'unset-property',
      instanceId: ID_A,
      key: 'image',
    });
    expect(widgetAt(result, 0).properties).toEqual({});
    expect(widgetAt(document, 0).properties).toEqual({ image: 'board.webp' });
  });

  it('rejects a key the instance does not have', () => {
    expect(
      rejectionCodes(makeDocument(), { type: 'unset-property', instanceId: ID_A, key: 'label' }),
    ).toEqual(['edit/unknown-entity']);
  });

  it('rejects a key on an instance without properties', () => {
    expect(
      rejectionCodes(makeDocument(), { type: 'unset-property', instanceId: ID_B, key: 'image' }),
    ).toEqual(['edit/unknown-entity']);
  });

  it('rejects an unknown instance', () => {
    expect(
      rejectionCodes(makeDocument(), { type: 'unset-property', instanceId: ID_D, key: 'image' }),
    ).toEqual(['edit/unknown-entity']);
  });
});
