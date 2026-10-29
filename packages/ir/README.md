# @mica-js/ir

领域无关的类型化 IR：建图、实例存储、静态校验、参考解释器与 JIT 执行。引脚、连接等领域指令由外部可信执行器接入。

公共入口 `@mica-js/ir` 导出 `createIRModule`、`createIRStorage`、`validateIR`、`createIRInterpreter` 和 `createIRJIT`。
