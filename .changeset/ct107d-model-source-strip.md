---
'@mica-js/sdk': patch
---

构建内联器件模型时剥离 `source` 元数据，减小产物体积与冷启动开销。

CT107D 整板实测：模型 IR 1.44 MB → 0.50 MB，`createDeviceLibrary` 约 80 ms → 48 ms。
代价是运行时诊断不再携带 DDL 行列位置（`source` 在 IR 中处处可选，产物仍通过校验）。
