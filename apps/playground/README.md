# @mica-js/playground

Mica 的交互式示例站点，用于集成验证原理图编辑器、画布编辑器、widget 与器件仿真。示例直接使用工作区包源码，并提供应用侧的器件库和 widget 包，不作为通用库发布。

## 示例入口

- 原理图：文档编辑、器件放置、连线和属性配置。
- 画布：widget 绑定与仿真交互，包括按键、LED 亮度、电位器和电阻上拉示例。

- 双 MCU 软件 I2C：教学主机与从机通信及总线指示灯。原理图入口 `#/schematic/teaching-i2c`，画布入口 `#/canvas/teaching-i2c`。

## 运行

在仓库根目录运行：

```bash
pnpm --filter @mica-js/playground dev
```

开发服务器地址以终端输出为准。
