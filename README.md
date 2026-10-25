# Mica

Mica 是一个用 TypeScript 编写的开源电路仿真引擎，采用 pnpm Monorepo 组织。原理图与画布文档、器件模型、虚拟时间调度、电气网络求解、编辑器与 Widget 运行时被拆成独立包，可按需组合。

## 功能特性

- **电路仿真**：确定性虚拟时间调度，支持器件、电气网络与电源域的联合仿真。
- **高性能**：统一 IR 批处理执行，吞吐比调度器路径高 10–1000×。
- **可视化编辑**：原理图（`.sch`）与画布（`.cnv`）编辑器，支持交互命令与场景组装。
- **Widget 运行时**：支持包加载、图层管理与端口路由。
- **安全隔离**：第三方 Widget 在隔离沙箱中运行，无宿主 DOM、存储与网络访问。
- **可扩展**：器件模型、执行器、宿主与 UI 均为独立包，可按需组合。

## 快速开始

环境要求：Node.js `^20.19.0 || >=22.12.0`，pnpm 由 `packageManager` 固定版本。

```bash
corepack enable pnpm
pnpm install
pnpm run build
pnpm run test
```

启动示例站点：

```bash
pnpm --filter @mica-js/playground dev
```

用统一 IR 运行一个最小电路：

```ts
import { Circuit, createLedIR, createMcuDescription, LED_IR_TYPE } from '@mica-js/simulator';

const lamp = createLedIR('led1', { color: 'green' });

const circuit = await Circuit.create({
  devices: [
    { id: 'mcu1', type: 'mcu', description: createMcuDescription() },
    { id: 'led1', type: LED_IR_TYPE, description: lamp.device.description },
  ],
  connections: [
    { from: 'mcu1.PA0', to: 'led1.anode' },
    { from: 'led1.cathode', to: 'GND' },
  ],
});

circuit.step();
console.log(circuit.devices.led1.isOn());
circuit.dispose();
```

## 文档

- 包文档：
  - [`@mica-js/ir`](packages/ir/README.md)
  - [`@mica-js/core`](packages/core/README.md)
  - [`@mica-js/device`](packages/device/README.md)
  - [`@mica-js/simulator`](packages/simulator/README.md)
  - [`@mica-js/sandbox`](packages/sandbox/README.md)
  - [`@mica-js/widget`](packages/widget/README.md)
  - [`@mica-js/canvas-editor`](packages/canvas-editor/README.md)
  - [`@mica-js/schematic-editor`](packages/schematic-editor/README.md)
- 仿真器：[API 参考](packages/simulator/docs/API.md)、[性能基准](packages/simulator/docs/PERFORMANCE.md)、[统一 IR 架构](packages/simulator/src/unified-ir/README.md)
- 示例站点：[apps/playground](apps/playground)
