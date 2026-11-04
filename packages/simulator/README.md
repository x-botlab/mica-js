# @mica-js/simulator

基于[器件仿真规范](../../docs/spec/index.rst)的同步运行时。DDL、TypeScript Builder 和动态生成块使用共享 IR 与 JS 编译后端；运行位置由接入者决定，包不创建 Worker 或沙箱。

## 入口

- `@mica-js/simulator`：`createDeviceLibrary`、`createBoard`、`SimulationError` 和宿主类型。
- `@mica-js/simulator/device`：器件工厂、context、通道、批次、字节视图和 JIT 接口。
- `@mica-js/simulator/model`：共享 IR、Builder 与校验器。
- `@mica-js/simulator/ddl`：Langium DDL 编译工具；根入口不加载解析器。

```typescript
import { createDeviceLibrary, createBoard } from '@mica-js/simulator';
import { compileDDL } from '@mica-js/simulator/ddl';

const model = await compileDDL('device Timer { process start { await ticks(10); } }');
const library = createDeviceLibrary([
  {
    id: 'example/Timer',
    model,
    create() {
      return { sync() {}, dispose() {} };
    },
  },
]);
const board = createBoard(library, {
  instances: [{ id: 'timer', type: 'example/Timer' }],
  nets: [],
});
board.runUntil(100);
board.dispose();
```

`createBoard` 同步完成全板校验、创建期求值、资源建立和工厂初始化。首次 `runUntil` 才求解初始电气状态并启动模型。时间为整数皮秒；成功推进后通过每个器件的 `sync(batch)` 交付输出。故障后保留现场，恢复方式为销毁并重新创建板。

memory 使用独立字节区，输入和输出遵守快照、FIFO 与批次规则。执行器使用稳定事件队列；state、memory 与 sample 按资源版本记录实际读取依赖，只有脏观察源参与下一轮稳定比较。derived 缓存和 waitUntil 谓词沿纯函数调用跟踪依赖，分支改变时更新订阅。

引脚意图变化才触发边界电气求解。求解以连通分量为单位，缓存未变化配置与分解，全部必要分量成功后才发布新采样。当前直接分解后端对含 U 个未知节点的分量使用 O(U²) 空间和 O(U³) 分解时间；大型单一稠密分量应通过基准评估。

旧 `Circuit`、`compileCircuit`、原理图宿主和 `/sandbox` 入口已移除；编辑器与 playground 的接入需迁移到新的库/板合同。

## 验证

构建新模型、DDL、编译器和 simulator 包后，连接真实 adapter：

```powershell
$env:MICA_CONFORMANCE_ADAPTER = (Resolve-Path tests\conformance\adapter.mjs).Path
pnpm typecheck:implementation
pnpm test:conformance:strict
pnpm test:generated --require-adapter
pnpm test:generated:daily --require-adapter
```

`typecheck:implementation` 将已有 Builder/IR/host 类型场景的合同导入重定向到真实源码入口，不复制场景。运行时未新增单元测试，验收使用既有[符合性场景](../../tests/conformance/README.md)和[独立生成 oracle](../../tests/generated/README.md)。

## 基准

```powershell
pnpm --filter @mica-js/compiler bench
pnpm --filter @mica-js/simulator bench
pnpm --filter @mica-js/simulator bench:electrical
```

运行时基准检查结果正确性，再报告两次预热、20 次采样的中位数及 P95/P99：跨最大时间范围的稀疏推进、100,000 个连续定时边界、1,000 个休眠实例、反应扇出与干净观察源、存储和通道快照。堆变化包含自动 GC，不代表峰值占用。

电气基准独立测量缓存复用、参考变化及分量合并/拆分，并报告分解和缓存计数；测量不含 DDL、装配和 JS 编译成本。编译器基准报告冷编译、稳态吞吐和生成代码大小。数值取决于 Node.js 版本、机器与工作负载，不作为通用性能保证。
