---
'@mica-js/scene-3d': minor
---

新增 `.scene3d` 文档格式与材质预设（#178）：

- `format/` 模块：`SCENE3D_VERSION`、`Scene3DDocument`、`WorldConfig`（重力、物理步长、地面）与 `EnvironmentConfig`（环境光、方向光、天空盒）。
- `MaterialPreset` / `MaterialLibrary`：物理属性与视觉默认值分离，密度使用 g/cm³，其余系数为 0–1。
- `BUILTIN_MATERIAL_PRESETS`：13 种内置预设，覆盖亚克力/PC 板/木板/铝板/钢板等板材、PLA/ABS/PETG/TPU 3D 打印材料与 PVC/PP/尼龙常见塑料。
- 测试：校验全部预设的密度、摩擦、弹性与视觉参数范围，以及完整/最小 `.scene3d` 文档的构造。
