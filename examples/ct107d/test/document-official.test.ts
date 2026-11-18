import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveFusedTopology,
  parseFusedDocument,
  parseGeometry2D,
  parseStrictJson,
} from '@mica-js/document/fused';
import { openDevicePackage } from '@mica-js/sdk/fused';
import { readDirectoryPackage } from '@mica-js/sdk/fused/node';
import { describe, expect, it } from 'vitest';

const PROJECT = join(import.meta.dirname, '..');
const DOCUMENT_PATH = join(PROJECT, 'ct107d.sch');
const DEVICE_DIST = join(PROJECT, 'device', 'dist');
const DEVICE_ID = 'example:ct107d-board';
const INSTANCE_ID = '7d9e3a1c-5b2f-4c8d-9e01-2a3b4c5d6e7f';

function runDocument(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [join(PROJECT, 'scripts', 'document.mjs'), ...args], {
    cwd: PROJECT,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('formal CT107D v2 document', () => {
  it('has one stable board instance, real dependency lock and explicit rails', async () => {
    const document = parseFusedDocument(readFileSync(DOCUMENT_PATH, 'utf8'));
    expect(document.version).toBe(2);
    expect(document.instances).toHaveLength(1);
    const instance = document.instances[0]!;
    expect(instance.id).toBe(INSTANCE_ID);
    expect(instance.device).toBe(DEVICE_ID);
    expect(Object.keys(document.dependencies)).toEqual([DEVICE_ID]);

    const released = await readDirectoryPackage(DEVICE_DIST);
    expect(document.dependencies[DEVICE_ID]).toEqual({
      version: released.lock.version,
      integrity: released.lock.integrity,
    });

    const verified = await openDevicePackage({ open: async () => released }, released.lock);
    const firmware = instance.properties?.['firmware'];
    expect(firmware).toEqual({ mode: 'package', src: 'assets/seg7-dynamic.hex' });
    if (typeof firmware !== 'object' || firmware === null || !('src' in firmware)) {
      throw new Error('The board instance must reference firmware bytes from the package');
    }
    expect(typeof firmware.src).toBe('string');
    expect(verified.files).toHaveProperty(firmware.src);
    await verified.read(firmware.src);

    const geometryValue = verified.manifest.view2d?.geometry;
    expect(geometryValue).toBeDefined();
    const geometry =
      typeof geometryValue === 'string'
        ? parseGeometry2D(
            parseStrictJson(new TextDecoder().decode(await verified.read(geometryValue))),
            Object.keys(verified.manifest.pins ?? {}),
          )
        : parseGeometry2D(geometryValue, Object.keys(verified.manifest.pins ?? {}));
    expect(Object.keys(geometry.pins).sort()).toEqual(['GND', 'VCC']);
    expect(Object.keys(verified.manifest.pins ?? {}).sort()).toEqual(['GND', 'VCC']);

    const vcc = document.references.filter(
      (reference) => reference.target.kind === 'pin' && reference.target.pin === 'VCC',
    );
    const gnd = document.references.filter(
      (reference) => reference.target.kind === 'pin' && reference.target.pin === 'GND',
    );
    expect(vcc).toHaveLength(1);
    expect(vcc[0]).toMatchObject({ voltage: 5, symbol: 'power' });
    expect(gnd).toHaveLength(1);
    expect(gnd[0]).toMatchObject({ voltage: 0, symbol: 'ground' });

    const topology = deriveFusedTopology(document, new Map([[DEVICE_ID, verified.manifest]]));
    expect(topology.nets).toHaveLength(2);
    const railOf = (pin: string): number | undefined =>
      topology.nets.find((net) =>
        net.pins.some((member) => member.instance === INSTANCE_ID && member.pin === pin),
      )?.voltage;
    expect(railOf('VCC')).toBe(5);
    expect(railOf('GND')).toBe(0);
  });

  it('refuses to overwrite an edited document and refreshes only its lock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ct107d-document-'));
    const target = join(directory, 'ct107d.sch');
    try {
      const written = runDocument(['--write', '--out', target]);
      expect(written.status, written.stderr).toBe(0);
      const generated = parseFusedDocument(readFileSync(target, 'utf8'));
      const official = parseFusedDocument(readFileSync(DOCUMENT_PATH, 'utf8'));
      expect(generated.instances[0]?.properties?.['firmware']).toEqual(
        official.instances[0]?.properties?.['firmware'],
      );
      const edited = {
        ...generated,
        dependencies: {
          [DEVICE_ID]: { version: '0.0.1', integrity: `sha256:${'0'.repeat(64)}` },
        },
        display: { ...generated.display, designators: true },
      };
      writeFileSync(target, `${JSON.stringify(edited, null, 2)}\n`);

      const checked = runDocument(['--check', '--out', target]);
      expect(checked.status).toBe(1);
      expect(checked.stderr).toContain('locks');
      const beforeRefusedWrite = readFileSync(target, 'utf8');

      const refused = runDocument(['--write', '--out', target]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('Refusing to overwrite');
      expect(readFileSync(target, 'utf8')).toBe(beforeRefusedWrite);

      const refreshed = runDocument(['--refresh-lock', '--out', target]);
      expect(refreshed.status, refreshed.stderr).toBe(0);
      const raw = parseStrictJson(readFileSync(target, 'utf8'));
      expect(raw).toMatchObject({
        display: { designators: true },
        dependencies: { [DEVICE_ID]: { version: expect.any(String) } },
      });
      const finalDocument = parseFusedDocument(raw);
      expect(finalDocument.instances[0]?.id).toBe(INSTANCE_ID);
      expect(finalDocument.dependencies[DEVICE_ID]?.integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
