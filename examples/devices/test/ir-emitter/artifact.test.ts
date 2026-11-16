import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeviceModule } from '../harness.ts';
import { carrierEvents, createEmitterFixture, isCarrier, setSource } from './fixture.ts';

/**
 * ir-emitter 构建产物的行为验证。
 *
 * 清单/引脚/入口形状由聚合 `test/artifact.test.ts` 覆盖；这里只验证 `dist/ir-emitter/`
 * 的模型仍能按 mod 引脚门控 carrier，并在 VCC 掉电时关闭，避免复制公共合同。
 */

const DIRECTORY = join(import.meta.dirname, '..', '..', 'dist', 'ir-emitter');

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

describe.skipIf(artifact === undefined)('ir-emitter 构建产物行为', () => {
  it('dist 模型能按 mod 门控 carrier，并在掉电时关闭', async () => {
    if (artifact === undefined) throw new Error('missing dist/ir-emitter artifact');
    const board = await createEmitterFixture({ device: artifact });

    try {
      expect(isCarrier(board)).toBe(false);

      setSource(board, 'vccDrv', true);
      setSource(board, 'modDrv', true);
      expect(isCarrier(board)).toBe(true);

      setSource(board, 'vccDrv', false);
      expect(isCarrier(board)).toBe(false);

      setSource(board, 'vccDrv', true);
      expect(isCarrier(board)).toBe(true);
      expect(carrierEvents(board)).toEqual([false, true, false, true]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
