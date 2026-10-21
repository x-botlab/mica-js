# @mica/ir

领域无关 IR 包的初始化基础，对应 [#40](https://github.com/x-botlab/mica-js/issues/40)。规范依据为 [IR SPEC #26](https://github.com/x-botlab/mica-js/issues/26) 与 [器件作者 API #8](https://github.com/x-botlab/mica-js/issues/8)；提案中的能力不代表本包已经实现。

## 当前入口与限制

唯一公开入口为 `@mica/ir`，构建生成 `dist/index.js`（ESM）与 `dist/index.d.ts`。当前入口是显式空模块，没有命名导出、默认导出、占位版本常量或虚构类型。消费方可以导入模块及其类型命名空间：

```ts
import * as ir from '@mica/ir';
import type * as IrModule from '@mica/ir';

type PublicExports = keyof typeof IrModule; // 当前为 never
```

此示例只验证入口与声明文件可解析，不表示有可构建或可执行的 IR。指令、模型、构建器、校验器、解释器、动态 Provider、器件模型、协议库与 JIT 均未实现；不能提交程序或调用执行入口。导入不存在的命名导出会被 TypeScript 或 ESM 加载器拒绝，内部子路径不在 `exports` 中，不支持消费。

## 职责边界

以下为后续实现的内部职责划分，不是当前可导入的模块或公共 API；仅在实际实现时创建所需文件，不预铺空目录。

| 边界        | 职责                                                            | 不负责                               |
| ----------- | --------------------------------------------------------------- | ------------------------------------ |
| model       | 领域无关的 IR 表示、类型与静态引用                              | 作者便利语法、执行状态或电气领域模型 |
| builder     | 根据 model 建图与降低作者层便利结构                             | 执行客体行为或以记录指令冒充执行     |
| validation  | 检查类型、SSA、控制流、引用与授权等合同，拒绝不支持或非法的程序 | 静默接受未知能力或修改执行语义       |
| interpreter | 执行通过校验与链接的 IR，维护运行状态与确定性语义               | 器件定义、协议库或 JIT               |
| provider    | 动态产物生成、依赖版本及恢复检查点合同的通用接入                | MCU/器件实现或绕过 validation        |

后续边界依赖 model 的基础表示；builder 仅建图，provider 产物仍需 validation，interpreter 仅执行合法产物。对外签名必须随相应合同及实现引入，不在初始化阶段提前冻结。

本包无运行时依赖，不导入 `@mica/core`、`@mica/device`、`@mica/sandbox` 或电气领域。领域适配属于外层，不反向进入通用 IR。现有 core、schematic 与 sandbox 的入口和行为保持不变。

## 开发与验证

使用仓库现有 pnpm catalog、TypeScript、Vite、vite-plugin-dts 与 Vitest：

```bash
pnpm --filter @mica/ir test
pnpm --filter @mica/ir typecheck
pnpm --filter @mica/ir build
```

测试独立构建临时包，以真实 Node.js ESM 消费入口，并用 TypeScript NodeNext 解析生成的声明；同时检查未实现的命名导出与内部子路径被拒绝。测试不依赖预先存在的 `dist`，结束后清理临时文件。
