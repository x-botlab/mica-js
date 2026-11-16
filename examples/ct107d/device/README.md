# CT107D 融合整板器件

`device/` 是 CT107D 的统一器件工程：一个 `DeviceIR`、一个实例、一个 8051 JIT，
外部只保留 `VCC`/`GND`。它把历史 54 个器件与 102 条网络折叠为内部槽，数字器件行为
从 `examples/devices` 的 DDL 生成，模拟/显示/交互行为由板级 fragment 实现。

## 构建

```bash
# 根 build 默认产出本器件；build:fused 是显式别名
pnpm --filter @mica-js/example-ct107d build
pnpm --filter @mica-js/example-ct107d build:fused
pnpm --filter @mica-js/example-ct107d check:fused
pnpm --filter @mica-js/example-ct107d typecheck:fused
```

`scripts/generate.mjs` 读取 `examples/devices/*/src/model.ddl`、`ct107d.sch` 与
`ct107d.netlist.json`，生成：

- `src/model.ddl`：单 DeviceIR；
- `src/nets.ts`：历史网络编号与 MCU 引脚槽；
- `src/channels.ts`：生成输出通道 → `designator/port` 映射。

`build:mcu` 先构建 `examples/devices/iap15f2k61s2`，并写入
`examples/devices/dist/iap15f2k61s2.source.json`（源码、实际本地依赖
`examples/devices/shared/serial.ts` 与产物内容哈希）。生成器要求 sidecar
与当前源码哈希一致，因此 MCU 源与产物身份都不依赖 mtime；`--check` 也会先编译生成的 DDL
再比较文件。`shared/drive-code.mjs` 是生成器 source-merge 与 `src/fuse.ts` 共用的电阻/驱动码合同
（1/25 Ω strong，10 kΩ/1 MΩ weak，其它值 fail-fast）。生成物已提交，`check:fused`
用于确认它与当前器件源/原理图一致。
`mica build --root device` 输出自包含的 `dist/{package.json,model.js}`；`dist/`、
`dist.release.json` 与 `.mica/` 不进版本库。

## 接口

清单只声明 `VCC`/`GND` 两个引脚，属性为 `firmware`（`code` 空间，起点 0，
`maxBytes: 61440`，`nullable: true`）、`clockFrequency`（默认 11059200）和
`ultrasonicDistanceCm`（默认 100）。`firmware` 不写入 DDL；工厂通过
`ctx.props.firmware` 接收 `FirmwareImage`，由复用的 MCU 实现验证空间与段范围后
`loadBytes`。

方法和事件均为同步接口：

- 输入：`setSwitch`、`setJumper`、`setHallField`、`setWiper`、
  `setAmplifierInputs`、`setIrCarrier`、`setTemperature`、`setAnalogInput`、
  `sendUart`；`setIrCarrier` 必须显式指定 `LD1`、`U11` 或 `U20`；
- 查询：`getSnapshot`、`getAmplifier`、`getEeprom`、`getRtc`、`readSerial`、`getSerialStatus`；
  `getSnapshot` 包含 17 键、J13/J3/J2、LD1/U11/U20、NE555、ULN2003、74HC138、
  PCF8591、温度（converted/value）、LM386 active 与 LED brightness/current/voltage
  （`leds` 仍保留亮度数组兼容）；`setAnalogInput` 以 0..1 钳位值送入并缓存；
- 事件：`onDidSignal({designator, port, value})`、`onDidBytes({designator, port, data})`、
  `onDidAmplifier({position, gain, outputVoltage})`、`onDidUart1Tx`、`onDidUart1Rx`。

业务参数错误使用 `MethodError`；`bytes` 查询和事件都返回独立 `Uint8Array` 快照。
事件 payload 的 `designator`/`port` 是板面位号与端口，不是历史实例 ID。

## 执行模型

- `src/index.ts` 从 `examples/devices/dist/iap15f2k61s2/model.js` 复用 MCU 工厂，
  不复制 kernel/peripherals。
- `src/fuse.ts` 在原始 translator 返回后把 `readSample`/`writeIntent`/`resistor`
  降为内部 `fusedPins`/`fusedMcuDrives` 槽；融合块按对象身份单独缓存，不污染
  独立 MCU 器件的 `cyclePs:pc:bytes` 缓存。MCU 资源名保持不变。
- 图内只有 32 个 MCU 引脚电平需要 materialize；数字器件和板级 glue 直接读纯
  `fusedNetN()` 函数。融合后没有板内电气网络，`solves` 为 0，外部只有
  `VCC`/`GND` 两条网。
- 数字器件按实例命名空间 source-merge；I²C、DS1302、1-Wire、UART、NE555、
  红外接收、超声波等协议状态机保留。

## 理想化边界

内部网是理想数字网：保留 strong high/low、weak high/low 与 release 驱动码，当前电阻
合同为 1 Ω/25 Ω strong、10 kΩ/1 MΩ weak，其它值 fail-fast；网络结果区分确定 low、
确定 high 与 unknown，unknown 不会被静默压成高。按键矩阵和 J13/J2/J3
只按网表连通关系生效。
LED 亮度、seg4 扫描稳定窗口、继电器/蜂鸣器、LM324 的 position/gain/outputVoltage 按
原器件公式计算；初始 wiper=0 时 gain=21，position/gain 变化即使输出仍为 0 也发事件。
固定属性取自 `ct107d.sch`。PCF8591 的 AIN2 仍由 `setAnalogInput(2, …)`
独立注入，不自动耦合 LM324 输出。它不模拟模拟竞争、驱动强度、任意外部
接线或完整电气网络。

正确性由 `test/fused-preview.test.ts`（0→4096 ms 预览轨迹对离散 oracle）、
`test/fused-firmware.test.ts`（仓库内自制 8051 fixtures）与 `bench/`（正式 dist、
单实例/单 JIT、fallbackRate（PC 集合不可用时明确 null）与真实工作量断言）覆盖。
