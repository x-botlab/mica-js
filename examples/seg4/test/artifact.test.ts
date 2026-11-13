import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { validateMetadata } from '@mica-js/sdk/metadata';

/**
 * 交付产物用例：`pnpm test` 先执行 `mica build`，这里装载 `dist/` 里的 JS 与 JSON，保证
 * 真正交付的文件也能在真实仿真板上工作。直接 `vitest` 而没先构建时跳过。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..');
const ARTIFACT_DIR = join(PACKAGE_DIR, 'dist', 'devices', 'seg4');

interface ArtifactModule {
  readonly model: unknown;
  readonly create: (context: unknown) => {
    sync(batch: { outputs: Readonly<Record<string, readonly { value: unknown }[]>> }): void;
    dispose(): void;
  };
}

const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;

/** 静态板：段脚按掩码接 5 V / 0 V，选中位接 0 V，其余位接 5 V（共阴）。 */
async function staticDigits(
  mask: number,
  active: readonly number[],
  commonAnode = false,
): Promise<number[]> {
  const module = (await import(
    pathToFileURL(join(ARTIFACT_DIR, 'device.js')).href
  )) as ArtifactModule;
  const readings: Record<string, unknown> = {};
  const library = createDeviceLibrary([
    {
      id: 'display',
      model: module.model as never,
      create: ((context: never) => {
        const adapter = module.create(context);

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

describe.skipIf(!existsSync(join(ARTIFACT_DIR, 'device.js')))('交付产物', () => {
  it('device.json 通过 SDK 校验且与源码一致', () => {
    const artifact = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'device.json'), 'utf8'));
    const source = JSON.parse(
      readFileSync(join(PACKAGE_DIR, 'src', 'devices', 'seg4', 'device.json'), 'utf8'),
    );

    expect(() => validateMetadata(artifact, 'device', 'seg4')).not.toThrow();
    expect(artifact).toEqual(source);
  });

  it('device.js 能在真实板上锁存段码', async () => {
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
