export interface TimedTask<T> {
  readonly time: number;
  readonly order: number;
  readonly value: T;
}
export class EventQueue<T> {
  private readonly heap: TimedTask<T>[] = [];
  private sequence = 0;
  get time(): number {
    return this.heap[0]?.time ?? Infinity;
  }
  push(time: number, value: T): void {
    const task = { time, order: this.sequence++, value };
    let at = this.heap.length;
    this.heap.push(task);
    while (at > 0) {
      const parent = (at - 1) >>> 1;
      if (!this.before(task, this.heap[parent]!)) break;
      this.heap[at] = this.heap[parent]!;
      at = parent;
    }
    this.heap[at] = task;
  }
  pop(): T {
    const first = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length) {
      let at = 0;
      while (at * 2 + 1 < this.heap.length) {
        let child = at * 2 + 1;
        if (child + 1 < this.heap.length && this.before(this.heap[child + 1]!, this.heap[child]!))
          child++;
        if (!this.before(this.heap[child]!, last)) break;
        this.heap[at] = this.heap[child]!;
        at = child;
      }
      this.heap[at] = last;
    }
    return first.value;
  }
  clear(): void {
    this.heap.length = 0;
  }
  private before(a: TimedTask<T>, b: TimedTask<T>): boolean {
    return a.time < b.time || (a.time === b.time && a.order < b.order);
  }
}
export class Fifo<T> {
  private values: (T | undefined)[] = [];
  private head = 0;
  get length(): number {
    return this.values.length - this.head;
  }
  push(value: T): void {
    this.values.push(value);
  }
  shift(): T {
    const value = this.values[this.head]!;
    this.values[this.head++] = undefined;
    if (this.head === this.values.length) this.clear();
    return value;
  }
  clear(): void {
    this.values.length = 0;
    this.head = 0;
  }
  drain(): T[] {
    const result = this.values.slice(this.head) as T[];
    this.clear();
    return result;
  }
}
