import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 聚合测试的器件发现规则。
 *
 * 目录本身是唯一清单：除已知非器件目录外，任何带 `package.json` 的子目录都必须能
 * 解析成完整器件清单。缺少字段、JSON 损坏或身份不完整的项目直接让测试失败，不再
 * 通过 catch / filter 静默消失。
 */

const ROOT = join(import.meta.dirname, '..');

const NON_DEVICE_DIRECTORIES = new Set([
  'bench',
  'dist',
  'docs',
  'node_modules',
  'scripts',
  'shared',
  'test',
  'views',
]);

/**
 * 由 test/<id>/ 的专项用例覆盖，且不满足 manifest.test.ts 的简单合同边界：
 * - iap15f2k61s2 / stm32g431rbt6：MCU 内核、固件与交付产物；
 * - seg4：四个 digit 输出通道合成为一个 onDidDisplayChange；
 * - ili9325：frameInfo / frameRows 两个输出通道合成为一个 onDidFrame。
 *
 * 新增排除项必须同时存在对应专项测试和明确合同差异，不能用排除来掩盖遗漏。
 */
export const SPECIALIZED_DEVICE_IDS: ReadonlySet<string> = new Set([
  'iap15f2k61s2',
  'stm32g431rbt6',
  'ili9325',
  'seg4',
]);

const REQUIRED_STRING_FIELDS = ['publisher', 'name', 'version', 'displayName'] as const;

type JsonObject = Readonly<Record<string, unknown>>;

function readManifest(directory: string): JsonObject {
  const path = join(ROOT, directory, 'package.json');
  let source: string;

  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取器件项目 ${path} 的 package.json：${reason}`, { cause: error });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法解析器件项目 ${path} 的 package.json：${reason}`, { cause: error });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`器件项目 ${path} 的 package.json 必须是 JSON 对象`);
  }

  return parsed as JsonObject;
}

function nonEmptyString(manifest: JsonObject, key: string): string | undefined {
  const value = manifest[key];

  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function assertDeviceManifest(directory: string, manifest: JsonObject): void {
  const missing: string[] = REQUIRED_STRING_FIELDS.filter(
    (key) => nonEmptyString(manifest, key) === undefined,
  );
  const engines = manifest.engines;

  if (
    engines === null ||
    typeof engines !== 'object' ||
    Array.isArray(engines) ||
    nonEmptyString(engines as JsonObject, 'mica') === undefined
  ) {
    missing.push('engines.mica');
  }

  if (missing.length > 0) {
    throw new Error(
      `器件项目 ${join(ROOT, directory)} 的清单缺少必填字段：${missing.join(', ')}；` +
        '如果它不是器件项目，请加入 test/device-projects.ts 的 NON_DEVICE_DIRECTORIES。',
    );
  }
}

function discoverDeviceIds(): string[] {
  const ids: string[] = [];

  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || NON_DEVICE_DIRECTORIES.has(entry.name)) continue;
    if (!existsSync(join(ROOT, entry.name, 'package.json'))) continue;

    const manifest = readManifest(entry.name);

    assertDeviceManifest(entry.name, manifest);
    ids.push(entry.name);
  }

  return ids.sort();
}

/** 适用统一清单/产物合同的简单器件；专项器件仍由各自目录的用例覆盖。 */
export const SIMPLE_DEVICE_IDS: readonly string[] = discoverDeviceIds().filter(
  (id) => !SPECIALIZED_DEVICE_IDS.has(id),
);
