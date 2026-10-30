# @mica-js/ir

领域无关的类型化中间表示与执行工具，提供 IR 建图、实例存储、静态校验、参考解释器和 JIT 执行。适用于需要把领域行为描述为可校验、可重复执行程序的上层系统。

本包不定义电路、引脚或器件模型；领域能力由调用方接入。

## 主要入口

从 `@mica-js/ir` 导入：

- `createIRModule`：构建 IR 模块。
- `validateIR`：校验模块与资源访问约束。
- `createIRStorage`：管理实例存储。
- `createIRInterpreter` / `createIRJIT`：执行模块。
