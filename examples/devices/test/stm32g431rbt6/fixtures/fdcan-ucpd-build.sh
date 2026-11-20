#!/bin/sh
# 开发期工具：生成 FDCAN/UCPD 固件夹具。运行期测试只读取 .bin。
set -eu
cd "$(dirname "$0")"
for name in fdcan-loopback fdcan-reset ucpd-poll ucpd-irq ucpd-reset; do
  arm-none-eabi-as -mcpu=cortex-m4 -mthumb "$name.s" -o "/tmp/$name.o"
  arm-none-eabi-ld -T flash.ld -o "/tmp/$name.elf" "/tmp/$name.o"
  arm-none-eabi-objcopy -O binary "/tmp/$name.elf" "$name.bin"
done
