import type { WidgetLayer, WidgetLayerChange, WidgetLayers } from './types';

export interface WidgetLayerInit {
  readonly instanceId: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** Mutable backing record; the public `WidgetLayer` view is the same object. */
interface LayerRecord {
  readonly instanceId: string;
  width: number;
  height: number;
  dpr: number;
  bitmap: ImageBitmap | undefined;
  sequence: number;
}

/**
 * Layer table owned by the host. Records mutate in place, so callers holding a layer from `get()`
 * or `list()` observe later frames without re-reading the table.
 */
export class WidgetLayerStore implements WidgetLayers {
  readonly #records = new Map<string, LayerRecord>();
  readonly #listeners = new Set<(change: WidgetLayerChange) => void>();

  list(): readonly WidgetLayer[] {
    return [...this.#records.values()];
  }

  get(instanceId: string): WidgetLayer | undefined {
    return this.#records.get(instanceId);
  }

  subscribe(listener: (change: WidgetLayerChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  add(init: WidgetLayerInit): WidgetLayer {
    this.remove(init.instanceId);
    const record: LayerRecord = {
      instanceId: init.instanceId,
      width: init.width,
      height: init.height,
      dpr: init.dpr,
      bitmap: undefined,
      sequence: 0,
    };
    this.#records.set(init.instanceId, record);
    this.#emit({ type: 'added', instanceId: init.instanceId });
    return record;
  }

  setSize(instanceId: string, width: number, height: number): void {
    const record = this.#records.get(instanceId);
    if (!record || (record.width === width && record.height === height)) return;
    record.width = width;
    record.height = height;
    this.#emit({ type: 'updated', instanceId });
  }

  setDpr(instanceId: string, dpr: number): void {
    const record = this.#records.get(instanceId);
    if (!record || record.dpr === dpr) return;
    record.dpr = dpr;
    this.#emit({ type: 'updated', instanceId });
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
    this.#emit({ type: 'updated', instanceId });
  }

  remove(instanceId: string): void {
    const record = this.#records.get(instanceId);
    if (!record) return;
    this.#records.delete(instanceId);
    closeBitmap(record.bitmap);
    record.bitmap = undefined;
    this.#emit({ type: 'removed', instanceId });
  }

  clear(): void {
    for (const instanceId of [...this.#records.keys()]) {
      this.remove(instanceId);
    }
  }

  #emit(change: WidgetLayerChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error('[@mica-js/widget] layer listener threw', error);
      }
    }
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
