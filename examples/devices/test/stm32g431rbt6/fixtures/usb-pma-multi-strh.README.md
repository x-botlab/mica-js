# PMA 多 STRH 最小复现

## 复现

```sh
./usb-pma-multi-strh-build.sh
```

固件 `usb-pma-multi-strh.c` 在 reset 中：

1. 写 SRAM `0x20005000 = 0x31415926`，证明 CPU 已进入 reset；
2. 用编译后的 C 循环 `pmaWrite(0x40, descriptor, 8)` 把 8 字节写入 PMA 0x40；
3. 自旋。

预期 PMA 字节（`usb` memory 0x140..0x147）：

```text
12 34 56 78 9a bc de f0
```

完成后固件还写 PMA 0x1F8 = 0x5a，作为 helper 完成的回归标记。

## 实测

修复前（CPU V flags 修复前）通过临时 USB rig + 真实 JIT 运行 2 µs（临时 harness 已删除）：

```text
marker 31415926
pma    [0, 0, 0, 0, 0, 0, 0, 0]
completion (0x1F8) = 0x00（旧失败）
```

即 reset 已执行，但 4 个 STRH 的 PMA 写入全部没有落盘。

## 关键 objdump

`usb-pma-multi-strh.objdump.txt` 中 `pmaWrite` 的地址/宽度：

```text
8000058: 89fb       ldrh  r3, [r7, #14]      ; index
800005a: 085b       lsrs  r3, r3, #1         ; index >> 1
800005c: b29b       uxth  r3, r3
800005e: 005b       lsls  r3, r3, #1         ; (index >> 1) * 2
8000060: 68ba       ldr   r2, [r7, #8]       ; pma base = 0x40006040
8000062: 4413       add   r3, r2             ; byte address
8000064: 89ba       ldrh  r2, [r7, #12]      ; packed halfword
8000066: 801a       strh  r2, [r3, #0]       ; halfword store
```

地址计算本身是 `base + (index & ~1)`，打包是 `data[index] | data[index+1] << 8`，符合 PMA 的 16 位半字布局。

## CPU 修复后 experimental 回归

CPU 已修 `ir.ts` 的减法 V flags。撤出生产前，experimental `circuit` 检查曾通过
（对应 USB 正向 test 已从生产 suite 移除）：

- `usbReadPma({ offset: 0x40, length: 8 })` = `12 34 56 78 9a bc de f0`；
- `usbReadPma({ offset: 0x1F8, length: 1 })` = `5a`。

注意 `usbReadPma` 的参数是 **PMA offset**，不是 `usb` memory 的绝对偏移；PMA 0x40
对应 `usb` memory 0x140。旧生产测试误用 0x140 读取，导致误报零。

## 构建说明

本 fixture 保留原始 `-O0` 构建。若改用 `-O2`，GCC 会把该循环改成后自增装载
（`ldrb r2, [r1], #2`）；当前 CPU/JIT 在该变体上复现首半字重复（PMA 0x40 起为
`12 34 12 34 ...`），需 CPU owner 单独定位。该 `-O2` 变体不作为本 USB 回归通过项，
也不能用于判断 USB PMA 宽度。

## 对照

- `USB_MODULE` 的 `writeUsb(..., size=2)` / `readUsb(..., size=2)` 单测通过。
- 另一最小固件对 `0x40006040` 直接常量 `strh 0x0112`，host 读到 `12 01`。
- 因此单条 `strh` 的 width 与 USB 模块的 halfword 处理都正确。修复前多 STRH 失败
  由 CPU `ir.ts` 减法 V flags 引起；CPU 修复后该 experimental 检查通过。USB 已移出
  生产交付，不应再把它归因于 USB width，也不作为生产支持项。
