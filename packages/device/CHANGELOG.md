# @mica-js/device

## 0.2.0

### Minor Changes

- f6c9dac: 实现连接作者接口与 IR 接入（#57）：器件描述解析 #14 连接声明；`api.ir.connection(id)` 与 `b.connection.apply([{ connection, closed }])` 把建图时固定的对象列表降低为 `static-list` 连接引用与等长 bool SSA 列表；通过 `DeviceInstanceOptions.connections.topology` 绑定 core topology，在合法控制阶段以一份原子 patch 提交，支持普通/生命周期/嵌套块、SSA 按值捕获、稳定同刻顺序、未知/跨实例/非法 patch 诊断，以及冲突后不回滚已提交拓扑。IR 增加通用领域指令列表操作数与可信同步 `IRInstructionExecutor`，core `createIRSchedulerInstance` 可传入执行器。
- d699e7f: 实现话题与 IR 消息桥接（#54）：`api.subscribe/publish/post/postBytes/onOutput/updateBytes` 接入真实 `validateIR` → 参考解释器 → scheduler → device 生命周期链；新增 IR `output` / `outputBytes`、`bridge.send` / `bridge.send_bytes` 与宿主 `IRBridgeHost`，device 侧提供有界输出/输入/发布/更新队列、inbox 预留与释放、初始化暂存与激活顺序、`onTopic` 宿主回调及 `deliver`，并以 `BackpressureError` 和新增 `DeviceErrorCode` 报告背压与非法载荷/句柄/范围。Scheduler 增加不推进时间、不分配事件 ID 的普通消息入口与 `messageId`；`IRStorage` 增加宿主 inbox 写入与原子版本化字节更新。`TopicPayloadType` 随 `DevicePortDescriptor` 一起从包入口导出，宿主可以给端口类型命名。
- c5b688e: 实现数字边沿观察与捕获投递（#56）：`api.ir.observeDigital` 声明静态观察绑定，`b.observe.configure` 降低为 `observe.configure`（静态绑定、bool 启用位、u8 边沿编码 1/2/3）；链接期校验 trigger/capture 均为本实例 signal 引脚且目标 entry 签名恰为 `['u8', ...u32 × captures.length]`。device 按 #25 维护启用、边沿选择与基线，使用 #51 的解析阶段采样和门控结果，在首次启用、显式重配、门控恢复及浮空/待定区间后重建基线且不误报边沿；触发时按同一阶段快照固定 `[u8, ...u32]` 载荷，经 #54 的 `scheduler.enqueueMessage` 普通队列按声明顺序投递，不推进时间、不同步重入。core 新增 `PowerDigitalPinChange` / `PowerDigitalPinObserver` 与 `PowerRuntime.addDigitalPinObserver`，在多观察者注册顺序下 fail-fast 通知变化引脚。新增 `device/observe-pin`、`device/observe-binding`、`device/observe-config`、`device/observe-unavailable`；明确拒绝 `edges=0` 状态观察、模拟量、电压、get/set、组观察与任意比较器。
- dbf7d60: 实现引脚声明接入与数字 I/O 指令（#55）：解析 `pins` / `pinGroups`，新增 `api.ir.pin`、`b.pin.configure/writeDigital/sampleDigital` 与 `pin.configure/write_digital/sample_digital` 显式指令；链接期校验引脚类别、配置编码与宿主授权，经 `DeviceInstanceOptions.pinHost` 消费 #51 的持有意图、门控采样与恢复能力；初始状态提交、控制阶段可见性与销毁恢复均按已批准合同执行。IR 增加通用 `builderExtensions` 建图扩展，领域指令执行复用已合并的 `executors`；不实现观察、消息、电压/查询指令或组 I/O。
- 766a4d1: 新增 `DeviceInstanceOptions.updateResources`：宿主可按资源名单独授权只读 `bytes` 资源走 `api.updateBytes` 与 IR `resource.update_bytes` / `fill_bytes` 更新路径，`readonly` 仍只禁止客体普通写入。补充 #8/#26 教学 MCU 示例与 #62 集成验收：两字节合成 ISA、Provider 按 PC 生成基本块、8 B 版本单元、固件消息更新、checkpoint 不自修改重放，以及缺少固件/非法地址/非法指令/HALT 的明确行为。示例仅保证块边界可观察，不是真实 AVR/8051 ISA 或逐周期等价实现。
- a5d8ce5: 实现产物 checkpoint 与运行中失效恢复（#61）：生成函数构建器新增 `checkpoint(provider, key, args)`，在产物内标记合法恢复边界并检查当前产物的完整依赖；有效时继续，失效时丢弃旧产物剩余步骤并以当前 key/args 尾派发恢复目标，保留已提交存储/事件/输出/时间效果、当前入口预算与虚拟时间。恢复目标可为自身或 `imports` 中的 provider，结果布局必须一致；产物写入其生成读取的资源时，必须在该写入之后提供 checkpoint，否则仍以 `unsupported-provider` 拒绝。新增 `invalid-checkpoint` 诊断与 `recovery-failed` 运行期错误码；checkpoint 不固化生成产物，恢复按当前资源版本重新生成。只支持内存内实例恢复，不提供持久化快照、跨进程/跨实例迁移或 JIT/重放。
- 645e731: 实现 Provider 生成、依赖跟踪与缓存（#60）：`ir.provider` 声明固定 key/参数/结果布局、生成期受追踪读取与产物可引用引用；`gen.readBytes`/`readState`/`readArray` 登记实际覆盖的版本单元（state/array 使用整资源单元），产物经既有 `validateIR`、imports 白名单与解释器执行。`dispatch` 作为终结指令按规范化 key 复用或按需重生成产物，每次派发校验全部依赖，缓存按实例隔离。新增 `IRProviderError` 与可区分的声明/读取/生成/产物/依赖错误码；生成产物写入自身读依赖时明确拒绝（运行中恢复属于 #61）。device 的 `api.ir.provider` 与 core 的调度接入同步可用。

### Patch Changes

- Updated dependencies [9ea9858]
- Updated dependencies [f6c9dac]
- Updated dependencies [d699e7f]
- Updated dependencies [c5b688e]
- Updated dependencies [dbf7d60]
- Updated dependencies [a5d8ce5]
- Updated dependencies [645e731]
  - @mica-js/core@0.2.0
  - @mica-js/ir@0.2.0

## 0.1.0

### Minor Changes

- 69dc4b0: 实现器件工厂上下文与实例生命周期（#53）：`createDeviceInstance` 同步调用一次工厂，提供固定 `api.props` 与声明封闭的 `api.ir`，在真实 IR 校验/链接通过后安装实例并把 initialize 作为公共控制工作驱动；支持 reset、故障暂停、幂等 destroy 与清理后的 `onDispose`，并以受控 storage 句柄阻止销毁后访问。核心调度器允许在 `faulted` 状态下销毁仍存在的实例以完成队列与引用清理，但不恢复执行能力。

### Patch Changes

- Updated dependencies [69dc4b0]
  - @mica-js/core@0.1.1
