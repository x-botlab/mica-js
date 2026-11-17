#!/bin/sh
# 重新生成 flash-iap.bin；需要 arm-none-eabi-gcc。
set -eu
cd "$(dirname "$0")"
arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -nostdlib -Wl,-T,flash.ld \
  -o flash-iap.elf flash-iap.s
arm-none-eabi-objcopy -O binary flash-iap.elf flash-iap.bin
rm -f flash-iap.elf
