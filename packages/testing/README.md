# @mica-js/testing

为统一器件提供独立于测试运行器的无头测试工具。测试电路使用 `.sch v2` 数据与正式无头运行时；用例组织、断言和报告由 Vitest、`node:test` 等调用方选择。

Vitest 工程通过 `@mica-js/testing/vite` 插件直接导入 `.sch`，自动生成按电路位号索引的类型。配置使用 `mitest.config.ts`，生成目录为 `.mitest/`。测试工程只需依赖和导入 testing；内部复用 SDK 运行时及公共合同工具。

## 类型化测试工程

建议使用 Node.js 24。安装开发依赖：

```shell
pnpm add -D @mica-js/testing typescript @types/node vitest
```

工程结构：

```text
test-project/
  package.json
  mitest.config.ts
  vitest.config.ts
  tsconfig.json
  circuits/switch-led.sch
  tests/switch-led.test.ts
  .mitest/                     # 自动生成，加入 .gitignore
    tsconfig.json
    testbenches/switchLed.ts
    types/circuits/switch-led.d.sch.ts
```

在 `mitest.config.ts` 中为每个测试电路配置本地器件包目录。目录包含已构建的 `release.json` 及其声明的文件，路径相对于配置文件所在目录；本地来源与测试工程位于同一文件系统卷。

```typescript
import { defineConfig } from '@mica-js/testing/config';

export default defineConfig({
  testbenches: {
    switchLed: {
      document: 'circuits\\switch-led.sch',
      devices: {
        'example:switch': '..\\devices\\switch\\dist',
        'example:led': '..\\devices\\led\\dist',
      },
    },
  },
});
```

名称如 `switchLed` 由字母开头、仅包含 ASCII 字母和数字，决定生成入口文件名。可在一个配置中声明多个电路。CLI 从当前目录或 `--root` 指定目录向上寻找最近的 `mitest.config.ts`；`--config` 可显式指定该文件。

在 `tsconfig.json` 中继承生成配置：

```json
{
  "extends": "./.mitest/tsconfig.json"
}
```

在 `vitest.config.ts` 中启用插件（Vitest 5）：

```typescript
import { defineConfig } from 'vitest/config';
import { mitest } from '@mica-js/testing/vite';

export default defineConfig({
  plugins: [mitest()],
  test: { environment: 'node' },
});
```

`mitest()` 默认以 Vite 工程目录寻找配置，也可以传入 `{ root, config }`。直接导入的 `.sch` 必须在配置中声明，且每个文档对应一个测试配置。

首次准备电路或明确接受器件产物变更时，显式更新 `.sch` 的依赖锁：

```shell
pnpm exec mitest update-lock
pnpm exec vitest run
```

日常直接运行 `vitest` 或 `vitest run`。插件自动检查现有锁并准备类型和工厂；监听模式下，电路、配置、发布清单或包清单变化会重新准备并重跑相关测试，准备失败明确报告，修复后可以继续运行。普通准备保持电路内容不变；依赖不匹配时报告错误。

首次打开编辑器或单独运行 TypeScript 检查时，使用 `mitest prepare` 生成声明。`mitest prepare --watch` 可独立监听生成类型；`mitest prepare --update-lock` 保留为锁更新的兼容写法。生成目录可重新创建，电路及其中的依赖锁随工程保存。

例如在 `package.json` 中配置：

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "prepare:types": "mitest prepare",
    "typecheck": "mitest prepare && tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

例如电路包含位号 `SW1` 和 `D1`，其清单分别声明 `setPressed(boolean)` / `onDidPressed` 和 `getBrightness(null)`：

```typescript
import { expect, it } from 'vitest';
import { ms } from '@mica-js/testing';
import createTestbench from '../circuits/switch-led.sch';
import type { Event, ModelEvent } from '@mica-js/testing';

it('按下开关点亮 LED', async () => {
  const bench = await createTestbench({ step: ms(0.01) });
  try {
    const pressed: boolean[] = [];
    const onDidPressed: Event<ModelEvent<boolean>> = bench.devices.SW1.onDidPressed;
    onDidPressed(({ value }) => pressed.push(value));

    await bench.devices.SW1.setPressed(true);
    await bench.advanceFor(ms(1));
    expect(await bench.devices.D1.getBrightness(null)).toBeGreaterThan(0);
    expect(pressed).toEqual([true]);
  } finally {
    await bench.dispose();
  }
});
```

默认导出为 `createTestbench` 工厂，每次调用创建独立环境。生成入口自动提供本地 registry 和模型加载器。器件方法参数、返回值、事件载荷及 `model.types` 引用都来自经过验证的锁定清单；未知位号和错误参数会产生 TypeScript 诊断。事件回调接收 `{ value, simTime, sequence }`，订阅返回 `Disposable`。

TypeScript 通过生成配置的 `rootDirs` 和 `.mitest/types/**/*.d.sch.ts` 逐电路解析类型；声明全部保存在 `.mitest/`，也支持同卷的工程外电路。编辑器和独立 `tsc` 需要继承上述生成配置。

方法与事件名称不冲突时直接访问；同名成员或 `methods`、`events`、`then` 保留名使用 `bench.devices.SW1.methods.name` / `.events.name`。`reset()` 后重新访问 `bench.devices.SW1` 获取新模型；此前保存的代理和订阅属于旧模型。

每次创建环境都重新读取电路，并在加载模型前核对实例身份、位号与依赖锁。Vitest 插件自动重新准备修改后的绑定；通过 CLI 使用生成入口时重新运行 `mitest prepare`。属性、布局和接线修改会在下次创建时直接生效。本地器件包还会核对发布摘要与锁，修改产物后需显式更新锁。

已有测试工程将 `testbenches` 配置迁入 `mitest.config.ts`，生成入口导入与 TypeScript 继承路径改为 `.mitest/`。器件作者工程的 `device` 配置继续使用 `mica.config.ts` 和 `.mica/`；同目录测试可使用独立的 `tsconfig.test.json` 继承 `.mitest/tsconfig.json`，通过 `tsc -p tsconfig.test.json` 检查。

使用 Node.js 24 的 `node:test` 时，先执行 `mitest prepare`，用 `import { createTestbench } from '../.mitest/testbenches/switchLed.ts'` 导入生成入口，再运行 `node --test tests/switch-led.test.ts`。直接导入 `.sch` 由 Vite 插件处理；原生 Node 用例导入生成的 TypeScript 工厂。本地 TypeScript 模块导入写完整的 `.ts` 扩展名，生成配置已允许这种导入。

## 动态电路

对运行时提供的文档，可从默认入口调用 `createTestbench({ document, registry, loadModule, step })`，或使用 `bench.device()`、`bench.deviceById()` 和动态 `bench.devices` 字典。动态接口以运行时清单校验参数和事件；类型化位号接口由上述电路生成入口提供。

默认入口保持与测试运行器及文件系统无关。`@mica-js/testing/node` 提供本地文件加载能力；生成的工程入口使用该 Node 子路径。自定义来源可通过正式 `DeviceRegistry` 接入。

## 时间控制

`ps`、`ns`、`us`、`ms`、`seconds` 返回核心 `TimePs`。较大单位可使用小数，转换结果必须是合法的整数皮秒。例如 `ms(0.01)` 等于 10,000,000 ps。

| API                                          | 行为                                                     |
| -------------------------------------------- | -------------------------------------------------------- |
| `createTestbench(options)`                   | 校验和初始化电路，返回暂停的独立环境                     |
| `bench.device(designator)`                   | 按唯一位号取得正式模型代理                               |
| `bench.deviceById(instanceId)`               | 按稳定实例 ID 取得正式模型代理                           |
| `bench.advanceFor(duration)`                 | 按固定步长推进指定时长                                   |
| `bench.advanceTo(target)`                    | 推进到目标虚拟时间                                       |
| `bench.advanceUntil(predicate, { timeout })` | 先检查当前状态，再逐步推进；在虚拟超时边界仍不成立时拒绝 |
| `bench.events(selector)`                     | 读取已配置事件记录的独立快照                             |
| `bench.diagnostics`                          | 读取当前测试周期的诊断快照                               |
| `bench.reset()`                              | 沿用运行资源快照创建新模型，清空记录并捕获新的初始化事件 |
| `bench.dispose()`                            | 释放模型及订阅；重复调用返回同一次清理结果               |

推进时长及目标时间与当前时间之差必须是固定步长的整数倍。推进、等待和复位需要依次 `await`；并发控制操作明确拒绝。条件等待只消耗虚拟时间，不使用墙钟睡眠。

模型故障后可通过 `reset()` 创建新模型并继续测试；本次故障诊断保留到复位开始。

## 事件记录

在 `createTestbench` 的 `record` 中声明要记录的事件，记录先于模型工厂安装，包含初始化事件。选择器使用 `{ designator, event }` 或 `{ instanceId, event }`；不存在的器件或事件使创建失败并清理模型。

每条记录保留正式 `ModelEvent` 的 `value`、`simTime` 和 `sequence`。查询未配置记录的事件会报错。每次查询返回独立快照，调用方修改返回值不影响后续查询。

动态文档的模型代理使用运行时校验；模型工厂、方法或推进故障会拒绝当前操作。器件引脚激励由接入真实电气网络的电源、驱动器和探针表达。

## 使用

```ts
import { createTestbench, ms } from '@mica-js/testing';

const bench = await createTestbench({
  document: circuit,
  registry,
  loadModule,
  step: ms(0.01),
  record: [{ designator: 'D1', event: 'onDidBrightnessChange' }],
});

try {
  await bench.advanceFor(ms(1));
  const changes = bench.events({ designator: 'D1', event: 'onDidBrightnessChange' });
  console.log(changes);
} finally {
  await bench.dispose();
}
```
