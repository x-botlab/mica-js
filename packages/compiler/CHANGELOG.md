# @mica-js/compiler

## 0.4.0

### Minor Changes

- 8439e45: 对全部可发布包统一推进一个 minor 版本，用一次发布会话走完 `release.yml` 的 OIDC 信任发布流程。

  - 每个包各发布一个新版本，使 npm trusted publishing 在 11 个包上逐一完成校验；此前 `@mica-js/scene-3d` 因包名在 registry 中不存在而无法走 OIDC，首次版本由人工发布补位。
  - `@mica-js/simulator` 的 2.1.1 在改动前未进入 registry，本次随 minor 推进覆盖该版本。
  - 本 changeset 只做版本推进，不包含源码或行为变更。

### Patch Changes

- Updated dependencies [8439e45]
  - @mica-js/device-model@0.6.0

## 0.3.0

### Minor Changes

- a935edb: 修复 direct JIT 的常量发射、select 展开和 IR 覆盖缺口。

  - 安全整数、布尔和 JSON 编码字符串直接生成源码字面量；`pc`、`nextPc` 和时长同样内联，减少常量数组 keyed access。
  - 纯值 `select` 生成三元表达式；含副作用或额外 `yield` 的分支保留标签块。
  - 支持 `load16le/be`、`load32le/be`、`store16le/be`、`store32le/be`、短路 `and`/`or` 和 `match`，并保持宿主相同的地址、取值校验顺序。
  - direct 程序可通过运行时 host 执行 `send`、`readSample`、`writeIntent`、`resistor`、`combineIntents`、`assert` 等操作；宿主调用前的片段时间会同步到板时。
  - 零时长 `elapse`/`redirect` 不再被拒绝：不推进时间，也不需要续点，服务块这类以 `elapse(0)` 结尾的指令因此能进入直接后端。
  - 超过 8 条指令的 direct 程序按「局部槽预算」生成分片函数（默认 1536 槽、最多 8 条一组），超大指令体单独成片；总槽量不超过 2048 的程序仍用单体函数。派发器进入 TurboFan。
  - STM32G431 基准新增真实 Thumb 固件、独立参考机、IR 覆盖统计和 V8 跟踪工具。

## 0.2.0

### Minor Changes

- New architecture for mica simulator and refactoring of editor package

### Patch Changes

- Updated dependencies
  - @mica-js/device-model@0.5.0
