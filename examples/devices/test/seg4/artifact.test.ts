import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { adaptModelFactory } from '@mica-js/sdk/device';

/**
 * 交付产物用例：`pnpm test` 先执行 `mica build`，这里装载 `dist/<id>/` 里的 JS 与 JSON，
 * 保证真正交付的文件也能在真实仿真板上工作。直接 `vitest` 而没先构建时跳过。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..', '..');
const ARTIFACT_DIR = join(PACKAGE_DIR, 'dist', 'seg4');

interface ArtifactModule {
  readonly model: unknown;
  readonly create: unknown;
}

const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;

/** 静态板：段脚按掩码接 5 V / 0 V，选中位接 0 V，其余位接 5 V（共阴）。 */
async function staticDigits(
  mask: number,
  active: readonly number[],
  commonAnode = false,
): Promise<number[]> {
  const module = (await import(
    pathToFileURL(join(ARTIFACT_DIR, 'model.js')).href
  )) as ArtifactModule;
  const create = adaptModelFactory(module.create as never, {
    events: { onDidDisplayChange: 'display' },
  }) as unknown as (context: never) => {
    sync(batch: { outputs: Readonly<Record<string, readonly { value: unknown }[]>> }): void;
    dispose(): void;
  };
  const readings: Record<string, unknown> = {};
  const library = createDeviceLibrary([
    {
      id: 'display',
      model: module.model as never,
      create: ((context: never) => {
        const adapter = create(context);

        return {
          sync(batch: Parameters<typeof adapter.sync>[0]) {
            adapter.sync(batch);

            for (const [name, messages] of Object.entries(batch.outputs)) {
              const latest = messages[messages.length - 1];

              if (latest !== undefined) readings[name] = latest.value;
            }
          },
          dispose: () => adapter.dispose(),
        };
      }) as never,
    },
  ]);
  const nets = [
    ...SEGMENTS.map((pin, index) => {
      const lit = ((mask >> index) & 1) === 1;
      return {
        id: pin,
        pins: [{ instance: 'display', pin }],
        voltage: lit === commonAnode ? 0 : 5,
      };
    }),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `com${index + 1}`,
      pins: [{ instance: 'display', pin: `com${index + 1}` }],
      voltage: active.includes(index) === commonAnode ? 5 : 0,
    })),
  ];
  const board = createBoard(library, {
    instances: [
      { id: 'display', type: 'display', props: { forwardResistance: 1500, commonAnode } },
    ],
    nets,
  } as never);

  try {
    board.runUntil(1_000_000_000);
  } finally {
    board.dispose();
  }

  return [1, 2, 3, 4].map((index) => readings[`digit${index}`] as number);
}

describe.skipIf(!existsSync(join(ARTIFACT_DIR, 'model.js')))('交付产物', () => {
  it('package.json 与源码清单一致，交付物为 headless 模型', () => {
    const artifact = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'package.json'), 'utf8'));
    const source = JSON.parse(readFileSync(join(PACKAGE_DIR, 'seg4', 'package.json'), 'utf8'));

    expect(artifact).toEqual(source);
    expect(artifact.view2d).toBeUndefined();
    expect(existsSync(join(ARTIFACT_DIR, 'model.js'))).toBe(true);
  });

  it('model.js 能在真实板上锁存段码', async () => {
    expect(await staticDigits(0xff, [0])).toEqual([0xff, 0, 0, 0]);
    expect(await staticDigits(0x06, [2])).toEqual([0, 0, 0x06, 0]);
  });

  it('位脚为高时对应位不显示', async () => {
    expect(await staticDigits(0x81, [])).toEqual([0, 0, 0, 0]);
  });

  it('commonAnode 实例按共阳驱动码锁存点亮段', async () => {
    // 掩码是「点亮的段」：0x3F 对应固件写入共阳 latch 的 0xC0，0x00 对应 0xFF。
    expect(await staticDigits(0x3f, [0], true)).toEqual([0x3f, 0, 0, 0]);
    expect(await staticDigits(0x00, [1], true)).toEqual([0, 0, 0, 0]);
  });
});
