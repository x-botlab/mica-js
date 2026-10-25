---
'@mica-js/simulator': minor
---

新增原理图编译、topic 路由与 `DeviceSimExecutor` 适配器（U05–U07），让新 JIT 引擎可以直接跑一张 `.sch`，并用旧接口与 Playground / widget host 对接。

- `compileSchematicToCircuit(document, provider, options?)`：从 `IDeviceProvider` 读取器件包描述，输出 `{ input, rails, diagnostics, devices }`。符号 → 器件（位号作器件 id，重复时追加 `_2`；`builtin:power`/`builtin:ground`/`builtin:label`/`builtin:text` 不实例化）、导线 + junction → 引脚连接、器件属性 → `config`。器件缺失、属性非法、轨冲突全部进 `diagnostics`，不抛异常。
- 电平轨由图纸推断而不是写死：`builtin:power` 用 `symbol.net`（缺省 `3V3`）为高电平，`builtin:ground` 只接受 `GND`（缺省 `GND`）为低电平；地符号用其它网名、电源符号用 `GND` 都会报错。
- Topic 端口：`description.ports` 的输出端口编译成 IR `bridge.send` 端点，输入端口编译成 IR 入口。器件行为里用 `api.topics.publish(port, [value])` / `api.topics.subscribe(port, handler)`；`Circuit.deliverTopic(symbol, port, payload)` 同步投递，`Circuit.onPublish(listener)` 收到 `DevicePublish`，`Circuit.topics` 列出全部端点。
- `toIRArgs` / `fromIRArgs`：boolean、number、vec2d、vec3d、string、bytes/bytes<rgb565>/bytes<segments> 与 IR 标量的双向编码；字符串与字节载荷按 `u32` 长度 + 4 字节 word 传输，上限 32 字节，超限报 `invalid-topic-payload`。
- `createCircuitExecutor(options)`：在 `Circuit` 上实现 `DeviceSimExecutor`（`getState`/`getSimTime`/`getSchematic`/`getTopics`/`loadSchematic`/`advance`/`onPublish`/`deliver`/`reset`/`dispose`）。1 tick = 1 µs（`TICK_PS`），`advance` 即一次 `runBatch`，`deliver` 延迟到下一次 `advance` 开始时投递，失败加载不会替换正在运行的电路；多一个可选 `resolveDevice` 用于把器件包绑定到带 IR 行为的类型。
- 新增 `schematic-compiler.test.ts`（17 例）、`topics.test.ts`（17 例）与 `circuit-executor-adapter.test.ts`（15 例）。
