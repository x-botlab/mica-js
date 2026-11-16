import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 动态装载源码统一模型工厂。
 *
 * 器件源码使用 `mica prepare` 生成的全局 `Device*` 类型；共享测试 tsconfig 不包含这些
 * 全局声明，因此通过变量说明符动态导入，避免把器件类型环境混进测试工程。
 */
export type SourceCreate = (context: never) => unknown;

let cache: Promise<SourceCreate> | undefined;

export function loadSourceCreate(): Promise<SourceCreate> {
  cache ??= import(
    pathToFileURL(join(import.meta.dirname, '..', '..', 'iap15f2k61s2', 'src', 'index.ts')).href
  ).then((module) => (module as { create: SourceCreate }).create);

  return cache;
}
