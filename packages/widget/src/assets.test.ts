import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileWidgetAssetProvider, readBinary, WidgetAssetError } from './assets';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mica-widget-assets-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readBinary', () => {
  it('returns the bytes of a project file', async () => {
    await writeFile(join(root, 'a.png'), new Uint8Array([1, 2, 3]));

    const bytes = await readBinary('a.png', root);

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('throws a WidgetAssetError with the stable code', async () => {
    await expect(readBinary('missing.png', root)).rejects.toMatchObject({
      name: 'WidgetAssetError',
      code: 'asset/missing',
      src: 'missing.png',
    });
    await expect(readBinary('missing.png', root)).rejects.toBeInstanceOf(WidgetAssetError);
  });
});

describe('createFileWidgetAssetProvider', () => {
  it('resolves file references through the project root', async () => {
    await writeFile(join(root, 'a.png'), new Uint8Array([7]));

    const provider = createFileWidgetAssetProvider({ rootDir: root });
    const bytes = await provider.resolve({ src: 'a.png', mode: 'file' });

    expect(Array.from(bytes)).toEqual([7]);
  });

  it('rejects inline and store references', async () => {
    const provider = createFileWidgetAssetProvider({ rootDir: root });

    await expect(provider.resolve({ src: 'aGk=', mode: 'inline' })).rejects.toThrow(
      /only resolves "file" references/,
    );
    await expect(provider.resolve({ src: 'builtin:icon', mode: 'store' })).rejects.toThrow(
      /only resolves "file" references/,
    );
  });
});
