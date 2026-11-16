/**
 * 有界串口历史。
 *
 * 每个通道保存最近 `capacity` 字节，并给每个字节分配严格递增的游标。实时事件携带
 * 本批第一个字节的游标；历史查询从调用方游标继续，若请求位置已经过期，`dropped`
 * 明确报告丢失的字节数，而不是把剩余数据伪装成连续历史。缓冲区容量固定，不保存
 * 无界数组。公开载荷形状由清单生成的 `DeviceMethods` 在工厂处校验。
 */

export class SerialLog {
  readonly capacity: number;

  private readonly buffer: Uint8Array;
  private startOffset = 0;
  private count = 0;
  private nextCursor = 0;
  private droppedTotal = 0;

  constructor(capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0)
      throw new RangeError('Serial capacity must be a positive safe integer');

    this.capacity = capacity;
    this.buffer = new Uint8Array(capacity);
  }

  /** 当前下一个可写游标，也等于已经产生的字节总数。 */
  get next(): number {
    return this.nextCursor;
  }

  /** 仍被保留的最旧字节游标。 */
  get oldest(): number {
    return this.nextCursor - this.count;
  }

  /**
   * 追加一批字节并返回它们在历史中的起始游标。返回的 `data` 是调用方提供的同一份
   * 字节，供实时事件使用；历史环形缓冲只保留最后 `capacity` 字节。
   */
  append(bytes: Uint8Array): { readonly cursor: number; readonly data: Uint8Array } {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Serial bytes must be a Uint8Array');

    const cursor = this.nextCursor;

    if (bytes.length === 0) return { cursor, data: bytes };

    if (bytes.length >= this.capacity) {
      this.droppedTotal += this.count + (bytes.length - this.capacity);
      this.startOffset = 0;
      this.count = this.capacity;
      this.buffer.set(bytes.subarray(bytes.length - this.capacity));
    } else {
      const overflow = Math.max(0, this.count + bytes.length - this.capacity);

      if (overflow > 0) {
        this.startOffset = (this.startOffset + overflow) % this.capacity;
        this.count -= overflow;
        this.droppedTotal += overflow;
      }

      const writeAt = (this.startOffset + this.count) % this.capacity;
      const first = Math.min(bytes.length, this.capacity - writeAt);

      this.buffer.set(bytes.subarray(0, first), writeAt);
      if (first < bytes.length) this.buffer.set(bytes.subarray(first), 0);
      this.count += bytes.length;
    }

    this.nextCursor += bytes.length;

    return { cursor, data: bytes };
  }

  /** 读取游标之后仍保留的字节；请求位置过旧时返回 `dropped > 0`。 */
  read(cursor: number): {
    readonly start: number;
    readonly end: number;
    readonly dropped: number;
    readonly data: Uint8Array;
  } {
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new RangeError('Serial cursor must be a nonnegative safe integer');

    let start = Math.min(cursor, this.nextCursor);
    let dropped = 0;
    const oldest = this.oldest;

    if (start < oldest) {
      dropped = oldest - start;
      start = oldest;
    }

    const length = this.nextCursor - start;
    const data = new Uint8Array(length);

    if (length > 0) {
      const offset = (this.startOffset + (start - oldest)) % this.capacity;
      const first = Math.min(length, this.capacity - offset);

      data.set(this.buffer.subarray(offset, offset + first), 0);
      if (first < length) data.set(this.buffer.subarray(0, length - first), first);
    }

    return { start, end: this.nextCursor, dropped, data };
  }

  status(): {
    readonly capacity: number;
    readonly oldest: number;
    readonly next: number;
    readonly droppedTotal: number;
  } {
    return {
      capacity: this.capacity,
      oldest: this.oldest,
      next: this.nextCursor,
      droppedTotal: this.droppedTotal,
    };
  }
}
