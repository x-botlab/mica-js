# Playground 统一器件子项目

每个子目录是一套独立的统一器件开发项目，根 `package.json` 只负责聚合：

```
led/            demo:led
push-button/    demo:push-button
resistor/       demo:resistor
voltmeter/      demo:voltmeter
```

每个子项目包含唯一清单 `package.json`、`src/{model.ddl,index.ts}`；本轮只迁移 headless
模型与包组织，不声明 `view2d`、不提供新的 2D 视图或编辑器适配。

```bash
node scripts/components.mjs prepare
node scripts/components.mjs build
node scripts/components.mjs typecheck
```

输出位于 `dist/<id>/`，包含 `package.json` 与 `model.js`。

## 旧 widget 测试

`src/widgets/` 与 `tests/widgets.test.ts` 保持迁移前的旧 widget 合同，仅用于覆盖旧编辑器
widget；它们不消费新的 headless 器件包，也不把 widget 拆分成新的器件声明。根 `test`
脚本同时运行模型测试与这组旧 widget 测试，两者互不替代。
