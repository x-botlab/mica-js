# @mica-js/simulator

在虚拟时钟上编译和运行电路与原理图器件，提供电气求解、器件状态访问和宿主集成。器件描述、行为工厂与器件库由调用方提供，本包不内置具体器件模型。

仿真运行时可在宿主中直接使用，也可通过现有沙箱接入。编辑器界面和文档持久化由上层应用负责。

## 主要入口

- `@mica-js/simulator`：`compileCircuit`、`Circuit` 及原理图仿真宿主工厂。
- `DeviceSimulationHost`：原理图加载、虚拟时钟推进和主题通信的宿主契约。
- `@mica-js/simulator/sandbox`：沙箱环境中的仿真宿主接入。

器件定义与接口约定见 [RFC](../../docs/rfc/)。
