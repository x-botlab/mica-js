import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProgramDirectory } from './node';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mica-program-files-'));
  roots.push(root);
  await mkdir(join(root, 'program', 'lib'), { recursive: true });
  await writeFile(join(root, 'program', 'main.py'), 'import lib.helper');
  await writeFile(join(root, 'program', 'lib', 'helper.py'), 'value = 42');
  return root;
}

describe('readProgramDirectory', () => {
  it('reads only the chosen root and preserves relative file names and bytes', async () => {
    const root = await fixture();
    await writeFile(join(root, 'private.txt'), 'outside');
    const files = await readProgramDirectory(root, 'program');
    expect(files.map((file) => file.path)).toEqual(['lib/helper.py', 'main.py']);
    expect(new TextDecoder().decode(files[0]?.data)).toBe('value = 42');
    await expect(readProgramDirectory(root, '../program')).rejects.toMatchObject({
      code: 'program/invalid-path',
    });
  });

  it('rejects linked roots and linked descendants instead of following them', async () => {
    const root = await fixture();
    await symlink(join(root, 'program'), join(root, 'linked'), 'junction');
    await expect(readProgramDirectory(root, 'linked')).rejects.toMatchObject({
      code: 'program/source-resolve-failed',
    });
    await symlink(join(root, 'program', 'lib'), join(root, 'program', 'linked'), 'junction');
    await expect(readProgramDirectory(root, 'program')).rejects.toMatchObject({
      code: 'program/source-resolve-failed',
    });
  });
});
