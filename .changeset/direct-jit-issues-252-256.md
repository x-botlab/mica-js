---
'@mica-js/compiler': minor
'@mica-js/simulator': patch
---

修复 direct JIT 的常量发射、select 展开和 IR 覆盖缺口。

- 安全整数、布尔和 JSON 编码字符串直接生成源码字面量；`pc`、`nextPc` 和时长同样内联，减少常量数组 keyed access。
- 纯值 `select` 生成三元表达式；含副作用或额外 `yield` 的分支保留标签块。
- 支持 `load16le/be`、`load32le/be`、`store16le/be`、`store32le/be`、短路 `and`/`or` 和 `match`，并保持宿主相同的地址、取值校验顺序。
- direct 程序可通过运行时 host 执行 `send`、`readSample`、`writeIntent`、`resistor`、`combineIntents`、`assert` 等操作；宿主调用前的片段时间会同步到板时。
- 超过 128 条指令的 direct 程序按 48 条一组生成分片函数，派发器进入 TurboFan；小固件继续使用单体函数。
- STM32G431 基准新增真实 Thumb 固件、独立参考机、IR 覆盖统计和 V8 跟踪工具。
