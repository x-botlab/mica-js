# 3D 场景模式 Issues 列表

## Epic

**[#176 [Epic] 3D 场景模式支持](https://github.com/x-botlab/mica-js/issues/176)**

约 10-14 周，38 个子任务

## 架构更新说明

**2026-10-24**: 基于架构细化（checkpoint 002），新增 2 个 Phase 1 任务：

- #213: 装配体定义文件格式（`.assembly.json`）
- #214: 多仿真器运行时架构（每个装配体实例独立 sandbox，锁步同步）

关键架构决策：

- **装配体绑定原理图**：装配体定义文件直接绑定原理图，场景实例化时创建独立仿真器
- **话题绑定**：移除 `SceneEntity.symbol`，改为 `JointEntity.bindings` 和 `SensorEntity.bindings`（统一端口绑定格式，对齐 2D Widget）
- **物理引擎**：确认使用 MuJoCo（非 Rapier）
- **时间同步**：采用锁步同步策略（所有仿真器完成才推进物理）

---

## Phase 1: 基础架构（8 issues）

1. [#177 创建 @mica-js/scene-3d 包基础结构](https://github.com/x-botlab/mica-js/issues/177) ✅
2. [#178 定义 .scene3d 文档格式和类型](https://github.com/x-botlab/mica-js/issues/178) ✅
3. [#179 定义实体系统类型](https://github.com/x-botlab/mica-js/issues/179) 🔄 (需更新：binding 架构)
4. [#180 集成 MuJoCo WASM](https://github.com/x-botlab/mica-js/issues/180)
5. [#181 实现 Scene3DRuntime 核心](https://github.com/x-botlab/mica-js/issues/181)
6. [#182 实现时间同步机制](https://github.com/x-botlab/mica-js/issues/182)
7. [#213 定义装配体定义文件格式](https://github.com/x-botlab/mica-js/issues/213) 🆕
8. [#214 实现多仿真器运行时架构](https://github.com/x-botlab/mica-js/issues/214) 🆕

---

## Phase 2: 亚克力板建模（5 issues）

7. [#183 定义亚克力板数据结构](https://github.com/x-botlab/mica-js/issues/183)
8. [#184 实现 2D 轮廓几何处理](https://github.com/x-botlab/mica-js/issues/184)
9. [#185 实现几何挤出与三角化](https://github.com/x-botlab/mica-js/issues/185)
10. [#186 实现亚克力板物理属性计算](https://github.com/x-botlab/mica-js/issues/186)
11. [#187 亚克力板渲染支持](https://github.com/x-botlab/mica-js/issues/187)

---

## Phase 3: 关节与装配体（4 issues）

12. [#188 定义关节系统类型](https://github.com/x-botlab/mica-js/issues/188)
13. [#189 实现关节控制器](https://github.com/x-botlab/mica-js/issues/189)
14. [#190 关节与话题系统集成](https://github.com/x-botlab/mica-js/issues/190)
15. [#191 实现装配体系统](https://github.com/x-botlab/mica-js/issues/191)

---

## Phase 4: 传感器系统（6 issues）

16. [#192 定义传感器系统架构](https://github.com/x-botlab/mica-js/issues/192)
17. [#193 实现距离传感器](https://github.com/x-botlab/mica-js/issues/193)
18. [#194 实现颜色传感器（循迹）](https://github.com/x-botlab/mica-js/issues/194)
19. [#195 实现 IMU 传感器](https://github.com/x-botlab/mica-js/issues/195)
20. [#196 实现摄像头和其他传感器](https://github.com/x-botlab/mica-js/issues/196)
21. [#212 实现 GPS 传感器](https://github.com/x-botlab/mica-js/issues/212)

---

## Phase 5: 编辑器（7 issues）

22. [#197 创建 @mica-js/scene-editor 包](https://github.com/x-botlab/mica-js/issues/197)
23. [#198 实现 3D 视口和相机控制](https://github.com/x-botlab/mica-js/issues/198)
24. [#199 实现 Transform Gizmo](https://github.com/x-botlab/mica-js/issues/199)
25. [#200 实现 2D 轮廓编辑器](https://github.com/x-botlab/mica-js/issues/200)
26. [#201 2D 轮廓导入功能](https://github.com/x-botlab/mica-js/issues/201)
27. [#202 实现预制件库](https://github.com/x-botlab/mica-js/issues/202)
28. [#203 实现属性面板](https://github.com/x-botlab/mica-js/issues/203)

---

## Phase 6: 调试与优化（5 issues）

29. [#204 实现调试可视化工具](https://github.com/x-botlab/mica-js/issues/204)
30. [#205 实现碰撞事件系统](https://github.com/x-botlab/mica-js/issues/205)
31. [#206 实现场景验证和诊断](https://github.com/x-botlab/mica-js/issues/206)
32. [#207 性能优化](https://github.com/x-botlab/mica-js/issues/207)
33. [#208 标准 3D 模型加载](https://github.com/x-botlab/mica-js/issues/208)

---

## Phase 7: 集成与示例（3 issues）

34. [#209 3D 场景模式集成到 Playground](https://github.com/x-botlab/mica-js/issues/209)
35. [#210 循迹机器人示例场景](https://github.com/x-botlab/mica-js/issues/210)
36. [#211 迷宫探索示例场景](https://github.com/x-botlab/mica-js/issues/211)

---

## 快速查看

- **Epic Issue**: https://github.com/x-botlab/mica-js/issues/176
- **所有 3D 场景 Issues**: https://github.com/x-botlab/mica-js/issues?q=is%3Aissue+label%3Ascene3d
- **设计文档**: [3d-scene-mode-design.md](./3d-scene-mode-design.md)
- **方案总结**: [3d-scene-mode-summary.md](./3d-scene-mode-summary.md)

---

## 统计

- **总计**: 37 个 issues (1 epic + 36 tasks)
- **标签**: `scene3d`, `enhancement`
- **预计工期**: 9-13 周
