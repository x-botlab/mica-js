import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIntelHex } from './firmware-hex.mjs';

function record(type, offset, data, { badChecksum = false } = {}) {
  const body = Buffer.from(data);
  const head = Buffer.from([body.length, (offset >> 8) & 0xff, offset & 0xff, type]);
  const sum = [...head, ...body].reduce((total, value) => total + value, 0);
  const checksum = badChecksum ? ((256 - (sum % 256)) % 256) ^ 0xff : (256 - (sum % 256)) % 256;
  return `:${Buffer.concat([head, body, Buffer.from([checksum])])
    .toString('hex')
    .toUpperCase()}`;
}

const eof = record(1, 0, []);

test('strict Intel HEX: data, gap fill, hashes and EOF', () => {
  const image = parseIntelHex(
    [record(0, 0, [0x02, 0x00, 0x00]), record(0, 0x10, [0xaa, 0xbb]), eof].join('\n') + '\n',
    { sourceName: 'gap.hex' },
  );
  assert.equal(image.length, 0x12);
  assert.equal(image.dataBytes, 5);
  assert.equal(image.gaps, 1);
  assert.equal(image.bytes[0], 0x02);
  assert.equal(image.bytes[0x10], 0xaa);
  assert.equal(image.bytes[0x11], 0xbb);
  assert.equal(image.bytes[0x0f], 0xff);
  assert.equal(image.eof, true);
  assert.match(image.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(image.imageSha256, /^[0-9a-f]{64}$/);
});

test('strict Intel HEX: types 02/03/04/05 are parsed and checked', () => {
  const image = parseIntelHex(
    [
      record(0, 0, [0x02, 0x00, 0x00]),
      record(2, 0, [0x01, 0x00]),
      record(0, 0x10, [0x5a, 0x5b]),
      record(4, 0, [0x00, 0x00]),
      record(0, 0x20, [0x99]),
      record(5, 0, [0x00, 0x00, 0x01, 0x00]),
      eof,
    ].join('\n'),
  );
  assert.equal(image.bytes[0x1010], 0x5a);
  assert.equal(image.bytes[0x1011], 0x5b);
  assert.equal(image.bytes[0x20], 0x99);
  assert.equal(image.entry, 0x100);
});

test('strict Intel HEX: bad checksum, missing EOF, record after EOF, malformed payload', () => {
  assert.throws(
    () => parseIntelHex([record(0, 0, [1, 2, 3], { badChecksum: true }), eof].join('\n')),
    /checksum mismatch/,
  );
  assert.throws(() => parseIntelHex(record(0, 0, [1, 2, 3])), /missing the EOF record/);
  assert.throws(
    () => parseIntelHex([record(0, 0, [1, 2, 3]), eof, record(0, 4, [4])].join('\n')),
    /record after EOF/,
  );
  assert.throws(() => parseIntelHex(':123\n'), /malformed HEX payload/);
  assert.throws(() => parseIntelHex(':00\n'), /too short/);
});

test('strict Intel HEX: length, type, address range and overlap checks', () => {
  assert.throws(() => parseIntelHex([':04000000AABB', eof].join('\n')), /does not match count/);
  assert.throws(
    () => parseIntelHex([record(0, 0, [0]), record(6, 0, []), eof].join('\n')),
    /unsupported HEX record type 6/,
  );
  assert.throws(
    () =>
      parseIntelHex(
        [record(0, 0, [0]), record(4, 0, [0x00, 0x10]), record(0, 0, [0]), eof].join('\n'),
      ),
    /outside the 61440-byte code space/,
  );
  assert.throws(
    () => parseIntelHex([record(0, 0, [0, 1]), record(0, 1, [1]), eof].join('\n')),
    /overlapping HEX data/,
  );
  assert.throws(
    () => parseIntelHex([record(0, 0, [0, 1]), record(0, 1, [2]), eof].join('\n')),
    /identical|conflicting/,
  );
  assert.throws(
    () => parseIntelHex([record(0, 0, [0]), record(1, 1, []), eof].join('\n')),
    /malformed HEX EOF/,
  );
  assert.throws(
    () => parseIntelHex([record(0, 0, [0]), record(2, 0, [1]), eof].join('\n')),
    /malformed HEX segment-address/,
  );
});

test('strict Intel HEX: reset vector and minimum size are required', () => {
  assert.throws(
    () => parseIntelHex([record(0, 0x10, [1, 2, 3]), eof].join('\n')),
    /does not cover the 8051 reset vector/,
  );
  const image = parseIntelHex([record(0, 0, [0, 0, 0]), eof].join('\n'));
  assert.equal(image.length, 3);
  assert.equal(image.maxAddress, 2);
});
