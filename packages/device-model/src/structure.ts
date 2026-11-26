/**
 * JIT 函数表与绑定块复用的内部结构工具。
 *
 * 比较只接受普通 IR 数据，数字使用 Object.is 语义（区分 -0 与 0，NaN 等于自身）。
 * 循环、访问器、符号键或函数值一律视为不可比较；摘要只作为候选筛选，不能替代
 * 完整结构相等确认。
 */

export function sameIR(left: unknown, right: unknown): boolean {
  try {
    return compare(left, right, new Set<object>());
  } catch {
    return false;
  }
}

function compare(left: unknown, right: unknown, ancestors: Set<object>): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (ancestors.has(left) || ancestors.has(right)) return false;
  const array = Array.isArray(left);
  if (array !== Array.isArray(right)) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (array && (left as readonly unknown[]).length !== (right as readonly unknown[]).length)
    return false;
  const keys = ownKeys(left, array);
  const otherKeys = ownKeys(right, array);
  if (keys === undefined || otherKeys === undefined || keys.length !== otherKeys.length)
    return false;
  ancestors.add(left);
  ancestors.add(right);
  for (const key of keys) {
    const value = Object.getOwnPropertyDescriptor(left, key);
    const other = Object.getOwnPropertyDescriptor(right, key);
    if (
      !value ||
      !other ||
      !('value' in value) ||
      !('value' in other) ||
      !compare(value.value, other.value, ancestors)
    )
      return false;
  }
  return true;
}

function ownKeys(value: object, array: boolean): string[] | undefined {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    if (!array || key !== 'length') keys.push(key);
  }
  return keys;
}

export function structuralDigest(input: unknown): string | undefined {
  try {
    const digest = new StructuralDigest();
    return digest.visit(input, new Set<object>()) ? digest.value() : undefined;
  } catch {
    return undefined;
  }
}

const bits = new DataView(new ArrayBuffer(8));

class StructuralDigest {
  private first = 0x811c9dc5;
  private second = 0x9e3779b9;
  private fields = 0;

  value(): string {
    return `${this.first >>> 0}:${this.second >>> 0}:${this.fields}`;
  }

  private code(value: number): void {
    this.first = Math.imul(this.first ^ value, 0x01000193);
    this.second = Math.imul(this.second ^ value, 0x85ebca6b);
    this.second = (this.second << 13) | (this.second >>> 19);
    this.fields++;
  }

  /** 固定宽度长度前缀，避免相邻标记与字符串内容拼接产生歧义。 */
  private length(value: number): void {
    this.code((value >>> 24) & 0xff);
    this.code((value >>> 16) & 0xff);
    this.code((value >>> 8) & 0xff);
    this.code(value & 0xff);
  }

  private text(value: string): void {
    this.code(0x01);
    this.length(value.length);
    for (let i = 0; i < value.length; i++) this.code(value.charCodeAt(i));
  }

  private number(value: number): void {
    if (Object.is(value, -0)) return this.code(0x02);
    if (Number.isNaN(value)) return this.code(0x03);
    this.code(0x04);
    bits.setFloat64(0, value);
    for (let i = 0; i < 8; i++) this.code(bits.getUint8(i));
  }

  visit(value: unknown, ancestors: Set<object>): boolean {
    switch (typeof value) {
      case 'undefined':
        this.code(0x10);
        return true;
      case 'boolean':
        this.code(value ? 0x11 : 0x12);
        return true;
      case 'number':
        this.number(value);
        return true;
      case 'string':
        this.text(value);
        return true;
      case 'bigint':
        this.code(0x13);
        this.text(value.toString());
        return true;
      case 'function':
      case 'symbol':
        return false;
      case 'object':
        break;
    }
    if (value === null) {
      this.code(0x14);
      return true;
    }
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const array = Array.isArray(value);
    this.code(array ? 0x15 : 0x16);
    if (array) this.length(value.length);
    const keys: string[] = [];
    let valid = true;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        valid = false;
        break;
      }
      if (array && key === 'length') continue;
      keys.push(key);
    }
    if (valid) {
      keys.sort();
      this.length(keys.length);
      for (const key of keys) {
        this.text(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !this.visit(descriptor.value, ancestors)) {
          valid = false;
          break;
        }
      }
    }
    ancestors.delete(value);
    return valid;
  }
}
