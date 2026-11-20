#!/bin/sh
# 生成真实 IWDG/WWDG 超时 + RCC_CSR flag 固件；运行期只读 .bin。
set -eu
cd "$(dirname "$0")"
arm-none-eabi-as -mcpu=cortex-m4 -mthumb rcc-watchdog-csr.S -o /tmp/rcc-iwdg-csr.o
arm-none-eabi-ld -T usart-link.ld -o /tmp/rcc-iwdg-csr.elf /tmp/rcc-iwdg-csr.o
arm-none-eabi-objcopy -O binary /tmp/rcc-iwdg-csr.elf rcc-iwdg-csr.bin
arm-none-eabi-as -mcpu=cortex-m4 -mthumb --defsym WWDG=1 rcc-watchdog-csr.S -o /tmp/rcc-wwdg-csr.o
arm-none-eabi-ld -T usart-link.ld -o /tmp/rcc-wwdg-csr.elf /tmp/rcc-wwdg-csr.o
arm-none-eabi-objcopy -O binary /tmp/rcc-wwdg-csr.elf rcc-wwdg-csr.bin
