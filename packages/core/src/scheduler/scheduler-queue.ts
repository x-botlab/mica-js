export class MinHeap<T> {
  readonly #items: T[] = [];

  constructor(readonly compare: (left: T, right: T) => number) {}

  peek(): T | undefined {
    return this.#items[0];
  }

  push(item: T): void {
    const items = this.#items;
    let index = items.length;
    items.push(item);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(items[parent]!, item) <= 0) break;
      items[index] = items[parent]!;
      index = parent;
    }
    items[index] = item;
  }

  pop(): T | undefined {
    const items = this.#items;
    const first = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) return first;
    let index = 0;
    while (index * 2 + 1 < items.length) {
      let child = index * 2 + 1;
      if (child + 1 < items.length && this.compare(items[child + 1]!, items[child]!) < 0) {
        child += 1;
      }
      if (this.compare(last, items[child]!) <= 0) break;
      items[index] = items[child]!;
      index = child;
    }
    items[index] = last;
    return first;
  }
}

export class EventIdPool {
  #highest = 0;
  #released: number[] = [];
  #head = 0;

  constructor(readonly maximum = 0xffff_ffff) {}

  allocated(id: number): boolean {
    return id <= this.#highest;
  }

  take(): number | undefined {
    if (this.#head < this.#released.length) {
      const id = this.#released[this.#head++]!;
      if (this.#head >= 1024 && this.#head * 2 >= this.#released.length) {
        this.#released = this.#released.slice(this.#head);
        this.#head = 0;
      }
      return id;
    }
    if (this.#highest === this.maximum) return undefined;
    this.#highest += 1;
    return this.#highest;
  }

  release(id: number): void {
    this.#released.push(id);
  }
}
