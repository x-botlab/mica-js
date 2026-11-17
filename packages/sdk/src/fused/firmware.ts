/**
 * Firmware images of the fused runtime (RFC 0026).
 *
 * The framework captures the source bytes, checks `maxBytes`, decodes the declared format into a
 * read-only segmented image and hands it to the model factory. Only BIN is decoded here; HEX and
 * ELF are recognized and rejected explicitly instead of being passed through unparsed.
 */
import type {
  FirmwareAddressSpace,
  FirmwareImage,
  FirmwareSegment,
  ReadonlyBytes,
} from '@mica-js/document/fused';

export type FirmwareFormat = 'bin' | 'hex' | 'elf';

const EXTENSIONS: ReadonlyMap<string, FirmwareFormat> = new Map([
  ['bin', 'bin'],
  ['hex', 'hex'],
  ['ihx', 'hex'],
  ['elf', 'elf'],
  ['axf', 'elf'],
]);

/** Format implied by a reliable file name, or `undefined` when the extension is unknown. */
export function firmwareFormatOf(fileName: string): FirmwareFormat | undefined {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) {
    return undefined;
  }
  return EXTENSIONS.get(fileName.slice(dot + 1).toLowerCase());
}

/** Whether the format is decoded by this runtime yet. */
export function isDecodedFormat(format: FirmwareFormat): format is 'bin' {
  return format === 'bin';
}

/** Read-only byte view whose `slice` returns an independent mutable copy (RFC 0026). */
export function readonlyBytes(source: Uint8Array): ReadonlyBytes {
  const bytes = source.slice();
  const target = Object.freeze({
    get length() {
      return bytes.length;
    },
    get byteLength() {
      return bytes.length;
    },
    slice(start?: number, end?: number): Uint8Array {
      return bytes.slice(start, end);
    },
    *[Symbol.iterator](): IterableIterator<number> {
      for (const byte of bytes) {
        yield byte;
      }
    },
  });
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) {
        return bytes[Number(key)];
      }
      return Reflect.get(object, key, receiver) as unknown;
    },
    set() {
      throw new TypeError('Firmware bytes are read-only');
    },
    defineProperty() {
      throw new TypeError('Firmware bytes are read-only');
    },
  }) as ReadonlyBytes;
}

/** Copies and sorts one segment so the image keeps its contract order. */
function segment(space: string, address: number, bytes: Uint8Array): FirmwareSegment {
  return Object.freeze({ addressSpace: space, address, data: readonlyBytes(bytes) });
}

/**
 * Freezes one image after checking segment ranges and per-space overlap.
 *
 * @throws {RangeError} when a segment is empty, negative or overlaps another segment of its space.
 */
export function createFirmwareImage(segments: readonly FirmwareSegment[]): FirmwareImage {
  if (segments.length === 0) {
    throw new RangeError('A firmware image must contain at least one segment');
  }
  const sorted = [...segments].sort((left, right) => {
    if (left.addressSpace !== right.addressSpace) {
      return left.addressSpace < right.addressSpace ? -1 : 1;
    }
    return left.address - right.address;
  });
  const ends = new Map<string, number>();
  for (const entry of sorted) {
    if (!Number.isSafeInteger(entry.address) || entry.address < 0) {
      throw new RangeError(
        `Segment address in space "${entry.addressSpace}" is not a safe integer`,
      );
    }
    if (entry.data.length === 0) {
      throw new RangeError(`Segment in space "${entry.addressSpace}" has no bytes`);
    }
    const end = entry.address + entry.data.length;
    const previous = ends.get(entry.addressSpace);
    if (previous !== undefined && entry.address < previous) {
      throw new RangeError(`Segments of space "${entry.addressSpace}" overlap`);
    }
    ends.set(entry.addressSpace, end);
  }
  return Object.freeze({ segments: Object.freeze(sorted) });
}

/**
 * Builds the image of one BIN source: the byte at index `i` loads at `address + i`.
 *
 * @throws {RangeError} when the full range leaves the declared address space.
 */
export function binFirmwareImage(
  bytes: Uint8Array,
  addressSpace: string,
  space: FirmwareAddressSpace,
  address: number,
): FirmwareImage {
  if (bytes.length === 0) {
    throw new RangeError('A firmware image must not be empty');
  }
  const end = space.start + space.size;
  if (address < space.start || address + bytes.length > end) {
    throw new RangeError(
      `BIN range [${address}, ${address + bytes.length}) leaves address space "${addressSpace}" ` +
        `[${space.start}, ${end})`,
    );
  }
  return createFirmwareImage([segment(addressSpace, address, bytes)]);
}
