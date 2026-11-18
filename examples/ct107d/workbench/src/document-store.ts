import { parseFusedDocument } from '@mica-js/document/fused';
import type { FusedDocument } from '@mica-js/document/fused';

/** Key of the host-owned browser draft; it never aliases the tracked demo document. */
export const DOCUMENT_STORAGE_KEY = 'mica-ct107d-workbench-document-v1';

/** The storage surface the host needs; `localStorage` implements it in a browser. */
export interface DocumentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Browser persistence of the workbench document.
 *
 * Saves and reopens go through the same strict fused-document parser the workbench uses, so a
 * corrupted draft is reported instead of being loaded partially. The tracked `ct107d.sch` is
 * never written by the browser; restoring the demo is an explicit host action.
 */
export class DocumentStore {
  readonly #storage: DocumentStorage;
  readonly #key: string;

  constructor(storage: DocumentStorage, key: string = DOCUMENT_STORAGE_KEY) {
    this.#storage = storage;
    this.#key = key;
  }

  save(document: FusedDocument): void {
    this.#storage.setItem(this.#key, JSON.stringify(document));
  }

  /** Whether a draft key exists; a corrupt value still counts and is reported by `load`. */
  hasDraft(): boolean {
    return this.#storage.getItem(this.#key) !== null;
  }

  /** Returns the saved document, or `undefined` when no draft exists. */
  load(): FusedDocument | undefined {
    const text = this.#storage.getItem(this.#key);
    if (text === null) return undefined;
    return parseFusedDocument(text);
  }

  get key(): string {
    return this.#key;
  }
}
