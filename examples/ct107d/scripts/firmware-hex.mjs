import { createHash } from 'node:crypto';

/**
 * Strict Intel HEX loader for the CT107D 60 KiB 8051 code space.
 *
 * This intentionally follows the validation level of
 * `examples/ct117e-m4/test/firmware.ts` (length, checksum, EOF, record order,
 * address range and overlap), generalized to the 8051 code space. It must not
 * be replaced by the permissive parser in `verify-firmware.mjs`, which silently
 * skips malformed lines, ignores records after EOF, accepts truncated records
 * and last-writer-wins overlaps.
 *
 * Supported record types: 00 (data), 01 (EOF), 02 (extended segment address),
 * 03 (start segment address), 04 (extended linear address), 05 (start linear
 * address). Types 03/05 only contribute `entry`; the 8051 never consumes it.
 */

export const DEFAULT_CODE_SPACE_SIZE = 60 * 1024;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {string | Uint8Array} source
 * @param {{
 *   sourceName?: string,
 *   addressSpaceSize?: number,
 *   fill?: number,
 * }} [options]
 */
export function parseIntelHex(source, options = {}) {
  const sourceName = options.sourceName ?? '<hex>';
  const addressSpaceSize = options.addressSpaceSize ?? DEFAULT_CODE_SPACE_SIZE;
  const fill = options.fill ?? 0xff;

  if (!Number.isSafeInteger(addressSpaceSize) || addressSpaceSize <= 0)
    throw new RangeError(`${sourceName}: addressSpaceSize must be a positive safe integer`);
  if (!Number.isInteger(fill) || fill < 0 || fill > 0xff)
    throw new RangeError(`${sourceName}: fill must be a byte`);

  const sourceBytes =
    typeof source === 'string' ? Buffer.from(source, 'utf8') : new Uint8Array(source);
  const text = Buffer.from(sourceBytes).toString('utf8');
  const data = new Map();
  let currentBase = 0;
  let eof = false;
  let records = 0;
  let dataRecords = 0;
  let entry;
  let maxAddress = -1;
  let minAddress = Number.POSITIVE_INFINITY;

  let lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNumber += 1;
    const line = raw.trim();

    if (line.length === 0) continue;
    if (eof)
      throw new Error(`${sourceName}:${lineNumber}: HEX record after EOF: ${line.slice(0, 16)}`);
    if (!line.startsWith(':'))
      throw new Error(`${sourceName}:${lineNumber}: malformed HEX record: ${line.slice(0, 16)}`);

    const hex = line.slice(1);

    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex))
      throw new Error(`${sourceName}:${lineNumber}: malformed HEX payload: ${line.slice(0, 16)}`);

    const record = Buffer.from(hex, 'hex');

    if (record.length < 5)
      throw new Error(`${sourceName}:${lineNumber}: HEX record is too short: ${line.slice(0, 16)}`);

    const count = record[0];
    if (record.length !== count + 5)
      throw new Error(
        `${sourceName}:${lineNumber}: HEX record length ${record.length} does not match count ${count}`,
      );

    const sum = record.reduce((total, value) => total + value, 0);
    if (sum % 256 !== 0)
      throw new Error(`${sourceName}:${lineNumber}: HEX record checksum mismatch`);

    const offset = record.readUInt16BE(1);
    const kind = record[3];
    const body = record.subarray(4, 4 + count);

    records += 1;

    switch (kind) {
      case 0x00: {
        dataRecords += 1;
        if (currentBase + offset + count > addressSpaceSize)
          throw new Error(
            `${sourceName}:${lineNumber}: HEX data range 0x${(currentBase + offset).toString(16)}..0x${(currentBase + offset + count).toString(16)} is outside the ${addressSpaceSize}-byte code space`,
          );
        for (let index = 0; index < count; index += 1) {
          const address = currentBase + offset + index;
          const value = body[index];
          const previous = data.get(address);
          if (previous !== undefined)
            throw new Error(
              `${sourceName}:${lineNumber}: overlapping HEX data at 0x${address.toString(16)} (${previous === value ? 'identical' : 'conflicting'} byte)`,
            );
          data.set(address, value);
          if (address > maxAddress) maxAddress = address;
          if (address < minAddress) minAddress = address;
        }
        break;
      }
      case 0x01:
        if (count !== 0 || offset !== 0)
          throw new Error(`${sourceName}:${lineNumber}: malformed HEX EOF record`);
        eof = true;
        break;
      case 0x02:
        if (count !== 2 || offset !== 0)
          throw new Error(`${sourceName}:${lineNumber}: malformed HEX segment-address record`);
        currentBase = body.readUInt16BE(0) * 16;
        break;
      case 0x03:
        if (count !== 4 || offset !== 0)
          throw new Error(`${sourceName}:${lineNumber}: malformed HEX start-segment record`);
        entry = body.readUInt16BE(0) * 16 + body.readUInt16BE(2);
        break;
      case 0x04:
        if (count !== 2 || offset !== 0)
          throw new Error(`${sourceName}:${lineNumber}: malformed HEX linear-address record`);
        currentBase = body.readUInt16BE(0) * 0x1_0000;
        break;
      case 0x05:
        if (count !== 4 || offset !== 0)
          throw new Error(`${sourceName}:${lineNumber}: malformed HEX start-linear record`);
        entry = body.readUInt32BE(0);
        break;
      default:
        throw new Error(`${sourceName}:${lineNumber}: unsupported HEX record type ${kind}`);
    }
  }

  if (!eof) throw new Error(`${sourceName}: HEX image is missing the EOF record`);
  if (data.size === 0) throw new Error(`${sourceName}: HEX image contains no data records`);
  if (!data.has(0))
    throw new Error(`${sourceName}: HEX image does not cover the 8051 reset vector at 0x0000`);
  if (maxAddress - 0 + 1 < 3)
    throw new Error(`${sourceName}: HEX image is too small for an 8051 reset vector`);

  const end = maxAddress + 1;
  const image = new Uint8Array(end).fill(fill);
  for (const [address, value] of data) image[address] = value;

  let gaps = 0;
  let previousAddress = -2;
  for (const address of [...data.keys()].sort((left, right) => left - right)) {
    if (address !== previousAddress + 1 && previousAddress !== -2) gaps += 1;
    previousAddress = address;
  }

  return Object.freeze({
    sourceName,
    sourceSha256: sha256(sourceBytes),
    imageSha256: sha256(image),
    addressSpace: 'code',
    addressSpaceSize,
    base: 0,
    end,
    length: image.length,
    dataBytes: data.size,
    gaps,
    minAddress,
    maxAddress,
    records,
    dataRecords,
    entry,
    eof,
    fill,
    bytes: image,
  });
}
