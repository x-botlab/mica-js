import type { SchematicDocument } from '../format/types';
import { serializeSchematic } from '../format/serialize';
import { deriveSchematicTopology, type SchematicTopology } from '../topology/derive';
import {
  applySchematicCommand,
  type SchematicCommand,
  type SchematicEditOptions,
} from './commands';

export interface SchematicEditorOptions extends SchematicEditOptions {
  /** Maximum number of undo steps kept; defaults to 200. */
  readonly historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 200;

/**
 * Stateful editor over a schematic document with undo/redo.
 * Every mutation goes through {@link applySchematicCommand}; failures leave the state untouched.
 */
export class SchematicEditor {
  readonly #options: SchematicEditorOptions;
  readonly #historyLimit: number;
  #past: SchematicDocument[] = [];
  #future: SchematicDocument[] = [];
  #document: SchematicDocument;
  #depth = 0;

  constructor(document: SchematicDocument, options: SchematicEditorOptions = {}) {
    this.#document = document;
    this.#options = options;
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  get document(): SchematicDocument {
    return this.#document;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  /** @throws {SchematicError} leaving the current document and history untouched. */
  dispatch(command: SchematicCommand): void {
    const next = applySchematicCommand(this.#document, command, this.#options);
    this.#record(next);
  }

  /** Applies several edits atomically; a failure rolls back every command in the block. */
  transaction(edit: (editor: SchematicEditor) => void): void {
    if (this.#depth > 0) {
      edit(this);
      return;
    }
    const document = this.#document;
    const future = this.#future;
    this.#past.push(document);
    this.#future = [];
    this.#depth = 1;
    try {
      edit(this);
    } catch (error) {
      this.#document = document;
      this.#past.pop();
      this.#future = future;
      throw error;
    } finally {
      this.#depth = 0;
    }
    if (this.#document === document) {
      this.#past.pop();
      this.#future = future;
      return;
    }
    this.#trimHistory();
  }

  undo(): void {
    const previous = this.#past.pop();
    if (previous === undefined) {
      return;
    }
    if (this.#depth === 0) {
      this.#future.push(this.#document);
    }
    this.#document = previous;
  }

  redo(): void {
    const next = this.#future.pop();
    if (next === undefined) {
      return;
    }
    if (this.#depth === 0) {
      this.#past.push(this.#document);
    }
    this.#document = next;
  }

  topology(): SchematicTopology {
    return deriveSchematicTopology(this.#document, this.#options);
  }

  toJSON(): string {
    return serializeSchematic(this.#document);
  }

  #record(next: SchematicDocument): void {
    const previous = this.#document;
    this.#document = next;
    if (this.#depth > 0) {
      return;
    }
    this.#past.push(previous);
    this.#future = [];
    this.#trimHistory();
  }

  #trimHistory(): void {
    if (this.#past.length > this.#historyLimit) {
      this.#past.shift();
    }
  }
}
