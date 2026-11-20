/** 一段可执行代码区域的 logical 基址与大小；`code` 视图是该区域的局部字节。 */
export interface CodeRegion {
  readonly base: number;
  readonly size: number;
}

/** 旧 Flash 单视图兼容窗口；新 region 调用不使用这个 mask。 */
export const LEGACY_CODE_MASK = 0x1ffff;

/**
 * logical 地址到 region-local byte offset。
 *
 * `region` 省略时保持旧行为：Flash 0x00000000/0x08000000 两个别名共用一个
 * `code` 视图，按低 17 位索引。显式 region 时严格使用 `address - base`，
 * 不做任何对齐巧合假设。
 */
export function codeLocalOffset(
  region: CodeRegion | undefined,
  address: number,
): number | undefined {
  if (region === undefined) return (address >>> 0) & LEGACY_CODE_MASK;

  const base = region.base >>> 0;
  const target = address >>> 0;

  if (target < base) return undefined;
  const offset = target - base;

  return offset < region.size ? offset : undefined;
}
