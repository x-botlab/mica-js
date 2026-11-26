/**
 * Deterministic structural digest for artifact-cache candidates.
 *
 * The digest only filters candidates; every instruction-cache hit still confirms structural
 * equality before reusing an emission. Numbers use `Object.is` semantics (`-0` differs from
 * `0`, `NaN` equals itself), array order is preserved and object keys are sorted so a
 * structurally equal object with a different property insertion order has the same digest.
 * Cycles, functions and symbols cannot be digested and return undefined.
 *
 * The walker reads own enumerable plain data directly instead of building Reflect descriptors:
 * artifact keys run on the compilation path, and validated IR contains no accessors or symbol
 * keys. Arrays with holes or extra properties decline the digest so a caller falls back to an
 * identity key.
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
    let valid: boolean;
    if (Array.isArray(value)) {
      this.code(0x15);
      this.length(value.length);
      // Dense arrays are the common IR shape. A hole or extra property declines the digest
      // instead of silently hashing a different structure.
      const keys = Object.keys(value);
      valid = keys.length === value.length;
      for (let index = 0; valid && index < value.length; index++) {
        if (!(index in value) || !this.visit(value[index], ancestors)) valid = false;
      }
    } else {
      this.code(0x16);
      const keys = Object.keys(value);
      keys.sort();
      this.length(keys.length);
      valid = true;
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        this.text(key);
        if (!this.visit((value as Readonly<Record<string, unknown>>)[key], ancestors)) {
          valid = false;
          break;
        }
      }
    }
    ancestors.delete(value);
    return valid;
  }
}
