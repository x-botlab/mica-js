import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * CT117E-M4 参考固件的默认 HEX 路径。
 *
 * 与实际固件夹具共用 `examples/stm32g431rbt6/bench`，避免同一映像维护两份。
 * 这是测试夹具：测试把 HEX 严格解析成 `0x08000000` 起的 Flash 映像后作为
 * `firmware` 属性传入。构建产物和器件运行时从不读取文件系统。
 */
export const DEFAULT_FIRMWARE_HEX = resolve(
  import.meta.dirname,
  '..',
  '..',
  'stm32g431rbt6',
  'bench',
  'HAL_06_LCD.hex',
);

/** STM32G431RBT6 的 Flash 映射。 */
export const FLASH_BASE = 0x0800_0000;
export const FLASH_SIZE = 0x2_0000;

export interface FirmwareImage {
  readonly path: string;
  /** 从 `FLASH_BASE` 开始的 Flash 映像，未覆盖的字节填 `0xff`。 */
  readonly bytes: Uint8Array;
  readonly length: number;
  readonly sourceSha256: string;
  readonly imageSha256: string;
  readonly base: number;
  /** 最高已写入地址的下一个地址（不含）。 */
  readonly end: number;
  /** 数据记录实际写入的唯一字节数；等于 `length` 时没有空洞。 */
  readonly dataBytes: number;
  readonly records: number;
  readonly dataRecords: number;
  /** Intel HEX 的 start-linear-address / start-segment-address，若存在。 */
  readonly entry: number | undefined;
  /** Flash 偏移 4 处的复位向量。 */
  readonly resetVector: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 严格解析 Intel HEX，并映射到 STM32G431RBT6 的 128 KiB Flash。
 *
 * 校验记录格式、长度、校验和、EOF、地址范围和重叠冲突；不猜测、不跳过坏记录。
 */
export function loadFirmware(
  path = process.env.MICA_CT117E_M4_HEX ?? DEFAULT_FIRMWARE_HEX,
): FirmwareImage {
  const file = resolve(path);
  let source: Buffer;

  try {
    source = readFileSync(file);
  } catch (cause) {
    throw new Error(
      `CT117E-M4 firmware HEX not found: ${file}; set MICA_CT117E_M4_HEX or add the fixture`,
      { cause },
    );
  }

  const text = source.toString('utf8');
  const data = new Map<number, number>();
  let currentBase = 0;
  let eof = false;
  let records = 0;
  let dataRecords = 0;
  let entry: number | undefined;
  let maxAddress = -1;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.length === 0) continue;
    if (eof) throw new Error('HEX image contains a record after EOF');
    if (!line.startsWith(':')) throw new Error(`Malformed HEX record: ${line.slice(0, 16)}`);

    const hex = line.slice(1);

    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex))
      throw new Error(`Malformed HEX record: ${line.slice(0, 16)}`);

    const record = Buffer.from(hex, 'hex');

    if (record.length < 5) throw new Error(`HEX record is too short: ${line.slice(0, 16)}`);

    const count = record[0]!;

    if (record.length !== count + 5) throw new Error('HEX record length does not match its count');
    if (record.reduce((sum, value) => sum + value, 0) % 256 !== 0)
      throw new Error('HEX record checksum mismatch');

    const offset = record.readUInt16BE(1);
    const kind = record[3]!;
    const body = record.subarray(4, 4 + count);

    records += 1;

    switch (kind) {
      case 0: {
        dataRecords += 1;
        for (let index = 0; index < count; index += 1) {
          const address = currentBase + offset + index;

          if (address < FLASH_BASE || address >= FLASH_BASE + FLASH_SIZE)
            throw new Error(`HEX data outside MCU Flash: 0x${address.toString(16)}`);

          const value = body[index]!;
          const previous = data.get(address);

          if (previous !== undefined && previous !== value)
            throw new Error(`Conflicting HEX overlap at 0x${address.toString(16)}`);

          data.set(address, value);
          if (address > maxAddress) maxAddress = address;
        }
        break;
      }
      case 1:
        if (count !== 0 || offset !== 0) throw new Error('Malformed HEX EOF record');
        eof = true;
        break;
      case 2:
        if (count !== 2 || offset !== 0) throw new Error('Malformed HEX segment-address record');
        currentBase = body.readUInt16BE(0) * 16;
        break;
      case 3:
        if (count !== 4 || offset !== 0) throw new Error('Malformed HEX start-segment record');
        entry = body.readUInt16BE(0) * 16 + body.readUInt16BE(2);
        break;
      case 4:
        if (count !== 2 || offset !== 0) throw new Error('Malformed HEX linear-address record');
        currentBase = body.readUInt16BE(0) * 0x1_0000;
        break;
      case 5:
        if (count !== 4 || offset !== 0) throw new Error('Malformed HEX start-linear record');
        entry = body.readUInt32BE(0);
        break;
      default:
        throw new Error(`Unsupported HEX record type ${kind}`);
    }
  }

  if (!eof) throw new Error('HEX image is missing the EOF record');
  if (data.size === 0) throw new Error('HEX image contains no data records');
  if (!data.has(FLASH_BASE)) throw new Error('HEX image does not cover the reset vector');

  const end = maxAddress + 1;

  if (end - FLASH_BASE < 8) throw new Error('HEX image is too small for a vector table');

  const bytes = new Uint8Array(end - FLASH_BASE).fill(0xff);

  for (const [address, value] of data) bytes[address - FLASH_BASE] = value;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    path: file,
    bytes,
    length: bytes.length,
    sourceSha256: sha256(source),
    imageSha256: sha256(bytes),
    base: FLASH_BASE,
    end,
    dataBytes: data.size,
    records,
    dataRecords,
    entry,
    resetVector: view.getUint32(4, true),
  };
}
