import { Emitter } from '@mica-js/core/lifecycle';
import type { Event } from '@mica-js/core/lifecycle';
import type {
  Widget,
  WidgetBinding,
  WidgetInstance,
  WidgetLayer,
  WidgetLayerChange,
  WidgetLayers,
} from './types';

export interface WidgetInit {
  readonly instanceId: string;
  readonly widget: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly dpr: number;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly bindings: Readonly<Record<string, WidgetBinding>>;
}

export interface WidgetPatch {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly rotation?: number;
  readonly dpr?: number;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly bindings?: Readonly<Record<string, WidgetBinding>>;
}

/** Mutable backing record; the read-only `Widget` / `WidgetLayer` views are snapshots of it. */
interface WidgetRecord {
  readonly instanceId: string;
  widget: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  dpr: number;
  properties: Readonly<Record<string, unknown>>;
  bindings: Readonly<Record<string, WidgetBinding>>;
  bitmap: ImageBitmap | undefined;
  sequence: number;
}

/**
 * Instance table owned by the host.
 *
 * The table is the single source of the two projections RFC 0018 defines: `listInstances()` reads a
 * bulk view without bitmaps, and the four `onDid*` events report one change each with the complete
 * state. The legacy `WidgetLayers` view stays for the canvas editor: records mutate in place, so a
 * caller holding a layer from `get()` sees later frames without re-reading the table.
 */
export class WidgetStore implements WidgetLayers {
  readonly #records = new Map<string, WidgetRecord>();
  readonly #changes = new Set<(change: WidgetLayerChange) => void>();
  readonly #added = new Emitter<Widget>();
  readonly #updated = new Emitter<Widget>();
  readonly #removed = new Emitter<string>();
  readonly #reordered = new Emitter<readonly string[]>();

  /**
   * The four RFC 0018 events. A listener that throws is logged instead of breaking the document
   * flow, and the subscription itself is an ordinary {@link Disposable}.
   */
  readonly onDidAddWidget: Event<Widget> = (listener, thisArgs, disposables) =>
    this.#added.event(
      (widget) => invoke(listener, widget, 'widget add listener', thisArgs),
      undefined,
      disposables,
    );

  readonly onDidChangeWidget: Event<Widget> = (listener, thisArgs, disposables) =>
    this.#updated.event(
      (widget) => invoke(listener, widget, 'widget change listener', thisArgs),
      undefined,
      disposables,
    );

  readonly onDidRemoveWidget: Event<string> = (listener, thisArgs, disposables) =>
    this.#removed.event(
      (instanceId) => invoke(listener, instanceId, 'widget remove listener', thisArgs),
      undefined,
      disposables,
    );

  readonly onDidReorderWidgets: Event<readonly string[]> = (listener, thisArgs, disposables) =>
    this.#reordered.event(
      (order) => invoke(listener, order, 'widget reorder listener', thisArgs),
      undefined,
      disposables,
    );

  list(): readonly WidgetLayer[] {
    return [...this.#records.values()];
  }

  get(instanceId: string): WidgetLayer | undefined {
    return this.#records.get(instanceId);
  }

  listInstances(): readonly WidgetInstance[] {
    return [...this.#records.values()].map(toInstance);
  }

  subscribe(listener: (change: WidgetLayerChange) => void): () => void {
    this.#changes.add(listener);
    return () => {
      this.#changes.delete(listener);
    };
  }

  add(init: WidgetInit): Widget {
    this.remove(init.instanceId);
    const record: WidgetRecord = {
      instanceId: init.instanceId,
      widget: init.widget,
      x: init.x,
      y: init.y,
      width: init.width,
      height: init.height,
      rotation: init.rotation,
      dpr: init.dpr,
      properties: init.properties,
      bindings: init.bindings,
      bitmap: undefined,
      sequence: 0,
    };
    this.#records.set(init.instanceId, record);
    this.#emitChange({ type: 'added', instanceId: init.instanceId });
    this.#emitAdd(record);
    return record;
  }

  /**
   * Applies the document-derived fields of one instance and reports the ones that changed.
   *
   * @returns whether anything changed.
   */
  update(instanceId: string, patch: WidgetPatch): boolean {
    const record = this.#records.get(instanceId);
    if (!record) return false;

    let changed = false;
    if (patch.x !== undefined && patch.x !== record.x) {
      record.x = patch.x;
      changed = true;
    }
    if (patch.y !== undefined && patch.y !== record.y) {
      record.y = patch.y;
      changed = true;
    }
    if (patch.width !== undefined && patch.width !== record.width) {
      record.width = patch.width;
      changed = true;
    }
    if (patch.height !== undefined && patch.height !== record.height) {
      record.height = patch.height;
      changed = true;
    }
    if (patch.rotation !== undefined && patch.rotation !== record.rotation) {
      record.rotation = patch.rotation;
      changed = true;
    }
    if (patch.dpr !== undefined && patch.dpr !== record.dpr) {
      record.dpr = patch.dpr;
      changed = true;
    }
    if (patch.properties !== undefined && !sameRecord(record.properties, patch.properties)) {
      record.properties = patch.properties;
      changed = true;
    }
    if (patch.bindings !== undefined && !sameRecord(record.bindings, patch.bindings)) {
      record.bindings = patch.bindings;
      changed = true;
    }
    if (changed) this.#emitUpdate(record);
    return changed;
  }

  /** Installs a frame, closing the one it replaces, and bumps the sequence. */
  setBitmap(instanceId: string, bitmap: ImageBitmap): void {
    const record = this.#records.get(instanceId);
    if (!record) {
      closeBitmap(bitmap);
      return;
    }
    const previous = record.bitmap;
    record.bitmap = bitmap;
    record.sequence += 1;
    closeBitmap(previous);
    this.#emitUpdate(record);
  }

  remove(instanceId: string): void {
    const record = this.#records.get(instanceId);
    if (!record) return;
    this.#records.delete(instanceId);
    closeBitmap(record.bitmap);
    record.bitmap = undefined;
    this.#emitChange({ type: 'removed', instanceId });
    this.#emitRemove(instanceId);
  }

  /**
   * Rewrites drawing order to `instanceIds` without touching a frame.
   *
   * Ids the table does not hold are skipped, and records the caller did not list keep their
   * relative order at the end: a mount in flight owns an instance before the document entry that
   * created it is reconciled.
   */
  reorder(instanceIds: readonly string[]): void {
    const ordered = new Map<string, WidgetRecord>();
    for (const instanceId of instanceIds) {
      const record = this.#records.get(instanceId);
      if (record !== undefined) ordered.set(instanceId, record);
    }
    for (const [instanceId, record] of this.#records) {
      if (!ordered.has(instanceId)) ordered.set(instanceId, record);
    }
    if (sameOrder([...this.#records.keys()], [...ordered.keys()])) return;

    this.#records.clear();
    for (const [instanceId, record] of ordered) {
      this.#records.set(instanceId, record);
    }
    this.#emitChange({ type: 'reordered' });
    this.#reordered.fire([...this.#records.keys()]);
  }

  clear(): void {
    for (const instanceId of [...this.#records.keys()]) {
      this.remove(instanceId);
    }
  }

  /**
   * Reports every instance as removed and then added again, in drawing order, without touching a
   * record: a subscriber rebuilds its composite from the same bitmaps.
   */
  invalidate(): void {
    const records = [...this.#records.values()];
    for (const record of records) {
      this.#emitChange({ type: 'removed', instanceId: record.instanceId });
      this.#emitRemove(record.instanceId);
    }
    for (const record of records) {
      this.#emitChange({ type: 'added', instanceId: record.instanceId });
      this.#emitAdd(record);
    }
  }

  #emitUpdate(record: WidgetRecord): void {
    this.#emitChange({ type: 'updated', instanceId: record.instanceId });
    this.#updated.fire(toWidget(record));
  }

  #emitAdd(record: WidgetRecord): void {
    this.#added.fire(toWidget(record));
  }

  #emitRemove(instanceId: string): void {
    this.#removed.fire(instanceId);
  }

  #emitChange(change: WidgetLayerChange): void {
    for (const listener of [...this.#changes]) {
      invoke(listener, change, 'layer listener');
    }
  }
}

function toWidget(record: WidgetRecord): Widget {
  return {
    instanceId: record.instanceId,
    widget: record.widget,
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
    rotation: record.rotation,
    dpr: record.dpr,
    properties: record.properties,
    bindings: record.bindings,
    bitmap: record.bitmap,
    sequence: record.sequence,
  };
}

function toInstance(record: WidgetRecord): WidgetInstance {
  return {
    instanceId: record.instanceId,
    widget: record.widget,
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
    rotation: record.rotation,
    dpr: record.dpr,
    properties: record.properties,
    bindings: record.bindings,
    sequence: record.sequence,
  };
}

function invoke<T>(
  listener: (payload: T) => unknown,
  payload: T,
  name: string,
  thisArgs?: unknown,
): void {
  try {
    listener.call(thisArgs, payload);
  } catch (error) {
    console.error(`[@mica-js/widget] ${name} threw`, error);
  }
}

/** Closes a bitmap without letting a double close escape. */
export function closeBitmap(bitmap: ImageBitmap | undefined): void {
  if (!bitmap) return;
  try {
    bitmap.close();
  } catch {
    // Already closed by its previous owner.
  }
}

/**
 * Shallow comparison of two record maps.
 *
 * The document owns property/binding values, so a nested object only counts as changed when the
 * caller replaced the object itself; deep equality would swallow those edits. The key sets matter
 * as much as the values, because a missing property key falls back to the definition default.
 */
export function sameRecord(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  if (left === right) return true;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
  );
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
