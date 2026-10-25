# 性能基准

本页给出统一 IR 的参考性能范围与复现方式。所有数字都是单机观测值，仅用于判断量级；
**它们是参考范围，不是硬性门槛**——性能文件不包含任何断言，也不会在 `pnpm test` / CI 中运行。

## 参考基准范围

参考值来自 AMD Ryzen 5 5600G / 16 GiB / Windows 11 / Node.js v24.18.0 / JIT 引擎；
不同机器与运行之间通常有 ±10–20% 波动，机器繁忙时数字会更低。

| 场景                                     | 观测范围           | 相对调度器  |
| ---------------------------------------- | ------------------ | ----------- |
| MCU + LED，`step()` 单步                 | 318–371 ns/tick    | 20–22×      |
| MCU + LED，`runBatch(2000)`              | 6.6–6.8 ns/tick    | ~960–1200×  |
| MCU + LED，连续吞吐（1M tick）           | 56–80 M tick/s     | —           |
| MCU + 8 个 `ideal-led`                   | 26.5–30.1 M tick/s | —           |
| 按钮（去抖）+ 富 LED                     | 64.7–66.9 M tick/s | —           |
| Teaching MCU，时间切片（1000 inst/tick） | ~390 M inst/s      | —           |
| Teaching ISA，长切片批处理               | 486–505 M inst/s   | ~2900–3300× |
| M3 ISA，长切片批处理                     | 583–595 M inst/s   | ~3400–3900× |
| Teaching ISA，单步                       | 4.2–4.6 M tick/s   | ~25–28×     |

调度器路径基线：MCU + LED 约 6.3–8.1 µs/tick；Teaching MCU 约 0.13–0.18 M inst/s。

## 如何运行

```sh
# 全部性能观测（不含断言，不参与 pnpm test / CI）
pnpm --filter @mica-js/simulator test:perf

# 全部基准（约 35 s）
pnpm --filter @mica-js/simulator bench

# 文档示例（LED 闪烁 / 按钮 / 教学 MCU 固件 / 吞吐）
pnpm --filter @mica-js/simulator examples
```
