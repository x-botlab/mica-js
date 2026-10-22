import type { InboxRef, MemoryDefinition } from '@mica-js/ir';

interface FreeRange {
  readonly start: number;
  readonly end: number;
}

/** First-fit reservation of contiguous inbox ranges, released at kernel entry boundaries. */
export class InboxAllocator {
  readonly #ranges = new Map<object, FreeRange[]>();
  readonly #capacities = new Map<object, number>();

  constructor(memories: readonly MemoryDefinition[]) {
    for (const memory of memories) {
      if (memory.kind !== 'inbox' || memory.layout.kind !== 'bytes') continue;
      this.#ranges.set(memory.ref, [{ start: 0, end: memory.layout.length }]);
      this.#capacities.set(memory.ref, memory.layout.length);
    }
  }

  has(ref: object): boolean {
    return this.#ranges.has(ref);
  }

  capacity(ref: object): number | undefined {
    return this.#capacities.get(ref);
  }

  reserve(ref: InboxRef, length: number): number | undefined {
    if (length === 0) return 0;
    const ranges = this.#ranges.get(ref);
    if (ranges === undefined) return undefined;
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index]!;
      const available = range.end - range.start;
      if (available < length) continue;
      if (available === length) {
        ranges.splice(index, 1);
      } else {
        ranges[index] = { start: range.start + length, end: range.end };
      }
      return range.start;
    }
    return undefined;
  }

  release(ref: InboxRef, offset: number, length: number): void {
    if (length === 0) return;
    const ranges = this.#ranges.get(ref);
    if (ranges === undefined) return;
    const start = offset;
    const end = offset + length;
    let index = 0;
    while (index < ranges.length && ranges[index]!.start < start) index += 1;
    ranges.splice(index, 0, { start, end });
    if (index > 0 && ranges[index - 1]!.end === start) {
      const previous = ranges[index - 1]!;
      const current = ranges[index]!;
      ranges[index - 1] = { start: previous.start, end: current.end };
      ranges.splice(index, 1);
      index -= 1;
    }
    if (index + 1 < ranges.length && ranges[index]!.end === ranges[index + 1]!.start) {
      const current = ranges[index]!;
      const next = ranges[index + 1]!;
      ranges[index] = { start: current.start, end: next.end };
      ranges.splice(index + 1, 1);
    }
  }

  reset(): void {
    for (const [ref, capacity] of this.#capacities) {
      this.#ranges.set(ref, [{ start: 0, end: capacity }]);
    }
  }
}
