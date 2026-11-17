#!/bin/sh
# 开发期工具：用 GNU arm-none-eabi 工具链生成 USART 测试固件。运行期测试只读 .bin。
set -eu
cd "$(dirname "$0")"
for name in usart-rx-echo usart-rx-echo-lowbaud usart-rx-echo-highbaud usart-rx-irq usart-rx-idle usart-rx-error usart-rx-overrun usart-loopback usart-rx-disable usart-tx-wave usart-regs usart-rqr usart-rx-dual; do
  arm-none-eabi-as -mcpu=cortex-m4 -mthumb "$name.S" -o "/tmp/$name.o"
  arm-none-eabi-ld -T usart-link.ld -o "/tmp/$name.elf" "/tmp/$name.o"
  arm-none-eabi-objcopy -O binary "/tmp/$name.elf" "$name.bin"
done
