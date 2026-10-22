import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from '../format/types';
import { CANVAS_VERSION } from '../format/types';
import {
  ID_A,
  ID_B,
  ID_D,
  SYMBOL_ID,
  applyCommand,
  makeDocument,
  rejectionCodes,
  widgetAt,
} from './test-helpers';

describe('set-binding', () => {
  it('adds a binding', () => {
    const result = applyCommand(makeDocument(), {
      type: 'set-binding',
      instanceId: ID_B,
      port: 'value',
      target: { symbol: SYMBOL_ID, port: 'segments' },
    });
    expect(widgetAt(result, 1).bindings).toEqual({
      value: { symbol: SYMBOL_ID, port: 'segments' },
    });
  });

  it('overwrites an existing binding', () => {
    const result = applyCommand(makeDocument(), {
      type: 'set-binding',
      instanceId: ID_A,
      port: 'value',
      target: { symbol: SYMBOL_ID, port: 'digits' },
    });
    expect(widgetAt(result, 0).bindings).toEqual({ value: { symbol: SYMBOL_ID, port: 'digits' } });
  });

  it('unbinds with a null target', () => {
    const document = makeDocument();
    const before = widgetAt(document, 0);
    const result = applyCommand(document, {
      type: 'set-binding',
      instanceId: ID_A,
      port: 'value',
      target: null,
    });
    expect(widgetAt(result, 0).bindings).toEqual({});
    expect(widgetAt(result, 0).bindings).not.toBe(before.bindings);
    expect(widgetAt(document, 0).bindings).toEqual({
      value: { symbol: SYMBOL_ID, port: 'segments' },
    });
  });

  it('accepts unbinding a port that is not bound', () => {
    const result = applyCommand(makeDocument(), {
      type: 'set-binding',
      instanceId: ID_B,
      port: 'value',
      target: null,
    });
    expect(widgetAt(result, 1).bindings).toEqual({});
  });

  it('rejects an empty port key', () => {
    expect(
      rejectionCodes(makeDocument(), {
        type: 'set-binding',
        instanceId: ID_A,
        port: '',
        target: { symbol: SYMBOL_ID, port: 'segments' },
      }),
    ).toEqual(['schema/invalid-value']);
  });

  it('rejects a malformed target without resolving the schematic', () => {
    expect(
      rejectionCodes(makeDocument(), {
        type: 'set-binding',
        instanceId: ID_A,
        port: 'value',
        target: { symbol: '', port: 'segments' },
      }),
    ).toEqual(['schema/invalid-value']);
  });

  it('rejects an unknown instance', () => {
    expect(
      rejectionCodes(makeDocument(), {
        type: 'set-binding',
        instanceId: ID_D,
        port: 'value',
        target: { symbol: SYMBOL_ID, port: 'segments' },
      }),
    ).toEqual(['edit/unknown-entity']);
  });
});

describe('set-schematic', () => {
  it('replaces the bound schematic path', () => {
    const result = applyCommand(makeDocument(), {
      type: 'set-schematic',
      schematic: 'boards/other.sch',
    });
    expect(result.schematic).toBe('boards/other.sch');
  });

  it('adds the field to a document without a schematic', () => {
    const document: CanvasDocument = { version: CANVAS_VERSION, widgets: makeDocument().widgets };
    const result = applyCommand(document, { type: 'set-schematic', schematic: 'boards/new.sch' });
    expect(result.schematic).toBe('boards/new.sch');
  });

  it('clears the field with null', () => {
    const document = makeDocument();
    const result = applyCommand(document, { type: 'set-schematic', schematic: null });
    expect(result).toEqual({ version: CANVAS_VERSION, widgets: document.widgets });
    expect('schematic' in result).toBe(false);
  });

  it('rejects an empty path', () => {
    expect(rejectionCodes(makeDocument(), { type: 'set-schematic', schematic: '' })).toEqual([
      'schema/invalid-value',
    ]);
  });
});
