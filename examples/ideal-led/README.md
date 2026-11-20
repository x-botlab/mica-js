# 理想 LED 器件包

测试夹具器件：`example:ideal-led`。只有阳极 `anode` 与阴极 `cathode` 两个引脚，
没有电气意图（不挂载电阻支路）；DDL 每 0.5 ms 采样阳极电平，高电平输出亮度 `1`，
其余输出 `0`。用来在不引入真实 LED 模型的前提下驱动板级用例。本轮只迁移模型与包组织，
器件为 headless，不声明 `view2d`。

工程位于仓库的 `examples/ideal-led`，纳入 pnpm workspace。仓库中的 `package.json`
同时是唯一器件清单，因此包名就是器件名 `ideal-led`：

```bash
pnpm --filter ideal-led build
pnpm --filter ideal-led typecheck
```

它不是独立发布的器件，而是 [`../devices`](../devices/README.md) 测试与基准的
兄弟工程夹具：后者的 `test/` 与 `bench/` 从 `../ideal-led/dist/` 装载统一包产物，
因此两个目录必须并排放在 `examples/` 下。

```
examples/ideal-led/
  package.json                    唯一器件清单 + 开发脚本
  mica.config.ts                  Mica 工程标志
  tsconfig.json                   继承 .mica/tsconfig.json
  src/model.ddl                   0.5 ms 采样阳极电平 → 亮度 0/1
  src/model.ts                    同步 create / methods / ctx.events
```

构建产物是包根 `dist/`：

```
dist/package.json
dist/model.js
```

`.mica/` 与 `dist/` 均由 SDK 生成或构建，不提交；`dist.release.json` 是包外发布清单。
