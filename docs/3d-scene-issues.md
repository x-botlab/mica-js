# 3D 场景模式 Issues 列表

## Epic

**[#176 [Epic] 3D 场景模式支持](https://github.com/x-botlab/mica-js/issues/176)**

图例：✅ 已实现 · 🔄 部分实现 · ⏳ 未开始

## 架构决策

- **装配体绑定原理图**：`.assembly.json` 直接绑定原理图，每个场景实例创建独立电路仿真器。
- **话题绑定**：实体不整体绑定器件符号，关节用 `inputBinding` / `outputBinding`、传感器用
  `bindings`，统一为 `{ symbol, port }` 端口绑定（对齐 2D Widget）。
- **包边界**：只有 `@mica-js/scene-3d`；3D 编辑器是 `@mica-js/editor` 的组合根，不单独建包。
- **物理引擎**：MuJoCo（WASM）。
- **时间同步**：锁步推进，所有仿真器完成才推进物理。
- **宿主**：`Scene3DHost` 跑在 `@mica-js/sandbox` 的 `SandboxWorker` guest 中，#181 的
  "Scene3DRuntime" 由它实现，独立的主线程运行时已删除。

---

## Phase 1: 基础架构（8 issues）

1. [#177 创建 @mica-js/scene-3d 包基础结构](https://github.com/x-botlab/mica-js/issues/177) ✅
2. [#178 定义 .scene3d 文档格式和类型](https://github.com/x-botlab/mica-js/issues/178) ✅
3. [#179 定义实体系统类型](https://github.com/x-botlab/mica-js/issues/179) ✅
4. [#180 集成 MuJoCo WASM](https://github.com/x-botlab/mica-js/issues/180) 🔄 契约与内存替身已完成
5. [#181 实现 Scene3DRuntime 核心](https://github.com/x-botlab/mica-js/issues/181) ✅ 由 `Scene3DHost` 实现
6. [#182 实现时间同步机制](https://github.com/x-botlab/mica-js/issues/182) ✅ 锁步由 `Scene3DHost.step` 实现
7. [#213 定义装配体定义文件格式](https://github.com/x-botlab/mica-js/issues/213) ✅
8. [#214 实现多仿真器运行时架构](https://github.com/x-botlab/mica-js/issues/214) ✅ 父子 MessageChannel 直连

---

## Phase 2: 亚克力板建模（5 issues）

9. [#183 定义亚克力板数据结构](https://github.com/x-botlab/mica-js/issues/183) ✅
10. [#184 实现 2D 轮廓几何处理](https://github.com/x-botlab/mica-js/issues/184) ✅
11. [#185 实现几何挤出与三角化](https://github.com/x-botlab/mica-js/issues/185) ✅
12. [#186 实现亚克力板物理属性计算](https://github.com/x-botlab/mica-js/issues/186) ✅
13. [#187 亚克力板渲染支持](https://github.com/x-botlab/mica-js/issues/187) ✅

---

## Phase 3: 关节与装配体（4 issues）

14. [#188 定义关节系统类型](https://github.com/x-botlab/mica-js/issues/188) ✅
15. [#189 实现关节控制器](https://github.com/x-botlab/mica-js/issues/189) ✅
16. [#190 关节与话题系统集成](https://github.com/x-botlab/mica-js/issues/190) ⏳
17. [#191 实现装配体系统](https://github.com/x-botlab/mica-js/issues/191) 🔄 定义与校验已完成

---

## Phase 4: 传感器系统（6 issues）

18. [#192 定义传感器系统架构](https://github.com/x-botlab/mica-js/issues/192) ✅
19. [#193 实现距离传感器](https://github.com/x-botlab/mica-js/issues/193) ✅
20. [#194 实现颜色传感器（循迹）](https://github.com/x-botlab/mica-js/issues/194) ✅
21. [#195 实现 IMU 传感器](https://github.com/x-botlab/mica-js/issues/195) ✅
22. [#212 实现 GPS 传感器](https://github.com/x-botlab/mica-js/issues/212) ✅
23. [#196 实现摄像头和其他传感器](https://github.com/x-botlab/mica-js/issues/196) ⏳ 光照 / 声音 / 磁力 / 遮挡 / 触觉

---

## Phase 5: 编辑器（7 issues）

24. [#197 创建 3D 编辑器（`@mica-js/editor` 组合根）](https://github.com/x-botlab/mica-js/issues/197) ⏳
25. [#198 实现 3D 视口和相机控制](https://github.com/x-botlab/mica-js/issues/198) ⏳
26. [#199 实现 Transform Gizmo](https://github.com/x-botlab/mica-js/issues/199) ⏳
27. [#200 实现 2D 轮廓编辑器](https://github.com/x-botlab/mica-js/issues/200) ⏳
28. [#201 2D 轮廓导入功能](https://github.com/x-botlab/mica-js/issues/201) ⏳
29. [#202 实现预制件库](https://github.com/x-botlab/mica-js/issues/202) ⏳
30. [#203 实现属性面板](https://github.com/x-botlab/mica-js/issues/203) ⏳

---

## Phase 6: 调试与优化（5 issues）

31. [#204 实现调试可视化工具](https://github.com/x-botlab/mica-js/issues/204) ⏳
32. [#205 实现碰撞事件系统](https://github.com/x-botlab/mica-js/issues/205) ⏳
33. [#206 实现场景验证和诊断](https://github.com/x-botlab/mica-js/issues/206) 🔄 文档与装配体校验已完成
34. [#207 性能优化](https://github.com/x-botlab/mica-js/issues/207) ⏳
35. [#208 标准 3D 模型加载](https://github.com/x-botlab/mica-js/issues/208) ⏳

---

## Phase 7: 集成与示例（3 issues）

36. [#209 3D 场景模式集成到 Playground](https://github.com/x-botlab/mica-js/issues/209) ✅
37. [#210 循迹机器人示例场景](https://github.com/x-botlab/mica-js/issues/210) ✅ `apps/playground/scene3d.html`
38. [#211 迷宫探索示例场景](https://github.com/x-botlab/mica-js/issues/211) ⏳

---

## 快速查看

- **Epic Issue**: https://github.com/x-botlab/mica-js/issues/176
- **所有 3D 场景 Issues**: https://github.com/x-botlab/mica-js/issues?q=is%3Aissue+label%3Ascene3d
- **方案总结**: [3d-scene-mode-summary.md](./3d-scene-mode-summary.md)
- **实现文档**: [packages/scene-3d/README.md](../packages/scene-3d/README.md)

---

## 统计

- **总计**: 39 个 issues（1 epic + 38 任务）
- **已完成**: 21 · **部分完成**: 3 · **未开始**: 14
- **标签**: `scene3d`, `enhancement`
