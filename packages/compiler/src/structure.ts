/**
 * Deterministic structural digest for artifact-cache candidates.
 *
 * The digest only filters candidates; every instruction-cache hit still confirms structural
 * equality before reusing an emission. Numbers use `Object.is` semantics (`-0` differs from
 * `0`, `NaN` equals itself), array order is preserved and object keys are sorted so a
 * structurally equal object with a different property insertion order has the same digest.
 * Cycles, functions and symbols cannot be digested and return undefined.
 */

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

  /** Fixed-width length prefix, so adjacent markers and string content stay unambiguous. */
  private length(value: number): void {
    this.code((value >>> 24) & 0xff);
    this.code((value >>> 16) & 0xff);
    this.code((value >>> 8) & 0xff);
    this.code(value & 0xff);
  }

  private text(value: string): void {
    this.code(0x01);
    this.length(value.length);
    for (let index = 0; index < value.length; index++) this.code(value.charCodeAt(index));
  }

  private number(value: number): void {
    if (Object.is(value, -0)) return this.code(0x02);
    if (Number.isNaN(value)) return this.code(0x03);
    this.code(0x04);
    bits.setFloat64(0, value);
    for (let index = 0; index < 8; index++) this.code(bits.getUint8(index));
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
