import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceModule } from '../harness.ts';
import { activeEvents, createHallFixture, isActive, setField } from './fixture.ts';

/**
 * hall 构建产物的行为验证。
 *
 * 清单/引脚/入口形状由聚合 `test/artifact.test.ts` 覆盖；这里只验证 `dist/hall/` 的
 * 模型仍能以外接上拉完成开漏吸合与释放，避免复制公共合同。
 */

const DIRECTORY = join(import.meta.dirname, '..', '..', 'dist', 'hall');

async function loadArtifact(): Promise<DeviceModule> {
  const manifest = JSON.parse(
    readFileSync(join(DIRECTORY, 'package.json'), 'utf8'),
  ) as DeviceModule['manifest'];
  const module = (await import(pathToFileURL(join(DIRECTORY, 'model.js')).href)) as {
    readonly model: DeviceModule['model'];
    readonly create: DeviceModule['create'];
  };
  return { ...module, manifest };
}

const artifact = existsSync(DIRECTORY) ? await loadArtifact() : undefined;

describe.skipIf(artifact === undefined)('hall 构建产物行为', () => {
  it('dist 模型能通过外部上拉开漏吸合和释放', async () => {
    if (artifact === undefined) throw new Error('missing dist/hall artifact');
    const board = await createHallFixture({ device: artifact });

    try {
      expect(isActive(board)).toBe(false);
      expect(board.probe('outProbe')).toBe(1);

      setField(board, 20);
      expect(isActive(board)).toBe(true);
      expect(board.probe('outProbe')).toBe(0);

      setField(board, 0);
      expect(isActive(board)).toBe(false);
      expect(board.probe('outProbe')).toBe(1);
      expect(activeEvents(board)).toEqual([false, true, false]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
