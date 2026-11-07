---
'@mica-js/scene-3d': minor
---

新增距离、IMU、GPS 和基于表面射线命中的颜色传感器确定性实现：

- 距离传感器沿锥形固定射线图案取最近命中；
- IMU 读取传感器局部坐标系的角速度与比力（含重力反作用），依赖物理运行时新增的可选 `getBodyMotion()`；
- GPS 以 `config.origin` 为参考点做 WGS84 近似换算，噪声由 `sensor.id` 播种、可复现；
- 颜色传感器沿 `config.direction`（默认朝下）射线取命中表面颜色，`SurfaceColorResolver` 可用实体材质或按命中点的采样器解析；
- 新增 `createDefaultSensorRegistry()` 按场景装配，宿主支持 `Scene3DHostOptions.sensors` 注入。
