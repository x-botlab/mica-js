# @mica-js/editor

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
