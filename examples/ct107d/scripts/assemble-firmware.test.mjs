import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assembleFirmware,
  encodeIntelHex,
  firmwareAssets,
  main,
  staleFirmwareAssets,
} from '../assemble-firmware.mjs';
import { parseIntelHex } from './firmware-hex.mjs';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(PROJECT, 'firmware', 'demo.asm'), 'utf8');

const asBuffer = (value) => Buffer.from(value);

test('formal BIN and HEX are strict-decode equivalent', () => {
  const { bytes } = assembleFirmware(SOURCE);
  const image = parseIntelHex(encodeIntelHex(bytes), { sourceName: 'generated.hex' });

  assert.deepEqual(asBuffer(image.bytes), asBuffer(bytes));
  assert.equal(image.length, bytes.length);
  assert.equal(image.dataBytes, bytes.length);
  assert.equal(image.gaps, 0);
});

test('checked-in assets match the generator and output is deterministic', () => {
  const assets = firmwareAssets(SOURCE);
  const again = firmwareAssets(SOURCE);

  assert.deepEqual(
    again.map((asset) => ({ path: asset.path, data: asBuffer(asset.data) })),
    assets.map((asset) => ({ path: asset.path, data: asBuffer(asset.data) })),
  );
  for (const asset of assets)
    assert.deepEqual(asBuffer(readFileSync(asset.path)), asBuffer(asset.data), asset.path);

  const { bytes } = assembleFirmware(SOURCE);
  assert.equal(encodeIntelHex(bytes), encodeIntelHex(bytes));
});

test('changing the assembly input changes both BIN and HEX', () => {
  const changed = SOURCE.replace('MOV R7,#0FEH', 'MOV R7,#0FCH');
  assert.notEqual(changed, SOURCE);

  const original = assembleFirmware(SOURCE).bytes;
  const mutated = assembleFirmware(changed).bytes;
  assert.notDeepEqual(asBuffer(mutated), asBuffer(original));

  const image = parseIntelHex(encodeIntelHex(mutated), { sourceName: 'mutated.hex' });
  assert.deepEqual(asBuffer(image.bytes), asBuffer(mutated));
});

test('HEX checksum covers 0x00/0xFF boundaries and record splits', () => {
  assert.equal(encodeIntelHex(Uint8Array.of(0x00)).split('\n')[0], ':0100000000FF');
  assert.equal(encodeIntelHex(Uint8Array.of(0xff)).split('\n')[0], ':01000000FF00');

  const bytes = Uint8Array.from({ length: 17 }, (_, index) => (index * 17) & 0xff);
  const lines = encodeIntelHex(bytes).trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].slice(1, 3), '10');
  assert.equal(lines[1].slice(1, 3), '01');
  assert.equal(lines[2], ':00000001FF');

  const image = parseIntelHex(encodeIntelHex(bytes), { sourceName: 'boundary.hex' });
  assert.deepEqual(asBuffer(image.bytes), asBuffer(bytes));
});

test('stale detection reports changed and missing assets without writing', () => {
  const assets = firmwareAssets(SOURCE);
  const expected = new Map(assets.map((asset) => [asset.path, asBuffer(asset.data)]));

  assert.deepEqual(
    staleFirmwareAssets(assets, (path) => expected.get(path)),
    [],
  );

  const changed = assets.at(-1).path;
  assert.deepEqual(
    staleFirmwareAssets(assets, (path) =>
      path === changed ? Buffer.from('stale') : expected.get(path),
    ),
    [changed],
  );

  assert.deepEqual(
    staleFirmwareAssets(assets, () => {
      throw new Error('missing');
    }),
    assets.map((asset) => asset.path),
  );

  const before = assets.map((asset) => asBuffer(readFileSync(asset.path)));
  assert.equal(main(['--check']), 0);
  assert.deepEqual(
    assets.map((asset) => asBuffer(readFileSync(asset.path))),
    before,
  );
  assert.equal(main(['--bogus']), 2);
});
