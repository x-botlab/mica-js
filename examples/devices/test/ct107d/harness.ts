export * from '../harness.ts';

import { createTestBoard, US } from '../harness.ts';

/**
 * 初始输出快照用例的兼容入口：用新事件/查询夹具跑一颗悬空器件一次。
 *
 * 返回的 `publishes` 是适配器事件按旧字段名归档的最后值；不再经过旧 `simulation-runtime`
 * 的 topic 发布路径，因此也不再产生 `device/output-failed`。
 */
export async function runRuntimeOnce(
  id: string,
  durationPs = US,
): Promise<{
  publishes: Readonly<Record<string, unknown>>;
  diagnostics: readonly { readonly code: string }[];
}> {
  const board = await createTestBoard(id, { nets: [] });

  try {
    board.run(durationPs);
    if (board.faults.length > 0) throw new Error(`${id}: ${board.faults.join('; ')}`);
    return { publishes: board.topics, diagnostics: [] };
  } finally {
    board.dispose();
  }
}
