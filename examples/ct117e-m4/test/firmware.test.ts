import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFirmware } from './firmware';

/** 构造一条 Intel HEX 记录（含校验和）。 */
function record(kind: number, offset: number, data: readonly number[]): string {
  const bytes = [data.length, (offset >> 8) & 0xff, offset & 0xff, kind, ...data];
  let sum = 0;

  for (const value of bytes) sum += value;
  bytes.push(-sum & 0xff);

  return `:${bytes
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

function writeHex(...lines: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'mica-ct117e-m4-hex-'));
  const path = join(directory, 'image.hex');

  writeFileSync(path, `${lines.join('\n')}\n`, 'ascii');
  return path;
}

const VECTOR_TABLE = [0x00, 0x00, 0x01, 0x20, 0xed, 0x01, 0x00, 0x08];

function validLines(): string[] {
  return [
    record(4, 0, [0x08, 0x00]),
    record(0, 0, VECTOR_TABLE),
    record(5, 0, [0x08, 0x00, 0x01, 0xd9]),
    record(1, 0, []),
  ];
}

describe('Intel HEX 解析', () => {
  it('映射线性地址、条目地址与复位向量', () => {
    const image = loadFirmware(writeHex(...validLines()));

    expect(image.base).toBe(0x0800_0000);
    expect(image.end).toBe(0x0800_0008);
    expect(image.length).toBe(8);
    expect(image.dataBytes).toBe(8);
    expect(image.records).toBe(4);
    expect(image.dataRecords).toBe(1);
    expect(image.entry).toBe(0x0800_01d9);
    expect(image.resetVector).toBe(0x0800_01ed);
    expect([...image.bytes]).toEqual(VECTOR_TABLE);
  });

  it('接受同一地址重复写入相同字节', () => {
    const image = loadFirmware(
      writeHex(
        record(4, 0, [0x08, 0x00]),
        record(0, 0, VECTOR_TABLE),
        record(0, 0, VECTOR_TABLE),
        record(1, 0, []),
      ),
    );

    expect(image.dataBytes).toBe(8);
    expect(image.dataRecords).toBe(2);
  });

  it('拒绝坏校验和', () => {
    const line = record(0, 0, VECTOR_TABLE);
    const last = Number.parseInt(line.slice(-2), 16);
    const bad = `${line.slice(0, -2)}${((last + 1) & 0xff).toString(16).padStart(2, '0')}`;

    expect(() => loadFirmware(writeHex(record(4, 0, [0x08, 0x00]), bad, record(1, 0, [])))).toThrow(
      /checksum/,
    );
  });

  it('拒绝 Flash 范围外的数据', () => {
    expect(() =>
      loadFirmware(
        writeHex(record(4, 0, [0x08, 0x04]), record(0, 0, VECTOR_TABLE), record(1, 0, [])),
      ),
    ).toThrow(/outside MCU Flash/);
  });

  it('拒绝缺失 EOF', () => {
    expect(() => loadFirmware(writeHex(...validLines().slice(0, -1)))).toThrow(/EOF/);
  });

  it('拒绝冲突重叠', () => {
    expect(() =>
      loadFirmware(
        writeHex(
          record(4, 0, [0x08, 0x00]),
          record(0, 0, VECTOR_TABLE),
          record(0, 0, [0xff, ...VECTOR_TABLE.slice(1)]),
          record(1, 0, []),
        ),
      ),
    ).toThrow(/overlap/);
  });

  it('拒绝不支持的记录类型与畸形行', () => {
    expect(() =>
      loadFirmware(
        writeHex(
          record(4, 0, [0x08, 0x00]),
          record(0, 0, VECTOR_TABLE),
          record(6, 0, []),
          record(1, 0, []),
        ),
      ),
    ).toThrow(/Unsupported/);

    expect(() => loadFirmware(writeHex(':040000000000000', record(1, 0, [])))).toThrow(/Malformed/);
  });
});
