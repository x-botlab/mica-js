# @mica-js/editor

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
