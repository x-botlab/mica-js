# 理想 LED 器件包

测试夹具器件：`xbotlab:ideal-led`。只有阳极 `anode` 与阴极 `cathode` 两个引脚，
没有电气意图（不挂载电阻支路）；`brightness` 端口每 0.5 ms 采样阳极电平，高电平发布
1、其余发布 0。用来在不引入真实 LED 模型的前提下驱动板级用例。

工程位于仓库的 `examples/ideal-led`，纳入 pnpm workspace（包名
`@mica-js/example-ideal-led`）：

```bash
pnpm --filter @mica-js/example-ideal-led build
pnpm --filter @mica-js/example-ideal-led typecheck
```

它不是独立发布的器件，而是 [`../iap15f2k61s2`](../iap15f2k61s2/README.md) 测试与基准的
兄弟工程夹具：后者的 `test/` 与 `bench/` 通过 `../ideal-led/dist/devices/ideal-led`
装载本包产物，因此两个目录必须并排放在 `examples/` 下。

```
examples/ideal-led/
  mica.config.ts                  Mica 工程标志
  package.json                    build = mica build，typecheck = mica prepare && tsc --noEmit
  tsconfig.json
  src/devices/ideal-led/
    device.json                   元数据：anode / cathode 两个引脚、brightness 端口
    model.ddl                     0.5 ms 采样阳极电平 → 亮度 0/1
    index.ts                      把亮度通道转发到同名话题
```

构建产物是 `dist/devices/ideal-led/{device.json, device.js}`。
