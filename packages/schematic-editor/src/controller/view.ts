import type { Placement, SchematicViewDocument } from '@mica-js/core/schematic';

/**
 * The read-only `.view` layout the editor renders with.
 *
 * Symbols whose placement was edited in this session drop their layout entry, so the edit is
 * visible instead of being masked by the stale override. The marker set travels with the document
 * history: undoing an edit restores the override that step still honoured.
 */
export class ViewOverlay {
  #view: SchematicViewDocument | undefined;
  #edited: ReadonlySet<string> = new Set<string>();
  #past: (readonly string[])[] = [];
  #future: (readonly string[])[] = [];
  #renderCache: { readonly view: SchematicViewDocument | undefined } | undefined;

  constructor(view: SchematicViewDocument | undefined) {
    this.#view = view;
  }

  get view(): SchematicViewDocument | undefined {
    return this.#view;
  }

  /** Replaces the layout; a view handed in by the host is authoritative again. */
  setView(view: SchematicViewDocument | undefined): void {
    this.#view = view;
    this.#edited = new Set<string>();
    this.#past = [];
    this.#future = [];
    this.#renderCache = undefined;
  }

  /** Clears the marker history while keeping the layout, e.g. when the document is swapped. */
  clearMarkers(): void {
    this.setView(this.#view);
  }

  markEdited(symbolId: string): void {
    if (this.#edited.has(symbolId)) {
      return;
    }
    const next = new Set(this.#edited);
    next.add(symbolId);
    this.#edited = next;
    this.#renderCache = undefined;
  }

  /** Marker state before a history step, captured so undo can restore it. */
  snapshot(): readonly string[] {
    return [...this.#edited];
  }

  /** Records the step that just landed in the document history. */
  commit(before: readonly string[]): void {
    this.#past.push(before);
    this.#future = [];
  }

  undo(): void {
    const previous = this.#past.pop();
    if (previous === undefined) {
      return;
    }
    this.#future.push([...this.#edited]);
    this.#edited = new Set(previous);
    this.#renderCache = undefined;
  }

  redo(): void {
    const next = this.#future.pop();
    if (next === undefined) {
      return;
    }
    this.#past.push([...this.#edited]);
    this.#edited = new Set(next);
    this.#renderCache = undefined;
  }

  /** Layout without the entries of edited symbols; identity is stable between changes. */
  get renderView(): SchematicViewDocument | undefined {
    if (this.#renderCache !== undefined) {
      return this.#renderCache.view;
    }
    const view = this.#view;
    const rendered =
      view === undefined || this.#edited.size === 0
        ? view
        : {
            ...view,
            layout: keptLayout(view.layout, this.#edited),
          };
    this.#renderCache = { view: rendered };
    return rendered;
  }
}

function keptLayout(
  layout: Readonly<Record<string, Placement>>,
  edited: ReadonlySet<string>,
): Readonly<Record<string, Placement>> {
  const kept: Record<string, Placement> = {};
  for (const [id, placement] of Object.entries(layout)) {
    if (!edited.has(id)) {
      kept[id] = placement;
    }
  }
  return kept;
}
