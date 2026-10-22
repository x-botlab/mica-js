import { describe, expect, it } from 'vitest';
import { SchematicEditor } from './editor';
import type { SchematicDocument } from '../../format/types';
import { catchError } from '../../format/test-helpers';
import { parseSchematic } from '../format/parse-schematic';

function makeDocument(): SchematicDocument {
  return {
    version: 1,
    sheet: {
      symbols: [{ id: 's1', device: 'pkg:a', x: 0, y: 0, rotation: 0 }],
      wires: [
        {
          id: 'w1',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
      ],
      junctions: [],
    },
  };
}

describe('SchematicEditor', () => {
  it('tracks undo and redo', () => {
    const editor = new SchematicEditor(makeDocument());
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(false);

    editor.dispatch({
      type: 'add-wire',
      points: [
        { x: 0, y: 5 },
        { x: 5, y: 5 },
      ],
    });
    expect(editor.document.sheet.wires).toHaveLength(2);
    expect(editor.canUndo).toBe(true);

    editor.undo();
    expect(editor.document.sheet.wires).toHaveLength(1);
    expect(editor.canRedo).toBe(true);

    editor.redo();
    expect(editor.document.sheet.wires).toHaveLength(2);
  });

  it('leaves state and history untouched when a command fails', () => {
    const editor = new SchematicEditor(makeDocument());
    const before = editor.document;
    catchError(() => editor.dispatch({ type: 'remove-wire', id: 'missing' }));
    expect(editor.document).toBe(before);
    expect(editor.canUndo).toBe(false);
  });

  it('discards the redo stack after a new edit', () => {
    const editor = new SchematicEditor(makeDocument());
    editor.dispatch({ type: 'add-symbol', device: 'pkg:b', x: 1, y: 1 });
    editor.undo();
    expect(editor.canRedo).toBe(true);
    editor.dispatch({ type: 'add-symbol', device: 'pkg:c', x: 2, y: 2 });
    expect(editor.canRedo).toBe(false);
  });

  it('applies transactions atomically', () => {
    const editor = new SchematicEditor(makeDocument());
    editor.transaction((draft) => {
      draft.dispatch({
        type: 'add-wire',
        points: [
          { x: 0, y: 5 },
          { x: 5, y: 5 },
        ],
      });
      draft.dispatch({
        type: 'add-wire',
        points: [
          { x: 0, y: 6 },
          { x: 5, y: 6 },
        ],
      });
    });
    expect(editor.document.sheet.wires).toHaveLength(3);
    editor.undo();
    expect(editor.document.sheet.wires).toHaveLength(1);
  });

  it('rolls back a failing transaction', () => {
    const editor = new SchematicEditor(makeDocument());
    const before = editor.document;
    catchError(() =>
      editor.transaction((draft) => {
        draft.dispatch({
          type: 'add-wire',
          points: [
            { x: 0, y: 5 },
            { x: 5, y: 5 },
          ],
        });
        draft.dispatch({ type: 'remove-wire', id: 'missing' });
      }),
    );
    expect(editor.document).toBe(before);
    expect(editor.canUndo).toBe(false);
  });

  it('honours the history limit', () => {
    const editor = new SchematicEditor(makeDocument(), { historyLimit: 2 });
    for (let index = 0; index < 5; index += 1) {
      editor.dispatch({
        type: 'add-wire',
        points: [
          { x: 0, y: index },
          { x: 1, y: index },
        ],
      });
    }
    editor.undo();
    editor.undo();
    editor.undo();
    expect(editor.canUndo).toBe(false);
    expect(editor.document.sheet.wires).toHaveLength(4);
  });

  it('derives topology and serializes the document', () => {
    const editor = new SchematicEditor(makeDocument());
    expect(editor.topology().danglingWireEnds).toHaveLength(2);
    expect(parseSchematic(editor.toJSON())).toEqual(editor.document);
  });

  it('drops junctions that no longer sit on their wires when replacing the document', () => {
    const document = makeDocument();
    const editor = new SchematicEditor({
      ...document,
      sheet: {
        ...document.sheet,
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
            ],
          },
          {
            id: 'w2',
            points: [
              { x: 5, y: 0 },
              { x: 5, y: 10 },
            ],
          },
        ],
        junctions: [{ id: 'j1', x: 5, y: 0, wires: ['w1', 'w2'] }],
      },
    });
    expect(editor.document.sheet.junctions).toHaveLength(1);

    editor.replace({
      ...document,
      sheet: {
        ...editor.document.sheet,
        junctions: [{ id: 'j1', x: 5, y: 5, wires: ['w1', 'w2'] }],
      },
    });
    expect(editor.document.sheet.junctions).toEqual([]);
  });
});
