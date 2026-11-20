# Playground 统一器件子项目

每个子目录是一套独立的统一器件开发项目，根 `package.json` 只负责聚合：

```
led/            demo:led
push-button/    demo:push-button
resistor/       demo:resistor
voltmeter/      demo:voltmeter
```

每个子项目包含唯一清单 `package.json`、`src/{model.ddl,model.ts}`；本轮只迁移 headless
模型与包组织，不声明 `view2d`、不提供新的 2D 视图或编辑器适配。

```bash
node scripts/components.mjs prepare
node scripts/components.mjs build
node scripts/components.mjs typecheck
```

输出位于 `dist/<id>/`，包含 `package.json` 与 `model.js`。

## Playground 主页面兼容资源

根 `mica.config.ts` 从 `src/devices/` 和 `src/widgets/` 构建 v1 画布需要的资源，
输出到 `dist/runtime-demo/`。统一器件仍由各子项目独立构建；两种格式不能互换。

`tests/widgets.test.ts` 覆盖旧编辑器的 widget 合同，不消费新的 headless 器件包。根 `test`
脚本同时运行统一器件模型测试与旧 widget 测试。
