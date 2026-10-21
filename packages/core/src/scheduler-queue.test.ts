import { expect, it } from 'vitest';
import { EventIdPool, MinHeap } from './scheduler-queue';

it('orders a long queue iteratively and handles empty pops', () => {
  const heap = new MinHeap<number>((a, b) => a - b);
  expect(heap.pop()).toBeUndefined();
  for (let i = 10_000; i > 0; i -= 1) heap.push((i * 7919) % 10_000);
  for (let i = 0; i < 10_000; i += 1) expect(heap.pop()).toBe(i);
  expect(heap.peek()).toBeUndefined();
  expect(heap.pop()).toBeUndefined();
});

it('exhausts only occupied IDs and reuses FIFO even at exhaustion', () => {
  const ids = new EventIdPool(3);
  expect([ids.take(), ids.take(), ids.take(), ids.take()]).toEqual([1, 2, 3, undefined]);
  ids.release(3);
  ids.release(1);
  expect([ids.take(), ids.take(), ids.take()]).toEqual([3, 1, undefined]);
  expect(ids.allocated(3)).toBe(true);
  expect(ids.allocated(4)).toBe(false);
});

it('preserves FIFO across free-list compaction and lifetime allocations', () => {
  const ids = new EventIdPool();
  for (let i = 1; i <= 3000; i += 1) expect(ids.take()).toBe(i);
  for (let i = 3000; i > 0; i -= 1) ids.release(i);
  for (let i = 3000; i > 0; i -= 1) expect(ids.take()).toBe(i);
  expect(ids.take()).toBe(3001);
  ids.release(2);
  for (let i = 0; i < 5000; i += 1) {
    expect(ids.take()).toBe(2);
    ids.release(2);
  }
});
