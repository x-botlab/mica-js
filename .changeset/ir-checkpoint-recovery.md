---
'@mica-js/ir': minor
'@mica-js/device': minor
---

实现产物 checkpoint 与运行中失效恢复（#61）：生成函数构建器新增 `checkpoint(provider, key, args)`，在产物内标记合法恢复边界并检查当前产物的完整依赖；有效时继续，失效时丢弃旧产物剩余步骤并以当前 key/args 尾派发恢复目标，保留已提交存储/事件/输出/时间效果、当前入口预算与虚拟时间。恢复目标可为自身或 `imports` 中的 provider，结果布局必须一致；产物写入其生成读取的资源时，必须在该写入之后提供 checkpoint，否则仍以 `unsupported-provider` 拒绝。新增 `invalid-checkpoint` 诊断与 `recovery-failed` 运行期错误码；checkpoint 不固化生成产物，恢复按当前资源版本重新生成。只支持内存内实例恢复，不提供持久化快照、跨进程/跨实例迁移或 JIT/重放。
