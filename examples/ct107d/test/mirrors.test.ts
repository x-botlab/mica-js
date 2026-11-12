import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 镜像一致性：`seg4`、`blue-led`、`iap15f2k61s2` 在本包 `src/devices/` 下各有一份副本，
 * 同时又是 `examples/` 下的独立源工程（带自己的测试与基准）。两份内容一旦漂移，
 * 整板预览用的就是旧模型，因此这里逐文件比对。
 *
 * 兄弟工程不存在时跳过：本包被单独取走时应仍能构建与测试。
 */

const DEVICE_ROOT = join(import.meta.dirname, '..', 'src', 'devices');
const EXAMPLES_ROOT = join(import.meta.dirname, '..', '..');

const MIRRORS = ['seg4', 'blue-led', 'iap15f2k61s2'] as const;

function files(directory: string, root = directory): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    // `mica prepare` 生成的类型投影与构建无关，不参与比对。
    if (entry.name.endsWith('.d.ddl.ts')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...files(path, root));
    else result.push(relative(root, path).replaceAll('\\', '/'));
  }
  return result.sort();
}

describe('独立源工程镜像', () => {
  for (const id of MIRRORS) {
    const mirror = join(DEVICE_ROOT, id);
    const source = join(EXAMPLES_ROOT, id, 'src', 'devices', id);

    it.skipIf(!existsSync(source))(`${id} 与 examples/${id} 逐文件一致`, () => {
      const expected = files(source);
      expect(files(mirror)).toEqual(expected);

      for (const file of expected) {
        expect(
          readFileSync(join(mirror, file), 'utf8'),
          `${id}/${file} 与 examples/${id}/src/devices/${id}/${file} 不一致`,
        ).toBe(readFileSync(join(source, file), 'utf8'));
      }
    });
  }
});
