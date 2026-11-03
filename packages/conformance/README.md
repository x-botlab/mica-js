# @mica-js/conformance

私有 workspace 验收执行框架，不发布、不构建 dist。实际规范样本仍由调用方维护；本包不提供替代编译器、运行时或仿真结果。

## API

入口 `@mica-js/conformance` 导出：

- `loadCases(rootURL)`：传目录 `file:` URL（以 `/` 结尾）；按 `layers` 中的六层递归发现 `.case.md`，`name` 由相对文件路径生成，layer 从目录推导。其他文件自然忽略。
- `loadMarkdownCase(fileURL, {layer})`：异步读取并解析样本。
- `parseMarkdownCase(source, {file, layer})`：同步解析、校验并编译执行代码，返回 `{name, layer, file, async run(adapter, t)}`，直接解析时以文件路径作为名称。
- `layers`：用例目录分类。
- `summarize(cases, outcomes?)`：统计用例数量与执行结果；未传执行结果时计为未运行。
- `loadAdapter(value?)`：加载真实适配器。
- `closeTo`、`diagnostic`、`messages`：显式容差、诊断与输出断言辅助。

类型入口 `@mica-js/conformance/adapter` 导出 `ConformanceAdapter`。

```javascript
import { loadCases } from '@mica-js/conformance';
const cases = await loadCases(new URL('./tests/conformance/', import.meta.url));
// 在 node:test 的回调中执行：await cases[0].run(realAdapter, t)
```

## Markdown 契约

可执行文件以 YAML frontmatter 开始（允许 BOM 和 CRLF），只填写 `kind`。规范来源、前提、操作和预期直接写在 Markdown 正文中，内容通过 review 维护；框架按执行形式加载代码并统计实际结果。

必填 H2 顺序：compile 为「输入、执行步骤、断言」；simulation 为「模型、装配、执行步骤、断言」；comparison 为「对照输入、执行步骤、断言」。每节恰好一个非空顶层围栏代码块；执行步骤与断言仅接受 `typescript`，输入与对照仅接受 `ddl/json`，模型仅接受 `ddl`，装配接受合法 `json`，解析后的数据直接交给用例。说明文字、H1、无代码的其他章节可以保留；重复、不适用或嵌套执行章节、缩进代码、其他章节的代码均拒绝。

执行注入真实 `adapter`、`node:assert/strict` 的 `assert` 和真实 `node:test` 上下文 `t`。simulation 注入原始 DDL `modelSource` 和已解析装配 `description`；compile 注入 `input`；comparison 注入 `inputs`。JSON 输入为解析后的值（通常为对象），DDL 输入为原文字符串。模型不会自动编译，由执行步骤调用适配器。执行步骤和断言共享异步词法作用域，支持 await 和 return；模块通过 `importModule` 加载。

每次 `run` 注入独立的 `importModule(specifier)` 绑定，通过真实 Node 动态导入加载共享 helper，只接受相对当前 Markdown 文件的 `./` 或 `../` 模块路径（不是相对 cwd）。bare specifier、绝对路径、`file:` URL 和反斜线路径均拒绝。helper 本身使用正常 ESM，可以导入 workspace 包；模块缓存遵循 Node 语义，不保证模块状态按 case 隔离。static import 与原生动态 `import()` 均不作为步骤 API 支持。

```typescript
const { createFixture } = await importModule('../fixture.mjs');
const result = await createFixture(adapter);
```

Markdown 步骤通过 `importModule` 显式加载并调用共享源码。

## 执行与限制

TypeScript 仅语法检查与转译，不执行类型检查。执行器运行受信任测试代码，不是 sandbox，也没有执行超时或权限隔离。必须传入真实 `t`；清理由 `t.after` 注册并由 Node 测试框架处理，包括失败时的清理及清理自身的错误。

格式错误包含文件、行与章节；执行错误通过转译源映射定位 Markdown 行并保留 `cause`。只有错误栈包含样本执行帧时才能精确定位；外部预先创建的错误、非 Error 抛出值或清理回调由 Node 报告的错误，定位可能退回执行步骤或显示转译后的栈。
