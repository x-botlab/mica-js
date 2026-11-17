import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSource, packagePath, sourceCandidates, sourcePaths } from './unified-paths';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mica-unified-paths-'));
  roots.push(root);
  return root;
}

describe('packagePath', () => {
  it('accepts package-root relative POSIX paths', () => {
    expect(packagePath('model.js', 'model.entry')).toBe('model.js');
    expect(packagePath('views/2d/index.js', 'view2d.entry')).toBe('views/2d/index.js');
  });

  it.each([
    ['', 'the path is empty'],
    ['/model.js', 'the path is absolute'],
    ['views\\index.html', 'package paths use forward slashes'],
    ['views/', 'the path names a directory'],
    ['views//index.html', 'the path contains an empty segment'],
    ['./model.js', "the path contains a '.' segment"],
    ['../model.js', "the path contains a '..' segment"],
    ['C:/model.js', 'the path contains a drive or URL separator'],
    ['https://example.com/a.js', 'the path contains a drive or URL separator'],
  ])('rejects %s', (path, reason) => {
    expect(() => packagePath(path, 'field')).toThrow(reason);
    expect(() => packagePath(path, 'field')).toThrow('Invalid field path');
  });
});

describe('sourceCandidates', () => {
  it('keeps the declared path first and accepts TypeScript siblings', () => {
    expect(sourceCandidates('model.js')).toEqual([
      'model.js',
      'model.ts',
      'model.tsx',
      'model.mts',
    ]);
    expect(sourceCandidates('views/panel.mjs')).toEqual(['views/panel.mjs', 'views/panel.mts']);
    expect(sourceCandidates('views/index.html')).toEqual(['views/index.html']);
  });

  it('resolves candidates inside the source directory only', async () => {
    const root = await fixture();
    expect(sourcePaths(root, 'views/2d/index.js')).toEqual([
      join(root, 'views', '2d', 'index.js'),
      join(root, 'views', '2d', 'index.ts'),
      join(root, 'views', '2d', 'index.tsx'),
      join(root, 'views', '2d', 'index.mts'),
    ]);
  });
});

describe('findSource', () => {
  it('maps a JavaScript artifact path onto the TypeScript source', async () => {
    const root = await fixture();
    await mkdir(join(root, 'views'), { recursive: true });
    await writeFile(join(root, 'views', 'panel.ts'), 'export default 1;');
    expect(await findSource(root, 'views/panel.js', 'view2d.entry')).toBe(
      join(root, 'views', 'panel.ts'),
    );
  });

  it('prefers the declared path when the source already uses it', async () => {
    const root = await fixture();
    await writeFile(join(root, 'model.js'), 'export const model = 1;');
    await writeFile(join(root, 'model.ts'), 'export const model = 2;');
    expect(await findSource(root, 'model.js', 'model entry')).toBe(join(root, 'model.js'));
  });

  it('reports the tried paths for a missing resource', async () => {
    const root = await fixture();
    await expect(findSource(root, 'views/missing.js', 'view2d.entry')).rejects.toThrow(
      "Cannot find the source of view2d.entry 'views/missing.js'",
    );
  });
});
