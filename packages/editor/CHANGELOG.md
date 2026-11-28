# @mica-js/editor

## 0.9.1

### Patch Changes

- Updated dependencies [1153f68]
  - @mica-js/sdk@0.9.0
  - @mica-js/simulator@2.13.0

## 0.9.0

### Minor Changes

- f6f2f96: 工作台运行态主按钮改为「停止」，点击后结束仿真并返回编辑；原来的「复位」按钮改为「重启」，从捕获的字节重建运行时并继续运行。新增 `simulation.restart` 命令。

## 0.8.4

### Patch Changes

- Updated dependencies [0573e1b]
  - @mica-js/simulator@2.12.0
  - @mica-js/sdk@0.8.0

## 0.8.3

### Patch Changes

- 60d29b7: Simplify workbench simulation controls with run, pause, continue, and reset actions.

## 0.8.2

### Patch Changes

- 161a982: Render an initial overlay frame for static views after preparing or resetting a fused runtime.

## 0.8.1

### Patch Changes

- @mica-js/simulator@2.11.1
  - @mica-js/sdk@0.7.1

## 0.8.0

### Minor Changes

- 794f541: Add opt-in scheduler-bounded batch execution for device processes and JIT loops.

  - `@mica-js/compiler`: prove process and JIT loop batch plans from validated IR, including the process loop-to-resume-block mapping consumed by the simulator.
  - `@mica-js/simulator`: add `BoardOptions.batchExecution` (default `false`), `DeviceContext.registerProcessBatch` with `ProcessBatchRegistration`, and `JitTranslateInput.markBatchLoop` with `JitBatchMark`. Prepared simulation loads validate the scalar switch, forward it to the board and keep it across reset.
  - `@mica-js/sdk`: re-export the batch declaration types from the device entry and accept the forwarded `batchExecution` switch in `HeadlessRuntimeOptions`. Fused `ModelBinding` forwards `registerProcessBatch` to the simulator context, and a rejected option keeps preparation and the active session untouched.
  - `@mica-js/editor`: carry `batchExecution` through the canvas simulation configuration and the fused runtime load request so the typed RPC guest creates and rebuilds boards with the captured switch.

### Patch Changes

- Updated dependencies [794f541]
  - @mica-js/simulator@2.11.0
  - @mica-js/sdk@0.7.0

## 0.7.6

### Patch Changes

- Updated dependencies [37fb24a]
  - @mica-js/simulator@2.10.0
  - @mica-js/sdk@0.6.5

## 0.7.5

### Patch Changes

- Updated dependencies [7fb9015]
  - @mica-js/simulator@2.9.0
  - @mica-js/sdk@0.6.4

## 0.7.4

### Patch Changes

- Updated dependencies [8710632]
  - @mica-js/simulator@2.8.0
  - @mica-js/sdk@0.6.3

## 0.7.3

### Patch Changes

- @mica-js/sdk@0.6.2
  - @mica-js/simulator@2.7.1

## 0.7.2

### Patch Changes

- Updated dependencies [7640ca1]
  - @mica-js/simulator@2.7.0
  - @mica-js/sdk@0.6.1

## 0.7.1

### Patch Changes

- Updated dependencies [c138283]
- Updated dependencies [7109908]
  - @mica-js/sdk@0.6.0

## 0.7.0

### Minor Changes

- 42ac451: 融合工作台新增可选的 `measure` 回调，宿主可为每个实例指定覆盖层尺寸，让使用毫米几何的板卡有合适的显示密度；未传回调时保持原默认尺寸。

### Patch Changes

- Updated dependencies [42ac451]
- Updated dependencies [42ac451]
  - @mica-js/sdk@0.5.0
  - @mica-js/simulator@2.6.0

## 0.6.0

### Minor Changes

- 61639d9: 融合工作台新建电源符号默认接入 `VCC` 网络，电压为 `3.3 V`，放置预览使用同一默认值。双击电源符号或其网名、接地符号和普通网标会打开对应的属性面板。

  宿主可用 `simulation.pause` 和 `simulation.resume` 在同一运行会话中暂停和继续仿真，并通过 `simulationStatus` 观察状态。工作台界面不新增控件。底层融合运行时的 `pause()` 现在返回 Promise，可等待仿真端确认。

## 0.5.1

### Patch Changes

- 408a624: 修复融合工作台工具栏「更多」下拉菜单出现在工具栏左端的问题，菜单改为在「更多」按钮下方右对齐展开。

## 0.5.0

### Minor Changes

- 08e2836: 修复融合工作台拖动独立网标时连接点不动，接线改为只在端子锚点启动；属性面板可查看并修改电源端、接地端、网标与电压参考的角度、电压和网名。

## 0.4.1

### Patch Changes

- @mica-js/simulator@2.5.2
  - @mica-js/sdk@0.4.1

## 0.4.0

### Minor Changes

- 99b33c1: 新增融合原理图工作台、统一器件包与程序资源 API，补齐编辑交互和实例音频，修复 Worker 热更新缓存。

### Patch Changes

- Updated dependencies [99b33c1]
  - @mica-js/document@0.3.0
  - @mica-js/sdk@0.4.0
  - @mica-js/widget@0.5.0
  - @mica-js/sandbox@0.5.1
  - @mica-js/simulator@2.5.1

## 0.3.3

### Patch Changes

- Updated dependencies [2aed0c3]
  - @mica-js/simulator@2.5.0
  - @mica-js/sdk@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies [e85b884]
- Updated dependencies [179d367]
  - @mica-js/sdk@0.3.2
  - @mica-js/simulator@2.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [5dbada1]
  - @mica-js/simulator@2.3.0
  - @mica-js/sdk@0.3.1

## 0.3.0

### Minor Changes

- 8439e45: 对全部可发布包统一推进一个 minor 版本，用一次发布会话走完 `release.yml` 的 OIDC 信任发布流程。

  - 每个包各发布一个新版本，使 npm trusted publishing 在 11 个包上逐一完成校验；此前 `@mica-js/scene-3d` 因包名在 registry 中不存在而无法走 OIDC，首次版本由人工发布补位。
  - `@mica-js/simulator` 的 2.1.1 在改动前未进入 registry，本次随 minor 推进覆盖该版本。
  - 本 changeset 只做版本推进，不包含源码或行为变更。

### Patch Changes

- Updated dependencies [8439e45]
  - @mica-js/core@0.7.0
  - @mica-js/document@0.2.0
  - @mica-js/sdk@0.3.0
  - @mica-js/simulator@2.2.0
  - @mica-js/widget@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [a935edb]
  - @mica-js/simulator@2.1.1
  - @mica-js/sdk@0.2.2

## 0.2.0

### Minor Changes

- abf4169: Add editor-owned canvas audio playback with user-gesture unlocking, simulation pause/resume integration, and automatic AudioContext cleanup. Preserve audio suspension requested before the first widget mounts.

  Make the canvas simulation step configurable through `stepMs`, defaulting to 20 ms. Schedule frames against fixed deadlines and skip missed slots without overlapping or accumulating simulation work.

### Patch Changes

- Updated dependencies [abf4169]
  - @mica-js/widget@0.3.1
  - @mica-js/sdk@0.2.1

## 0.1.0

### Minor Changes

- New architecture for mica simulator and refactoring of editor package

### Patch Changes

- Updated dependencies
  - @mica-js/core@0.6.0
  - @mica-js/document@0.1.0
  - @mica-js/sdk@0.2.0
  - @mica-js/simulator@2.1.0
  - @mica-js/widget@0.3.0
