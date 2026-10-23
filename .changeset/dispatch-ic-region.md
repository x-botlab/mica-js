---
'@mica-js/ir': minor
---

新增 JIT Provider 派发内联缓存、checkpoint 快路径与热链区域编译（#154）：

- `jit/dispatch-ic.ts`：每个 dispatch 站点维护 1–4 项单态/多态 IC，守卫为规范化 key 相等 + storage 依赖纪元 + provider 缓存纪元；未命中依次查询每 Provider 4096 项直接映射跳转缓存（单 u32 key 用 `(k ^ (k >>> 12)) & 4095`，其余 FNV-1a），最后才走 `materialize`。float key 以 `Object.is` 比较，`NaN` 命中、`±0` 区分，与 `normalizeKey` 的位串身份一致。
- checkpoint 快路径：产物状态记录 `validatedEpoch`，纪元未变时跳过依赖 WeakMap 遍历；IC 命中与 `materialize` 返回后都会刷新该纪元。
- `jit/region.ts` + 区域代码生成：某产物进入次数达到 500 后，沿 IC 转移计数最高的后继做 DFS 收集至多 32 个同 Provider 成员，编入同一个 JS 状态机；成员间派发变为 `cur = j; continue`（单 u32 key 生成 `switch`），客体自环变为普通 JS 循环，未命中仍走通用 `materialize` 并在结果恰为成员时留在区域内。区域只占一帧，指令位置、`functionIndex`、步数与错误调用栈保持参考语义。
- `IRJITTuning.optimizations` 新增 `dispatchIC`、`checkpointFast`、`regions`（别名 `region-compile`）开关；默认全部开启，可逐项关闭并用现有 pass matrix 对拍。
- `dispatch-ic.test.ts` 与 `region.test.ts` 覆盖 key 身份、跳转缓存冲突、IC 轮转与纪元失效、区域形成/自环/重新生成与步预算边界。
