# @mica-js/sdk

## 0.7.0

### Minor Changes

- 794f541: Add opt-in scheduler-bounded batch execution for device processes and JIT loops.

  - `@mica-js/compiler`: prove process and JIT loop batch plans from validated IR, including the process loop-to-resume-block mapping consumed by the simulator.
  - `@mica-js/simulator`: add `BoardOptions.batchExecution` (default `false`), `DeviceContext.registerProcessBatch` with `ProcessBatchRegistration`, and `JitTranslateInput.markBatchLoop` with `JitBatchMark`. Prepared simulation loads validate the scalar switch, forward it to the board and keep it across reset.
  - `@mica-js/sdk`: re-export the batch declaration types from the device entry and accept the forwarded `batchExecution` switch in `HeadlessRuntimeOptions`. Fused `ModelBinding` forwards `registerProcessBatch` to the simulator context, and a rejected option keeps preparation and the active session untouched.
  - `@mica-js/editor`: carry `batchExecution` through the canvas simulation configuration and the fused runtime load request so the typed RPC guest creates and rebuilds boards with the captured switch.

### Patch Changes

- Updated dependencies [794f541]
  - @mica-js/simulator@2.11.0

## 0.6.5

### Patch Changes

- Updated dependencies [37fb24a]
  - @mica-js/simulator@2.10.0
  - @mica-js/device-model@0.7.2
  - @mica-js/ddl@0.3.3

## 0.6.4

### Patch Changes

- Updated dependencies [7fb9015]
  - @mica-js/simulator@2.9.0

## 0.6.3

### Patch Changes

- Updated dependencies [8710632]
  - @mica-js/simulator@2.8.0

## 0.6.2

### Patch Changes

- Updated dependencies [ee48660]
  - @mica-js/device-model@0.7.1
  - @mica-js/ddl@0.3.2
  - @mica-js/simulator@2.7.1

## 0.6.1

### Patch Changes

- Updated dependencies [7640ca1]
  - @mica-js/simulator@2.7.0

## 0.6.0

### Minor Changes

- c138283: `mica build --watch` 持续构建统一器件包：首次完整构建后监听 `sourceDir`、清单、DDL 与 `mica.config.ts`，防抖串行重建，配置或 `sourceDir` 改动后重新加载并重定向监听。构建先写入临时目录再整体替换 `outDir`，失败时保留上一份完整产物并继续监听，成功时输出带 `id@version` 与 integrity 的单行摘要。
- 7109908: 新增 `mica pack`：不重新构建，只把已有统一器件包按 `release.json` 的文件表打成确定性 ZIP（路径排序、store-only、固定时间戳），`release.json` 位于包根且不计入发布身份。`outDir` 缺失、缺少 `release.json` 或任一文件与记录不一致时直接失败且不产出 ZIP；默认输出 `<root>/<publisher>-<name>-<version>.zip`，可用 `--out` 覆盖。

## 0.5.0

### Minor Changes

- 42ac451: `@mica-js/sdk/device` 导出 JIT 可执行区域、代码版本变更和元数据提供器的类型，器件可通过 SDK 声明这些选项，而不必直接从 simulator 导入类型。

### Patch Changes

- Updated dependencies [42ac451]
- Updated dependencies [42ac451]
  - @mica-js/device-model@0.7.0
  - @mica-js/simulator@2.6.0
  - @mica-js/ddl@0.3.1

## 0.4.1

### Patch Changes

- @mica-js/simulator@2.5.2

## 0.4.0

### Minor Changes

- 99b33c1: 新增融合原理图工作台、统一器件包与程序资源 API，补齐编辑交互和实例音频，修复 Worker 热更新缓存。

### Patch Changes

- Updated dependencies [99b33c1]
  - @mica-js/document@0.3.0
  - @mica-js/widget@0.5.0
  - @mica-js/simulator@2.5.1

## 0.3.3

### Patch Changes

- Updated dependencies [2aed0c3]
  - @mica-js/simulator@2.5.0

## 0.3.2

### Patch Changes

- e85b884: 构建内联器件模型时剥离 `source` 元数据，减小产物体积与冷启动开销。

  CT107D 整板实测：模型 IR 1.44 MB → 0.50 MB，`createDeviceLibrary` 约 80 ms → 48 ms。
  代价是运行时诊断不再携带 DDL 行列位置（`source` 在 IR 中处处可选，产物仍通过校验）。

- Updated dependencies [179d367]
  - @mica-js/simulator@2.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [5dbada1]
  - @mica-js/simulator@2.3.0

## 0.3.0

### Minor Changes

- 8439e45: 对全部可发布包统一推进一个 minor 版本，用一次发布会话走完 `release.yml` 的 OIDC 信任发布流程。

  - 每个包各发布一个新版本，使 npm trusted publishing 在 11 个包上逐一完成校验；此前 `@mica-js/scene-3d` 因包名在 registry 中不存在而无法走 OIDC，首次版本由人工发布补位。
  - `@mica-js/simulator` 的 2.1.1 在改动前未进入 registry，本次随 minor 推进覆盖该版本。
  - 本 changeset 只做版本推进，不包含源码或行为变更。

### Patch Changes

- Updated dependencies [8439e45]
  - @mica-js/core@0.7.0
  - @mica-js/ddl@0.3.0
  - @mica-js/device-model@0.6.0
  - @mica-js/simulator@2.2.0
  - @mica-js/widget@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [a935edb]
  - @mica-js/simulator@2.1.1

## 0.2.1

### Patch Changes

- Updated dependencies [abf4169]
  - @mica-js/widget@0.3.1

## 0.2.0

### Minor Changes

- New architecture for mica simulator and refactoring of editor package

### Patch Changes

- Updated dependencies
  - @mica-js/core@0.6.0
  - @mica-js/ddl@0.2.0
  - @mica-js/device-model@0.5.0
  - @mica-js/simulator@2.1.0
  - @mica-js/widget@0.3.0
