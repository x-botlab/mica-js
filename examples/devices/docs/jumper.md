# 两脚跳线

CT107D 板位号 **J13**（WR/IO 模式选择）：把 `P42/WR` 短接到 GND。同型号也用于 J3 与
JS1/JS2 等其余两脚跳线。

## 元数据

| 项       | 值                                                    |
| -------- | ----------------------------------------------------- |
| 器件 id  | `jumper`                                              |
| 文件     | `src/devices/jumper/{model.ddl,index.ts,device.json}` |
| 位号前缀 | `J`                                                   |
| 引脚数   | 2                                                     |

## 引脚

| 引脚 | 说明                    |
| ---- | ----------------------- |
| `a`  | 一端（J13 接 `P42/WR`） |
| `b`  | 另一端（J13 接 GND）    |

## 行为

```
a ↔ b ：closed 为 true 时 resistance（默认 0.05 Ω），false 时 openResistance（默认 1 GΩ）
```

用有限电阻而不是真正断开，保证另一端仍被网络引用，电气求解不会出现孤立支路。

`closed` 属性给出装配初值；运行期可向 `control` 输入发送新状态，当前状态通过 `closedState`
输出回传。通用交互式 `jumper` widget 支持 1–2 路，J13 使用单路 `state1`/`closed1`，J2
复用同一个 widget 并绑定第二路 `state2`/`closed2`。

## 端口

| 端口          | 方向   | 类型    | 说明                         |
| ------------- | ------ | ------- | ---------------------------- |
| `control`     | input  | boolean | 运行期切换是否闭合           |
| `closedState` | output | boolean | 当前闭合状态，供 widget 订阅 |

## 属性

| 属性             | 类型    | 默认 | 说明                  |
| ---------------- | ------- | ---- | --------------------- |
| `closed`         | boolean | true | 是否插上跳线帽        |
| `resistance`     | number  | 0.05 | 短接时的导通电阻（Ω） |
| `openResistance` | number  | 1e9  | 拔掉时的绝缘电阻（Ω） |

## 理想化

- 切换立即生效，不模拟插拔过程、机械抖动、接触电阻漂移与氧化。
- 不检查同一网络插多个跳线帽的冲突。

## 测试

`test/ct107d/jumper.test.ts`：默认插帽时两端导通、`closed: false` 时断开，以及运行期通过
`control` 反复切换并在 `state` 话题回传状态。
