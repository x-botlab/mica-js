import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SchematicError } from '../format/errors';
import { parseSchematic } from '../schematic/format/parse-schematic';
import { parseSchematicWithAssets, validateSchematicAssets } from './schematic';

const ID = '00000001-41e6-4a4c-869a-82a4cd304787';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mica-assets-schematic-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function documentWith(properties: Record<string, unknown>) {
  return parseSchematic({
    version: 1,
    sheet: {
      symbols: [{ id: ID, device: 'pkg:a', x: 0, y: 0, rotation: 0, properties }],
      wires: [],
      junctions: [],
    },
  });
}

describe('validateSchematicAssets', () => {
  it('accepts file references that resolve inside the project', async () => {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'logo.png'), new Uint8Array([1, 2, 3]));

    const document = documentWith({
      logo: { src: 'assets/logo.png', mode: 'file' },
      note: 'text properties are not assets',
      inline: { src: 'aGk=', mode: 'inline' },
    });

    await expect(validateSchematicAssets(document, { rootDir: root })).resolves.toEqual([]);
  });

  it('reports a missing file at the property pointer', async () => {
    const document = documentWith({ logo: { src: 'assets/missing.png', mode: 'file' } });

    const diagnostics = await validateSchematicAssets(document, { rootDir: root });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('asset/missing');
    expect(diagnostics[0]?.pointer).toBe('/sheet/symbols/0/properties/logo');
    expect(diagnostics[0]?.severity).toBe('error');
  });

  it('resolves a repeated src once but reports every property that uses it', async () => {
    await writeFile(join(root, 'shared.png'), new Uint8Array([1]));
    let decodes = 0;
    const document = documentWith({
      logo: { src: 'shared.png', mode: 'file' },
      fallback: { src: 'shared.png', mode: 'file' },
    });

    const diagnostics = await validateSchematicAssets(document, {
      rootDir: root,
      decode: () => {
        decodes += 1;
        throw new Error('bad image header');
      },
    });

    expect(decodes).toBe(1);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'asset/undecodable',
      'asset/undecodable',
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.pointer)).toEqual([
      '/sheet/symbols/0/properties/logo',
      '/sheet/symbols/0/properties/fallback',
    ]);
  });

  it('surfaces a decoding failure as asset/undecodable', async () => {
    await writeFile(join(root, 'broken.png'), new Uint8Array([0xff, 0xfe]));
    const document = documentWith({ logo: { src: 'broken.png', mode: 'file' } });

    const diagnostics = await validateSchematicAssets(document, {
      rootDir: root,
      decode: () => {
        throw new Error('bad image header');
      },
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['asset/undecodable']);
  });
});

describe('parseSchematicWithAssets', () => {
  it('returns the document when every referenced file exists', async () => {
    await writeFile(join(root, 'fw.bin'), new Uint8Array([1]));
    const input = {
      version: 1,
      sheet: {
        symbols: [
          {
            id: ID,
            device: 'pkg:a',
            x: 0,
            y: 0,
            rotation: 0,
            properties: { firmware: { src: 'fw.bin', mode: 'file' } },
          },
        ],
        wires: [],
        junctions: [],
      },
    };

    const document = await parseSchematicWithAssets(input, { rootDir: root });

    expect(document.version).toBe(1);
  });

  it('throws SchematicError carrying the asset code', async () => {
    const input = {
      version: 1,
      sheet: {
        symbols: [
          {
            id: ID,
            device: 'pkg:a',
            x: 0,
            y: 0,
            rotation: 0,
            properties: { firmware: { src: 'missing.bin', mode: 'file' } },
          },
        ],
        wires: [],
        junctions: [],
      },
    };

    await expect(parseSchematicWithAssets(input, { rootDir: root })).rejects.toMatchObject({
      name: 'SchematicError',
      code: 'asset/missing',
    });
    await expect(parseSchematicWithAssets(input, { rootDir: root })).rejects.toBeInstanceOf(
      SchematicError,
    );
  });
});
