import type {
  DevicePropertyDescriptor,
  MemoryProgram,
  ProgramFormat,
  ProgramReference,
  ProgramSegment,
} from '@mica-js/document/fused';
import { createFirmwareImage, readonlyBytes } from './firmware.js';
import { PROGRAM_LIMITS, ProgramError } from './program.js';

function invalid(message: string): never {
  throw new ProgramError('program/invalid-format', message);
}

export function decodeMemoryProgram(
  format: ProgramFormat,
  bytes: Uint8Array,
  descriptor: DevicePropertyDescriptor,
  reference: ProgramReference,
): MemoryProgram {
  if (bytes.length > PROGRAM_LIMITS.maxMemoryBytes)
    throw new ProgramError('program/resource-limit', 'Program input exceeds the fixed byte limit.');
  if (!descriptor.formats?.includes(format))
    throw new ProgramError(
      'program/unsupported-format',
      `This program property does not accept ${format}.`,
    );
  if (
    (format !== 'bin' && reference.loadAddress !== undefined) ||
    (format === 'elf' && reference.addressSpace !== undefined)
  )
    throw new ProgramError(
      'schema/invalid-value',
      'The program format does not accept the saved address overrides.',
    );
  const spaces = descriptor.addressSpaces ?? {};
  const spaceId = reference.addressSpace ?? descriptor.defaults?.addressSpace;
  if (format !== 'elf' && (spaceId === undefined || spaces[spaceId] === undefined))
    throw new ProgramError(
      'schema/invalid-value',
      'The selected program address space does not exist.',
    );
  const chunks =
    format === 'bin'
      ? [{ address: reference.loadAddress ?? descriptor.defaults?.loadAddress ?? -1, data: bytes }]
      : format === 'hex'
        ? decodeHex(bytes)
        : decodeElf(bytes);
  let total = 0;
  const segments: ProgramSegment[] = chunks.map((chunk) => {
    const end = chunk.address + chunk.data.length;
    if (!Number.isSafeInteger(chunk.address) || chunk.address < 0 || !Number.isSafeInteger(end))
      throw new ProgramError(
        'program/out-of-range',
        'Program address is outside the safe integer range.',
      );
    const candidates =
      format === 'elf'
        ? Object.entries(spaces)
            .filter(([, space]) => chunk.address >= space.start && end <= space.start + space.size)
            .map(([id]) => id)
        : spaceId === undefined
          ? []
          : [spaceId];
    if (candidates.length > 1)
      throw new ProgramError(
        'program/ambiguous-address-space',
        'ELF load segment matches multiple address spaces.',
      );
    const id = candidates[0];
    const space = id === undefined ? undefined : spaces[id];
    if (
      space === undefined ||
      id === undefined ||
      chunk.address < space.start ||
      end > space.start + space.size
    )
      throw new ProgramError(
        'program/out-of-range',
        'Program load segment leaves its declared address space.',
      );
    total += chunk.data.length;
    if (total > PROGRAM_LIMITS.maxMemoryBytes)
      throw new ProgramError(
        'program/resource-limit',
        'Decoded program exceeds the fixed byte limit.',
      );
    return { addressSpace: id, address: chunk.address, data: readonlyBytes(chunk.data) };
  });
  try {
    return createFirmwareImage(segments);
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    throw new ProgramError('program/invalid-image', cause.message);
  }
}

interface Chunk {
  readonly address: number;
  readonly data: Uint8Array;
}

function decodeHex(bytes: Uint8Array): Chunk[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    invalid('Intel HEX is not valid text.');
  }
  const chunks: Chunk[] = [];
  let base = 0;
  let ended = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (ended || !/^:(?:[0-9a-fA-F]{2})+$/.test(line))
      invalid('Invalid Intel HEX record or data after EOF.');
    const record = Uint8Array.from(line.slice(1).match(/../g) ?? [], (pair) =>
      Number.parseInt(pair, 16),
    );
    const length = record[0];
    if (
      length === undefined ||
      record.length !== length + 5 ||
      (record.reduce((sum, byte) => sum + byte, 0) & 255) !== 0
    )
      invalid('Intel HEX length or checksum mismatch.');
    const address = (record[1] ?? 0) * 256 + (record[2] ?? 0);
    const type = record[3];
    const data = record.subarray(4, 4 + length);
    switch (type) {
      case 0:
        if (address + length > 65536) invalid('Intel HEX record crosses its address window.');
        if (length > 0) chunks.push({ address: base + address, data });
        break;
      case 1:
        if (address !== 0 || length !== 0) invalid('Invalid Intel HEX EOF.');
        ended = true;
        break;
      case 2:
      case 4:
        if (address !== 0 || length !== 2) invalid('Invalid Intel HEX extended address.');
        base = ((data[0] ?? 0) * 256 + (data[1] ?? 0)) * (type === 2 ? 16 : 65536);
        break;
      case 3:
      case 5:
        if (address !== 0 || length !== 4) invalid('Invalid Intel HEX start address.');
        break;
      default:
        invalid('Unknown Intel HEX record type.');
    }
  }
  if (!ended) invalid('Intel HEX has no EOF record.');
  return chunks;
}

function decodeElf(bytes: Uint8Array): Chunk[] {
  if (
    bytes.length < 16 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[6] !== 1
  )
    invalid('Invalid ELF identification.');
  const wide = bytes[4] === 2;
  const headerSize = wide ? 64 : 52;
  if ((bytes[4] !== 1 && !wide) || (bytes[5] !== 1 && bytes[5] !== 2) || bytes.length < headerSize)
    invalid('Invalid ELF class, byte order or header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[5] === 1;
  const u16 = (offset: number) => view.getUint16(offset, little);
  const u32 = (offset: number) => view.getUint32(offset, little);
  const word = (offset: number) => {
    if (!wide) return u32(offset);
    const value = view.getBigUint64(offset, little);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid('ELF integer exceeds the safe range.');
    return Number(value);
  };
  if (u16(16) !== 2 || u32(20) !== 1 || u16(wide ? 52 : 40) !== headerSize)
    invalid('ELF must be a linked ET_EXEC image with a valid header.');
  const offset = word(wide ? 32 : 28);
  const stride = u16(wide ? 54 : 42);
  const count = u16(wide ? 56 : 44);
  if (count === 0) return [];
  if (
    count === 0xffff ||
    stride < (wide ? 56 : 32) ||
    offset < headerSize ||
    !Number.isSafeInteger(offset + count * stride) ||
    offset + count * stride > bytes.length
  )
    invalid('Invalid ELF program header table.');
  const chunks: Chunk[] = [];
  for (let i = 0; i < count; i++) {
    const at = offset + i * stride;
    const type = u32(at);
    if (type === 2 || type === 3) invalid('ELF dynamic loading is not supported.');
    if (type !== 1) continue;
    const fileOffset = word(at + (wide ? 8 : 4));
    const address = word(at + (wide ? 24 : 12));
    const fileSize = word(at + (wide ? 32 : 16));
    const memorySize = word(at + (wide ? 40 : 20));
    if (
      fileSize > memorySize ||
      !Number.isSafeInteger(fileOffset + fileSize) ||
      fileOffset + fileSize > bytes.length
    )
      invalid('Invalid ELF load segment bounds.');
    if (fileSize > 0)
      chunks.push({ address, data: bytes.subarray(fileOffset, fileOffset + fileSize) });
  }
  return chunks;
}
