# @mica-js/schematic-editor

## 0.1.1

### Patch Changes

- b98b39d: 修复框选 T 型连接后删除报未知交点：删除导线时已顺带移除的交点不再重复删除，整笔删除不再回滚。
- Updated dependencies [69dc4b0]
  - @mica-js/core@0.1.1

## 0.1.0

### Minor Changes

- 503b44b: 首个公开版本：把 `.sch` 渲染成可编辑的 Canvas 画布，含选择/框选、网格吸附拖动、旋转、导线段改形、导线模式与 T 型接入、位号拖动、只读模式，以及宿主驱动的器件放置与属性面板合同。

### Patch Changes

- Updated dependencies [503b44b]
  - @mica-js/core@0.1.0
