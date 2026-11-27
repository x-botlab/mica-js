/**
 * Binary min-heap over parallel arrays. Every push/pop used to allocate a `{ time, order,
 * value }` record; a timed board pushes one continuation per suspension, so the flat form
 * keeps the scheduler loop allocation-free.
 */
export class EventQueue<T> {
  private readonly times: number[] = [];
  private readonly orders: number[] = [];
  private readonly values: (T | undefined)[] = [];
  private size = 0;
  private sequence = 0;
  get time(): number {
    return this.size === 0 ? Infinity : this.times[0]!;
  }
  push(time: number, value: T): void {
    const at = this.size++;
    this.times[at] = time;
    this.orders[at] = this.sequence++;
    this.values[at] = value;
    this.siftUp(at);
  }
  pop(): T {
    const value = this.values[0]!;
    const last = --this.size;
    if (last >= 0) {
      this.times[0] = this.times[last]!;
      this.orders[0] = this.orders[last]!;
      this.values[0] = this.values[last]!;
      this.times[last] = 0;
      this.orders[last] = 0;
      this.values[last] = undefined;
      this.siftDown();
    }
    return value;
  }
  clear(): void {
    this.size = 0;
    this.values.length = 0;
  }
  private before(first: number, second: number): boolean {
    const times = this.times;
    const a = times[first]!;
    const b = times[second]!;
    return a < b || (a === b && this.orders[first]! < this.orders[second]!);
  }
  private swap(first: number, second: number): void {
    const times = this.times;
    const orders = this.orders;
    const values = this.values;
    const time = times[first]!;
    const order = orders[first]!;
    const value = values[first]!;
    times[first] = times[second]!;
    orders[first] = orders[second]!;
    values[first] = values[second];
    times[second] = time;
    orders[second] = order;
    values[second] = value;
  }
  private siftUp(at: number): void {
    while (at > 0) {
      const parent = (at - 1) >>> 1;
      if (!this.before(at, parent)) break;
      this.swap(at, parent);
      at = parent;
    }
  }
  private siftDown(): void {
    const size = this.size;
    let at = 0;
    for (;;) {
      const left = at * 2 + 1;
      if (left >= size) break;
      const right = left + 1;
      const child = right < size && this.before(right, left) ? right : left;
      if (!this.before(child, at)) break;
      this.swap(at, child);
      at = child;
    }
  }
}
export class ActivationQueue<T> {
  private readonly entries: T[] = [];
  private readonly words: number[] = [];
  /**
   * Active word indices in `[0, activeCount)`. The array keeps its high-water length:
   * truncating it would right-trim the backing store on every boundary.
   */
  private readonly activeWords: number[] = [];
  private activeCount = 0;
  get size(): number {
    return this.activeCount;
  }
  register(entry: T): number {
    return this.entries.push(entry) - 1;
  }
  add(slot: number): void {
    const word = slot >>> 5;
    const previous = this.words[word] ?? 0;
    if (previous === 0) this.activeWords[this.activeCount++] = word;
    this.words[word] = previous | (1 << (slot & 31));
  }
  /**
   * Visits every active entry in board order without materialising a batch. Entries added
   * by the visitor land past the visited range and survive.
   */
  drain(visit: (entry: T) => void): void {
    const active = this.activeWords;
    const visited = this.activeCount;
    if (visited === 0) return;
    if (visited > 1) {
      // Word indices arrive in insertion order; a handful of words sort faster in place
      // than through a comparator call, and the stale tail must not be reordered.
      for (let index = 1; index < visited; index++) {
        const word = active[index]!;
        let position = index;
        while (position > 0 && active[position - 1]! > word) {
          active[position] = active[position - 1]!;
          position--;
        }
        active[position] = word;
      }
    }
    for (let index = 0; index < visited; index++) {
      const word = active[index]!;
      let bits = this.words[word]!;
      this.words[word] = 0;
      const base = word * 32;
      while (bits !== 0) {
        visit(this.entries[base + 31 - Math.clz32(bits & -bits)]!);
        bits &= bits - 1;
      }
    }
    if (this.activeCount === visited) this.activeCount = 0;
    else {
      // A word re-added during the drain was appended past `visited`; shift it down.
      for (let index = visited; index < this.activeCount; index++)
        active[index - visited] = active[index]!;
      this.activeCount -= visited;
    }
  }
  clear(): void {
    this.entries.length = 0;
    this.words.length = 0;
    this.activeWords.length = 0;
    this.activeCount = 0;
  }
}

export class Fifo<T> {
  private readonly values: (T | undefined)[] = [];
  private head = 0;
  private tail = 0;
  get length(): number {
    return this.tail - this.head;
  }
  push(value: T): void {
    // The backing array keeps its high-water length, so a push never clears elements.
    this.values[this.tail++] = value;
  }
  shift(): T {
    const value = this.values[this.head]!;
    this.values[this.head++] = undefined;
    if (this.head === this.tail) {
      this.head = 0;
      this.tail = 0;
    }
    return value;
  }
  clear(): void {
    this.values.length = 0;
    this.head = 0;
    this.tail = 0;
  }
  drain(): T[] {
    const result = this.values.slice(this.head, this.tail) as T[];
    this.clear();
    return result;
  }
}
