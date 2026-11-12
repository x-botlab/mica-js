# @mica-js/compiler

## 0.5.0

### Minor Changes

- 5dbada1: 降低 direct JIT 的执行与代码规模开销，并把忙等环交给运行时折叠。

  - 直编发射器按活跃区间复用局部槽：一条指令体的上千个临时值现在共享十几个槽。外设写块的生成源码从 93 KB 降到 35 KB、声明寄存器从 1441 降到 15，单次执行 1.1 μs → 0.1 μs；带 16 脚 intent 树的服务块 1.9 μs → 0.6 μs。
  - 分片预算改用生成的源码字符数（单片 36 KB、单体上限 48 KB）。V8 的可优化规模取决于函数体积而不是槽数，槽数压缩后按旧阈值会把整份程序退化成单体大函数。
  - 条件检查（`if`/`select`/`and`/`or`/`assert`）内联 `typeof` 判断，非布尔值才调用 `H.checkBoolean`。
  - `elapse` 接受运算得到的时长：动态时长保留槽位，在操作所在位置经 `H.checkDuration` 校验后使用，与 generator 后端一致。
  - `JitOptions.delays` 声明寄存器递减型忙等环（`subs`/`bne`）。运行时在环头按剩余推进窗口取整折叠轮次，越过窗口时仍逐轮执行，不越过推进目标与下一事件。
  - 器件侧：32/16 位访存改用 `load32le`/`store32le` 一类的宽操作（一次按宽度校验，而不是每字节一次）；GPIO 配置寄存器（MODER/OTYPER/PUPDR/AFR）在 state 里维护影子，引脚意图只读 state，写寄存器时写穿到寄存器映像。

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
