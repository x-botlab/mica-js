import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEMO_DOCUMENTS } from '../src/runtime-demo.ts';
import { copyCt107d, ct107dPreviewPlan } from '../scripts/components.mjs';

const DEVICE_IDS = [
  '74hc02',
  '74hc138',
  '74hc573',
  '74hc14',
  'at24c02',
  'buzzer',
  'cx20106a',
  'ds1302',
  'ds18b20',
  'jumper',
  'jumper-2x3',
  'lm386',
  'ne555',
  'pcf8591',
  'push-button',
  'relay',
  'uln2003',
  'ultrasonic',
  'uart-probe',
  'vs1838',
  'seg4',
  'blue-led',
  'iap15f2k61s2',
];

function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function fixture({ legacyDevices = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'playground-components-'));
  const source = join(root, 'examples', 'ct107d');
  write(
    join(source, 'legacy', 'source', 'ct107d.sch'),
    JSON.stringify({ version: 1, sheet: { symbols: [] } }),
  );
  write(
    join(source, 'legacy', 'source', 'ct107d.cnv'),
    JSON.stringify({ version: 1, schematic: 'ct107d.sch', widgets: [] }),
  );
  write(join(source, 'dist', 'widgets', 'button', 'widget.json'), '{}');
  write(join(source, 'assets', 'ct107d-board.webp'), 'image');
  if (legacyDevices) {
    for (const id of DEVICE_IDS) {
      write(join(source, 'dist', 'devices', id, 'device.json'), '{}');
      write(join(source, 'dist', 'devices', id, 'device.js'), 'export {};');
    }
  }
  return { root, source, artifacts: join(root, 'public', 'components') };
}

test('playground 不再把已迁移的 CT107D 旧画布列为可选文档', () => {
  assert.equal(
    DEMO_DOCUMENTS.some((document) => document.id === 'ct107d-canvas'),
    false,
  );
  assert.equal(
    DEMO_DOCUMENTS.some((document) => document.path.startsWith('components/ct107d/')),
    false,
  );
});

test('旧统一器件包不会被伪装成可运行的 legacy 预览', async () => {
  const { root, source, artifacts } = fixture();
  try {
    const plan = ct107dPreviewPlan(root);
    assert.equal(plan.available, false);
    assert.match(plan.reason, /统一器件包/);
    assert.match(plan.reason, /device\.json/);

    const result = await copyCt107d(artifacts, root);
    assert.equal(result.status, 'unavailable');
    const target = join(artifacts, 'ct107d');
    assert.equal(existsSync(join(target, 'devices')), false);
    assert.equal(existsSync(join(target, 'ct107d-digital-display.cnv')), false);
    assert.match(readFileSync(join(target, 'README.md'), 'utf8'), /workbench:dev/);
    assert.equal(existsSync(join(source, 'dist', 'devices')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy 输入齐全时从 legacy/source 和旧 device 目录复制预览', async () => {
  const { root, artifacts } = fixture({ legacyDevices: true });
  try {
    const result = await copyCt107d(artifacts, root);
    assert.equal(result.status, 'copied');
    const target = join(artifacts, 'ct107d');
    assert.equal(existsSync(join(target, 'devices', '74hc02', 'device.js')), true);
    assert.equal(existsSync(join(target, 'widgets', 'button', 'widget.json')), true);
    const canvas = JSON.parse(readFileSync(join(target, 'ct107d-digital-display.cnv'), 'utf8'));
    assert.equal(canvas.schematic, 'ct107d-digital-display.sch');
    assert.equal(existsSync(join(target, 'ct107d-digital-display.sch')), true);
    assert.equal(existsSync(join(target, 'README.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
