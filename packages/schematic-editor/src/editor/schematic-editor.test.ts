import { afterEach, describe, expect, it } from 'vitest';
import { parseSchematic, SchematicError, type SchematicDocument } from '@mica-js/core/schematic';
import { createSchematicEditor, DocumentModel, DEFAULT_DISPLAY_OPTIONS } from '../index';
import {
  createContainer,
  devices,
  documentOf,
  documentWithSymbol,
  installDomGlobals,
  symbolId,
  type FakeElement,
} from './test-helpers';

let restoreDom: (() => void) | undefined;

function editorFor(document = documentWithSymbol(), options: { readonly readOnly?: boolean } = {}) {
  restoreDom = installDomGlobals();
  const host = createContainer();
  const model = new DocumentModel({ value: document, devices });
  const editor = createSchematicEditor({
    container: host.container,
    model,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  return { editor, model, container: host.container, document: host.document };
}

afterEach(() => {
  restoreDom?.();
  restoreDom = undefined;
});

describe('SchematicEditor', () => {
  it('mounts over the model and exposes its content', () => {
    const { editor, model, container } = editorFor();

    expect(editor.getModel()).toBe(model);
    expect(editor.getValue()).toBe(model.getValue());
    expect(editor.getState().document).toBe(model.getValue());
    expect(editor.getSelection()).toEqual([]);
    expect(editor.getTool()).toBe('select');
    expect(container.children).toHaveLength(1);

    editor.dispose();
    expect(container.children).toHaveLength(0);
  });

  it('builds its own model from value or from an empty sheet', () => {
    restoreDom = installDomGlobals();
    const host = createContainer();
    const document = documentWithSymbol();

    const fromDocument = createSchematicEditor({
      container: host.container,
      value: document,
      devices,
    });
    expect(fromDocument.getValue()).toBe(document);
    expect(fromDocument.getModel().getDevices()).toBe(devices);
    fromDocument.dispose();

    const fromText = createSchematicEditor({
      container: host.container,
      value: JSON.stringify(document),
      devices,
    });
    expect(fromText.getValue()).toEqual(document);
    fromText.dispose();

    const empty = createSchematicEditor({ container: host.container, devices });
    expect(empty.getValue().sheet).toEqual({ symbols: [], wires: [], junctions: [] });
    empty.dispose();
  });

  it('prefers an explicit model over value', () => {
    restoreDom = installDomGlobals();
    const host = createContainer();
    const model = new DocumentModel({ value: documentOf({}), devices });
    const editor = createSchematicEditor({
      container: host.container,
      model,
      value: documentWithSymbol(),
    });

    expect(editor.getModel()).toBe(model);
    expect(editor.getValue().sheet.symbols).toEqual([]);
    editor.dispose();
  });

  it('disposes the model it created, but not one the host passed in', () => {
    restoreDom = installDomGlobals();
    const host = createContainer();

    const owned = createSchematicEditor({ container: host.container, devices });
    const ownedModel = owned.getModel();
    const ownedDocuments: SchematicDocument[] = [];
    ownedModel.onDidChangeContent((document) => ownedDocuments.push(document));
    owned.dispose();
    ownedModel.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 0, y: 0 });
    expect(ownedDocuments).toEqual([]);

    const model = new DocumentModel({ value: documentOf({}), devices });
    const documents: SchematicDocument[] = [];
    model.onDidChangeContent((document) => documents.push(document));
    const editor = createSchematicEditor({ container: host.container, model });
    editor.dispose();
    model.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 0, y: 0 });
    expect(documents).toHaveLength(1);
  });

  it('fires onDidChangeContent once per committed edit', () => {
    const { editor } = editorFor();
    const documents: SchematicDocument[] = [];
    const errors: (SchematicError | undefined)[] = [];
    editor.onDidChangeContent((document) => documents.push(document));
    editor.onDidChangeError((error) => errors.push(error));

    editor.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 10, y: 0 });
    expect(documents).toHaveLength(1);
    expect(documents[0]?.sheet.symbols).toHaveLength(2);

    expect(() => editor.applyCommand({ type: 'remove-symbol', id: 'missing' })).toThrow(
      SchematicError,
    );
    expect(documents).toHaveLength(1);
    expect(errors.at(-1)?.message).toContain('Unknown symbol');

    editor.undo();
    expect(documents).toHaveLength(2);
    editor.dispose();
  });

  it('drops selection targets the document does not contain', () => {
    const { editor } = editorFor();
    const selection = [
      { kind: 'symbol' as const, id: symbolId },
      { kind: 'symbol' as const, id: 'missing' },
    ];
    editor.setSelection(selection);
    expect(editor.getSelection()).toEqual([{ kind: 'symbol', id: symbolId }]);

    editor.applyCommand({ type: 'remove-symbol', id: symbolId });
    expect(editor.getSelection()).toEqual([]);
    editor.dispose();
  });

  it('reports selection changes and prunes them after a delete', () => {
    const selections: unknown[] = [];
    restoreDom = installDomGlobals();
    const host = createContainer();
    const model = new DocumentModel({ value: documentWithSymbol(), devices });
    const editor = createSchematicEditor({ container: host.container, model });
    editor.onDidChangeSelection((selection) => selections.push(selection));

    editor.setSelection([{ kind: 'symbol', id: symbolId }]);
    expect(selections).toEqual([[{ kind: 'symbol', id: symbolId }]]);

    editor.deleteSelection();
    expect(selections).toEqual([[{ kind: 'symbol', id: symbolId }], []]);
    expect(editor.getValue().sheet.symbols).toEqual([]);
    editor.dispose();
  });

  it('arms and cancels device placement, and rejects malformed references', () => {
    const errors: (SchematicError | undefined)[] = [];
    restoreDom = installDomGlobals();
    const host = createContainer();
    const model = new DocumentModel({ value: documentOf({}), devices });
    const editor = createSchematicEditor({ container: host.container, model });
    editor.onDidChangeError((error) => errors.push(error));

    editor.setTool('wire');
    editor.placeDevice('pkg:mcu');
    expect(editor.getPlacingDevice()).toBe('pkg:mcu');
    expect(editor.getTool()).toBe('select');

    editor.cancelPlacement();
    expect(editor.getPlacingDevice()).toBeUndefined();

    editor.placeDevice('pkg:mcu');
    editor.setTool('wire');
    expect(editor.getPlacingDevice()).toBeUndefined();
    expect(editor.getTool()).toBe('wire');

    expect(() => editor.placeDevice('nonsense')).toThrow(SchematicError);
    expect(editor.getState().lastError?.message).toContain('Invalid device reference');
    expect(errors.at(-1)?.message).toContain('Invalid device reference');
    expect(editor.getPlacingDevice()).toBeUndefined();
    editor.dispose();
  });

  it('ignores placement in read-only editors', () => {
    const { editor } = editorFor(documentOf({}), { readOnly: true });
    editor.placeDevice('pkg:mcu');
    expect(editor.getPlacingDevice()).toBeUndefined();
    editor.dispose();
  });

  it('applies display options without touching history', () => {
    const { editor } = editorFor();
    editor.setDisplayOptions({ snap: false, gridSize: 20, gridSubdivisions: 4 });
    expect(editor.getState().display).toEqual({
      ...DEFAULT_DISPLAY_OPTIONS,
      snap: false,
      gridSize: 20,
      gridSubdivisions: 4,
    });
    expect(editor.getCanUndo()).toBe(false);
    editor.dispose();
  });

  it('edits the document through the model and reports committed changes', () => {
    const states: unknown[] = [];
    restoreDom = installDomGlobals();
    const host = createContainer();
    const model = new DocumentModel({ value: documentWithSymbol(), devices });
    const editor = createSchematicEditor({ container: host.container, model });
    editor.onDidChangeState((state) => states.push(state));

    editor.setSelection([{ kind: 'symbol', id: symbolId }]);
    editor.moveSelectionBy(10, 20);
    expect(editor.getValue().sheet.symbols[0]).toMatchObject({ x: 10, y: 20 });
    expect(editor.getCanUndo()).toBe(true);
    expect(model.getCanUndo()).toBe(true);

    editor.undo();
    expect(editor.getValue().sheet.symbols[0]).toMatchObject({ x: 0, y: 0 });
    expect(states.length).toBeGreaterThanOrEqual(3);
    editor.dispose();
  });

  it('builds the inspector for the current selection', () => {
    const wireId = '00000006-9cf4-407f-8900-09a16d33a38c';
    const { editor } = editorFor(
      documentOf({
        symbols: [
          {
            id: symbolId,
            device: 'pkg:mcu',
            x: 4,
            y: 6,
            rotation: 90,
            properties: { label: 'CPU' },
          },
        ],
        wires: [
          {
            id: wireId,
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
          },
        ],
      }),
    );

    editor.setSelection([{ kind: 'symbol', id: symbolId }]);
    const symbol = editor.getState().inspector;
    expect(symbol?.kind).toBe('symbol');
    if (symbol?.kind !== 'symbol') {
      throw new Error('expected a symbol inspector');
    }
    expect(symbol.name).toBe('MCU');
    expect(symbol.properties).toEqual([
      { key: 'label', type: 'string', defaultValue: 'U1', value: 'CPU' },
      { key: 'speed', type: 'number', defaultValue: 72, min: 1, max: 170, unit: 'MHz' },
    ]);

    editor.setSelection([{ kind: 'wire', id: wireId }]);
    expect(editor.getState().inspector).toMatchObject({ kind: 'wire', id: wireId });

    editor.setSelection([]);
    expect(editor.getState().inspector).toBeUndefined();
    editor.dispose();
  });

  it('replaces the content, clearing selection and history by default', () => {
    const next = documentOf({
      symbols: [
        {
          id: '00000004-dfe1-4ed9-83d0-30ddf7887781',
          device: 'pkg:mcu',
          x: 50,
          y: 0,
          rotation: 0,
        },
      ],
    });
    const { editor } = editorFor();
    editor.setSelection([{ kind: 'symbol', id: symbolId }]);
    editor.moveSelectionBy(10, 0);
    expect(editor.getCanUndo()).toBe(true);

    editor.setValue(next);
    expect(editor.getValue()).toBe(next);
    expect(editor.getSelection()).toEqual([]);
    expect(editor.getCanUndo()).toBe(false);
    expect(editor.getState().document).toBe(next);

    editor.setValue(JSON.stringify(next));
    expect(editor.getValue()).toEqual(next);
    expect(() => editor.setValue('{"version":2}')).toThrow(SchematicError);
    expect(editor.getValue()).toEqual(next);
    editor.dispose();
  });

  it('keeps history when setValue is asked to', () => {
    const next = documentOf({
      symbols: [
        {
          id: '00000004-dfe1-4ed9-83d0-30ddf7887781',
          device: 'pkg:mcu',
          x: 50,
          y: 0,
          rotation: 0,
        },
      ],
    });
    const { editor } = editorFor();
    editor.setValue(next, { keepHistory: true });
    expect(editor.getCanUndo()).toBe(true);
    editor.undo();
    expect(editor.getValue().sheet.symbols[0]?.id).toBe(symbolId);
    editor.dispose();
  });

  it('notifies the model about document commands and reports viewport changes', () => {
    const viewports: unknown[] = [];
    restoreDom = installDomGlobals();
    const host = createContainer();
    const model = new DocumentModel({ value: documentOf({}), devices });
    const editor = createSchematicEditor({ container: host.container, model });
    editor.onDidChangeViewport((viewport) => viewports.push(viewport));

    editor.applyCommand({ type: 'add-symbol', device: 'pkg:mcu', x: 0, y: 0 });
    expect(editor.getValue().sheet.symbols).toHaveLength(1);
    expect(editor.getTopology().pins.length).toBeGreaterThan(0);
    expect(JSON.parse(editor.toJSON()).sheet.symbols).toHaveLength(1);
    expect(editor.hitTest({ x: 0, y: 0 })?.kind).toBe('symbol');

    editor.zoomTo(2);
    expect(editor.getViewport().scale).toBeCloseTo(2, 9);
    expect(viewports.length).toBeGreaterThan(0);
    editor.dispose();
  });

  it('stops reacting to the model after dispose', () => {
    const { editor, container } = editorFor();
    editor.dispose();
    editor.dispose();
    expect(container.children).toHaveLength(0);

    // A disposed editor drops API calls instead of touching the model.
    editor.setSelection([{ kind: 'symbol', id: symbolId }]);
    editor.applyCommand({ type: 'remove-symbol', id: symbolId });
    editor.undo();
    expect(editor.getSelection()).toEqual([]);
  });

  it('surfaces model edit errors in the editor state', () => {
    const { editor, model } = editorFor();
    expect(() => model.setSymbolProperty(symbolId, 'speed', 999)).toThrow(SchematicError);
    expect(editor.getState().lastError?.message).toContain('at most 170');

    model.setSymbolProperty(symbolId, 'speed', 100);
    expect(editor.getState().lastError).toBeUndefined();
    expect(editor.getValue().sheet.symbols[0]?.properties).toEqual({ speed: 100 });
    editor.dispose();
  });

  it('parses a document with no symbols', () => {
    const { editor } = editorFor(
      parseSchematic({ version: 1, sheet: { symbols: [], wires: [], junctions: [] } }),
    );
    expect(editor.getState().canUndo).toBe(false);
    editor.dispose();
  });

  it('selects a wire through a canvas click and deletes it with the keyboard', () => {
    const wireId = '00000006-9cf4-407f-8900-09a16d33a38c';
    const { editor } = editorFor(
      documentOf({
        wires: [
          {
            id: wireId,
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
            ],
          },
        ],
      }),
    );
    const canvas = editor.canvas as unknown as FakeElement;
    const screen = editor.toScreen({ x: 50, y: 0 });
    const pointer = {
      button: 0,
      pointerId: 1,
      clientX: screen.x,
      clientY: screen.y,
      shiftKey: false,
      preventDefault: () => {},
    };
    canvas.emit('pointerdown', pointer);
    canvas.emit('pointerup', pointer);
    expect(editor.getSelection()).toEqual([{ kind: 'wire', id: wireId }]);

    (editor.root as unknown as FakeElement).emit('keydown', {
      key: 'Delete',
      preventDefault: () => {},
    });
    expect(editor.getValue().sheet.wires).toEqual([]);
    expect(editor.getSelection()).toEqual([]);
    editor.dispose();
  });
});
